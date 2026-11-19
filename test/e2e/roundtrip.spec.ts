import { expect, test } from '@playwright/test';
import type { Page, Worker } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runWait } from '../../bridge/src/commands.ts';
import type { CommandDeps } from '../../bridge/src/commands.ts';
import { present, startBeacon } from '../../bridge/src/presence.ts';
import { BRIDGE_KEY, STATE_FORMAT, writeBridgeRecord } from '../../bridge/src/record.ts';
import { startBridge } from '../../bridge/src/server.ts';
import type { RunningBridge } from '../../bridge/src/server.ts';
import { BRIDGE_PORT_E2E } from '../../shared/types.ts';
import { VERSION } from '../../shared/version.ts';
import { activate, annotate, comeBack, commandDeps, launch, part, register } from './helpers.ts';
import type { Session } from './helpers.ts';

// The whole chain as one story, in order: the test build of the extension calls a real bridge on
// the test port, which keeps its state in a temporary folder, and the agent is the real commands:
// it registers, and its wait prints the line of each send it picks up. No stand-in takes the
// bridge's place, so this also proves that a refused connection reads as a bridge that is not
// running, that the browser sends the extension's origin, and that the bridge accepts it. Each
// test goes on from where the one before it ended.
test.describe.configure({ mode: 'serial' });

const BRIDGE_DOWN = 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works, without screenshots.';
const NO_AGENTS = 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works.';
const SENTENCE = 'Wait for my annotations with the clicknote skill.';
const NO_AGENT_OPTION = 'No agent listening';
const SENT = 'Sent 1 annotation to site · landing page copy · claude-code.';
const PICKED_UP = `${SENT} The agent picked it up.`;
const QUEUED = `${SENT} Queued: the agent gets it when it next waits.`;
const LINE_START = /^Browser annotations \(1\) on /;
// A change of the status that comes from following the send, which asks every two seconds.
const FOLLOWED = { timeout: 10_000 };

let saved: string | undefined;   // CLICKNOTE_STATE_DIR before this file set it
let dir: string;
const notes: string[] = [];      // what the commands wrote on the error stream
let deps: CommandDeps;
let agent: string;               // the id of the agent that registered
// Ends every wait the story started that is still open, also when a step failed.
const waits = new AbortController();
const running: Promise<number>[] = [];
let bridge: RunningBridge | undefined;
let session: Session | undefined;
let page: Page;
let sw: Worker;

test.beforeAll(async () => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-roundtrip-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
  deps = commandDeps([], notes);
  session = await launch();
  ({ page, sw } = session);
});

// The waits have ended before anything else is closed. The bridge is closed even when closing
// the browser fails. Only then is the variable of the state folder put back and the temporary
// folder removed, also when closing the browser or the bridge fails, so a bridge that closes
// writes into the temporary folder to the end.
test.afterAll(async () => {
  waits.abort();
  await Promise.allSettled(running);
  try {
    await session?.close();
  } finally {
    try {
      await bridge?.close();
    } finally {
      if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
      else process.env.CLICKNOTE_STATE_DIR = saved;
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
});

// The agent runs its wait command, with a new description when `about` is given. Gives what the
// wait will give, which it is not awaited for, and the lines it writes.
function startWait(about?: string): { waiting: Promise<number>; lines: string[] } {
  const lines: string[] = [];
  const waiting = runWait(about === undefined ? { agent } : { agent, about }, {
    ...deps, write: async line => { lines.push(line); }, signal: waits.signal, pollMs: 50,
  });
  running.push(waiting);
  return { waiting, lines };
}

// The user opens the dropdown: it lists the agents anew each time it gets the focus.
async function useDropdown(): Promise<void> {
  await part(page, 'agent-select').blur();
  await part(page, 'agent-select').focus();
}

const options = () => part(page, 'agent-select').locator('option');

// The one annotation of the first send is made at the start, so Send is off for want of an agent
// until the agent is listed.
test('the round trip: from no agent to a queued send that is picked up', async () => {
  await test.step('with no bridge on the test port, the bar says that no agent is listening', async () => {
    await activate(sw, page);
    await annotate(page, '#cta', 'Make the button green.');
    await expect(part(page, 'status')).toHaveText(BRIDGE_DOWN);
    await expect(part(page, 'offer')).toHaveText(SENTENCE);
    await expect(options()).toHaveText([NO_AGENT_OPTION]);
    await expect(part(page, 'send')).toBeDisabled();
  });

  // The user starts the bridge in another window and comes back to the page: the browser takes
  // the focus from the page's window and gives it back, and the bar lists the agents again. A page
  // here stays visible whichever page is in front, so the window's focus is what this test can
  // show; the bar also lists them again when a page becomes visible.
  await test.step('no agent is listed: the bar offers the sentence to say, and Send is off', async () => {
    bridge = await startBridge({ port: BRIDGE_PORT_E2E });
    await comeBack(session!.context, page);
    await expect(part(page, 'status')).toHaveText(NO_AGENTS);
    await expect(part(page, 'offer')).toHaveText(SENTENCE);
    await expect(options()).toHaveText([NO_AGENT_OPTION]);
    await expect(part(page, 'send')).toBeDisabled();
  });

  // The wait writes its beacon as soon as it has made sure of the bridge, which its deps do at
  // once; the dropdown gets the focus only after a round trip to the browser, so the bridge lists
  // the agent as waiting.
  let first: { waiting: Promise<number>; lines: string[] };
  await test.step('an agent registers from /x/site and waits: the dropdown lists it as waiting and chooses it', async () => {
    agent = await register(deps, 'claude-code', 'landing page copy');
    first = startWait();
    await useDropdown();
    await expect(options()).toHaveText(['● site · landing page copy · claude-code · waiting']);
    await expect(part(page, 'agent-select')).toHaveValue(agent);
    await expect(part(page, 'send')).toBeEnabled();
    await expect(part(page, 'status')).toBeHidden();
    await expect(part(page, 'status-offer')).toBeHidden();
  });

  await test.step('Send goes to the agent that waits, and the bar says that it picked it up', async () => {
    await part(page, 'send').click();
    await expect(part(page, 'status')).toHaveText(PICKED_UP, FOLLOWED);
    await expect(part(page, 'list-item')).toHaveCount(0);
    expect(await first.waiting).toBe(0);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toMatch(LINE_START);
    expect(first.lines[0]).toContain(` on ${page.url()}: read `);
    const file = first.lines[0].match(/read (.*annotations\.md),/)![1];
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('Make the button green.');
    expect(existsSync(join(dirname(file), '1.png'))).toBe(true);
    expect(notes).toEqual([]);
  });

  let queued = '';
  await test.step('with no wait open, a send is queued and its line is on offer', async () => {
    await useDropdown();
    await expect(options()).toHaveText(['○ site · landing page copy · claude-code']);
    await annotate(page, '#cta', 'And a little larger.');
    await part(page, 'send').click();
    await expect(part(page, 'status')).toHaveText(QUEUED);
    await expect(part(page, 'offer')).toHaveText(LINE_START);
    await expect(part(page, 'list-item')).toHaveCount(0);
    queued = (await part(page, 'offer').textContent())!;
  });

  // Nothing here touches the bar until it has said that the send was picked up. The status keeps
  // the label the agent had when the send was made; the dropdown shows its new description. The
  // wait ends only when it gets a send, so a wait that does not get the queued one runs into the
  // test's timeout.
  await test.step('the next wait gets the queued send at once, and the bar says so without a click', async () => {
    const second = startWait('footer links');
    expect(await second.waiting).toBe(0);
    expect(second.lines).toEqual([queued]);
    await expect(part(page, 'status')).toHaveText(PICKED_UP, FOLLOWED);
    await expect(part(page, 'status-offer')).toBeHidden();
    await useDropdown();
    await expect(options()).toHaveText(['○ site · footer links · claude-code']);
    await expect(part(page, 'status')).toHaveText(PICKED_UP);
    expect(notes).toEqual([]);
  });
});

// The command itself, as a process of its own, as an agent runs it.
const CLI = join(import.meta.dirname, '../../bridge/src/cli.ts');

// How long the wait may run before the test ends it with SIGKILL: well within the test's own 30
// seconds, so a wait that a signal does not end fails the test and is gone with it.
const WAIT_LIMIT_MS = 10_000;

// The wait runs as the command does for an agent, in a process of its own, and the test ends it
// with SIGTERM, as a plain kill does. A command makes sure a bridge runs, and would start one on
// the user's port 47823 when none ran for its state folder; the record and the beacon of the
// test's bridge make it find that one and start none. The wait is ended at the end, also when a
// step failed, and the beacon stopped, also when the wait could not be started.
test('an agent whose wait is stopped leaves the bar', async () => {
  let beacon: { stop(): void } | undefined;
  let wait: ChildProcess | undefined;
  let exited = false;
  let ended: Promise<number | null> = Promise.resolve(null);
  let timer: NodeJS.Timeout | undefined;
  try {
    writeBridgeRecord({ pid: process.pid, version: VERSION, format: STATE_FORMAT, port: BRIDGE_PORT_E2E, auto: false });
    beacon = startBeacon('bridge', BRIDGE_KEY);
    const started = spawn(process.execPath, [CLI, 'wait', agent, '--about', 'landing page copy'],
      { env: { ...process.env, CLICKNOTE_STATE_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    wait = started;
    ended = new Promise(done => started.on('close', code => {
      exited = true;
      done(code);
    }));
    timer = setTimeout(() => {
      if (!exited) started.kill('SIGKILL');
    }, WAIT_LIMIT_MS);
    let errors = '';
    started.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });

    await test.step('the agent waits: the dropdown lists it as waiting', async () => {
      await expect.poll(() => exited || present('wait', agent)).toBe(true);
      expect(exited, errors).toBe(false);
      await useDropdown();
      await expect(options()).toHaveText(['● site · landing page copy · claude-code · waiting']);
    });

    await test.step('its wait is ended with SIGTERM: the bar says that no agent is listening, and offers the sentence', async () => {
      started.kill('SIGTERM');
      expect(await ended).toBe(1);
      expect(errors).toBe('Stopped waiting. You are off the list in the bar until you wait again.\n');
      await useDropdown();
      await expect(part(page, 'status')).toHaveText(NO_AGENTS);
      await expect(part(page, 'offer')).toHaveText(SENTENCE);
      await expect(options()).toHaveText([NO_AGENT_OPTION]);
    });
  } finally {
    clearTimeout(timer);
    if (wait && !exited) wait.kill('SIGKILL');
    await ended;
    beacon?.stop();
  }
});
