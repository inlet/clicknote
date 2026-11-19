import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type CommandDeps, runOpen, runRegister, runStop, runWait, type WaitDeps } from '../../bridge/src/commands.ts';
import { claim, enqueue, sendState } from '../../bridge/src/inbox.ts';
import { isOpenAddress } from '../../bridge/src/opener.ts';
import { startBeacon } from '../../bridge/src/presence.ts';
import {
  BRIDGE_KEY, STATE_FORMAT, stopRequested, writeBridgeRecord, type BridgeRecord, type BridgeSeen,
} from '../../bridge/src/record.ts';
import { leaveAgent, listAgents, readAgent, registerAgent, seenAgent } from '../../bridge/src/registry.ts';
import { startBridge, type RunningBridge } from '../../bridge/src/server.ts';
import { EXTENSION_ID } from '../../shared/extension-id.ts';
import { PROTOCOL } from '../../shared/types.ts';
import type { Annotation, SendPayload } from '../../shared/types.ts';
import { VERSION } from '../../shared/version.ts';

let dir = '';
let saved: string | undefined;
let bridge: RunningBridge;
let running: { state: 'running'; record: BridgeRecord };
let out: string[] = [];          // what the command wrote on standard output
let notes: string[] = [];        // what the command wrote on the error stream
let opened: string[] = [];       // the addresses the command opened

beforeEach(async () => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
  bridge = await startBridge({ port: 0 });
  running = { state: 'running', record: { pid: 1, version: VERSION, format: STATE_FORMAT, port: bridge.port, auto: true } };
  out = [];
  notes = [];
  opened = [];
});
afterEach(async () => {
  await bridge.close();
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const EXT = `chrome-extension://${EXTENSION_ID}`;

function annotation(fields: Partial<Annotation>): Annotation {
  return {
    id: 'a1b2c3d4',
    number: 1,
    intent: 'change',
    comment: 'Make the button green.',
    label: 'button "Get started" 120x40',
    selector: '#cta',
    domPath: 'body > main > section#hero > button#cta',
    text: 'Get started',
    html: '<button id="cta">Get started</button>',
    rect: { x: 100, y: 200, width: 120, height: 40 },
    styles: { 'font-size': '16px' },
    screenshot: null,
    ...fields,
  };
}

// A send of two annotations from a page on a local dev server.
function payload(): SendPayload {
  return {
    page: {
      url: 'http://localhost:5173/',
      title: 'Home',
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 2,
      sourceFile: null,
    },
    note: 'Make it calmer.',
    annotations: [
      annotation({}),
      annotation({ id: 'e5f6a7b8', number: 2, intent: 'question', comment: 'Why is this grey?' }),
    ],
    images: {},
  };
}

// Posts { protocol, version, body } as JSON to the test's bridge, in its own protocol, as the
// extension does, and gives the envelope of its answer.
function ask(body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: bridge.port, method: 'POST', path: '/bridge',
      headers: { 'content-type': 'application/json', origin: EXT } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ protocol: PROTOCOL, version: 'test', body }));
  });
}

// What a command is run with: a running bridge on the test's port, an opener that records the
// address and starts, and both streams into the test's arrays.
function deps(): CommandDeps {
  return {
    cwd: '/Users/you/code/my-site',
    port: bridge.port,
    ensure: async () => running,
    open: address => {
      opened.push(address);
      return true;
    },
    out: line => { out.push(line); },
    note: line => { notes.push(line); },
  };
}

// What a wait is run with: deps() with a signal that never fires, a look every 50 ms, and the
// lines of its sends written into `out` at once.
function waitDeps(): WaitDeps {
  return { ...deps(), signal: new AbortController().signal, pollMs: 50, write: async line => { out.push(line); } };
}

// Registers an agent with the command, and gives its id; what the command printed is cleared.
async function registered(): Promise<string> {
  out.length = 0;
  await runRegister({ harness: 'claude-code', about: 'landing page copy' }, deps());
  const id = out[0].slice('agent: '.length);
  out.length = 0;
  return id;
}

// Resolves once the check holds, looking every 20 ms; rejects when it does not within 5 seconds.
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('The check did not hold within 5 seconds.');
    await sleep(20);
  }
}

test('register prints the id and the label, and the bar lists the agent', async () => {
  assert.equal(await runRegister({ harness: 'claude-code', about: 'landing page copy' }, deps()), 0);
  assert.match(out[0], /^agent: [0-9a-f]{12}$/);
  assert.deepEqual(out.slice(1), ['listed as: my-site · landing page copy · claude-code']);
  const reply = await ask({ type: 'agents', url: 'http://localhost:5173/' });
  assert.deepEqual(reply.body.agents, [{ id: out[0].slice(7), folder: 'my-site', about: 'landing page copy',
    harness: 'claude-code', number: null, waiting: false }]);
});

test('a later agent that reads the same is listed with its number', async () => {
  registerAgent({ harness: 'claude-code', about: 'landing page copy', folder: '/x/my-site' },
    Date.now() - 1_000);
  await runRegister({ harness: 'claude-code', about: 'landing page copy' }, deps());
  assert.deepEqual(out.slice(1), ['listed as: my-site · landing page copy · claude-code · 2']);
});

test('open registers, links the page and opens the open address', async () => {
  assert.equal(await runOpen({ url: 'http://localhost:5173/', harness: 'codex', about: 'checkout form', addressOnly: false }, deps()), 0);
  assert.equal(opened.length, 1);
  assert.equal(isOpenAddress(opened[0].replace(`:${bridge.port}/`, ':47823/')), true);
  assert.deepEqual(out.slice(1), ['listed as: my-site · checkout form · codex', 'opened: http://localhost:5173/']);
  const page = await fetch(opened[0]);
  assert.equal(page.status, 200);
  const code = opened[0].split('/').at(-1);
  assert.deepEqual((await ask({ type: 'opened', code })).body, { ok: true, url: 'http://localhost:5173/', agent: out[0].slice(7) });
});

test('open without a harness registers an agent without one', async () => {
  assert.equal(await runOpen({ url: 'http://localhost:5173/', addressOnly: true }, deps()), 0);
  assert.equal(out[1], 'listed as: my-site');
  assert.deepEqual(notes, []);
});

test('with the address only, open prints the open address and starts no browser', async () => {
  await runOpen({ url: 'file:///Users/you/site/index.html', harness: 'codex', about: '', addressOnly: true }, deps());
  assert.equal(opened.length, 0);
  assert.match(out[2], /^open this address: http:\/\/127\.0\.0\.1:\d+\/open\/[0-9a-f]{32}$/);
});

test('open for a known agent links to that agent and makes no new one', async () => {
  await runRegister({ harness: 'claude-code', about: 'a' }, deps());
  const id = out[0].slice(7);
  out.length = 0;
  await runOpen({ url: 'http://localhost:5173/', agent: id, about: 'b', addressOnly: true }, deps());
  assert.deepEqual(out.slice(0, 2), [`agent: ${id}`, 'listed as: my-site · b · claude-code']);
  assert.equal((await ask({ type: 'agents', url: 'x' })).body.agents.length, 1);
});

test('an unknown agent and a URL that cannot be linked are refused with 1, and nothing is opened', async () => {
  assert.equal(await runOpen({ url: 'http://localhost:5173/', agent: '000000000000', addressOnly: false }, deps()), 1);
  let ensured = 0;
  const counted = { ...deps(), ensure: async () => { ensured++; return running; } };
  assert.equal(await runOpen({ url: 'localhost:5173', harness: 'x', about: '', addressOnly: false }, counted), 1);
  assert.deepEqual(notes, ['Unknown agent 000000000000. Register again.',
    'Cannot open "localhost:5173": give the full URL, starting with http://, https:// or file://, with a space written as %20.']);
  assert.deepEqual([out, opened], [[], []]);
  assert.equal(ensured, 0);
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual((await ask({ type: 'agents', url: 'x' })).body.agents, []);
});

test('when no bridge runs, open prints the page for the agent to open and says why', async () => {
  for (const [seen, reason] of [
    [{ state: 'down', problem: 'port_in_use' }, 'port 47823 is held by another program, so Clicknote cannot start.'],
    [{ state: 'down', problem: null }, 'Clicknote did not start.'],
    [{ state: 'other', record: running.record }, 'the running Clicknote is another version than this command. Run stop, then run this again.'],
  ] as const) {
    out.length = 0; notes.length = 0;
    assert.equal(await runOpen({ url: 'http://localhost:5173/', harness: 'x', about: '', addressOnly: false },
      { ...deps(), ensure: async () => seen as BridgeSeen }), 0);
    assert.equal(out.at(-1), 'open this address: http://localhost:5173/');
    assert.deepEqual(notes, [`Not linked: ${reason}`]);
  }
  assert.equal(opened.length, 0);
});

const UNWRITABLE = {
  skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs a folder its own user cannot write',
};

// Registering a new agent fails in a state folder that cannot be written; renewing a known one in
// an agents' folder that cannot be written.
test('in a state folder that cannot be written, open still gives the page, with why it was not linked', UNWRITABLE, async () => {
  chmodSync(dir, 0o500);
  try {
    assert.equal(await runOpen({ url: 'http://localhost:5173/', harness: 'x', about: '', addressOnly: false }, deps()), 0);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual(out, ['open this address: http://localhost:5173/']);
  assert.match(notes[0], /^Not linked: EACCES: permission denied/);
  const id = await registered();
  chmodSync(join(dir, 'agents'), 0o500);
  try {
    assert.equal(await runOpen({ url: 'http://localhost:5173/', agent: id, addressOnly: false }, deps()), 0);
  } finally {
    chmodSync(join(dir, 'agents'), 0o700);
  }
  assert.deepEqual(out, ['open this address: http://localhost:5173/']);
  assert.equal(notes.length, 2);
  assert.match(notes[1], /^Not linked: EACCES: permission denied/);
  assert.deepEqual(opened, []);
});

test('when making sure of the bridge fails, open still gives the page, with why it was not linked', async () => {
  const failing = { ...deps(), ensure: () => Promise.reject(new Error('spawn EACCES')) };
  assert.equal(await runOpen({ url: 'http://localhost:5173/', harness: 'x', about: '', addressOnly: false }, failing), 0);
  assert.deepEqual([out, notes], [['open this address: http://localhost:5173/'], ['Not linked: spawn EACCES']]);
  assert.deepEqual(readdirSync(dir), []);
});

test('an agent that is not known gives 1, also when making sure of the bridge fails', async () => {
  const failing = { ...deps(), ensure: () => Promise.reject(new Error('spawn EACCES')) };
  assert.equal(await runOpen({ url: 'http://localhost:5173/', agent: '000000000000', addressOnly: false }, failing), 1);
  assert.deepEqual([out, notes], [[], ['Unknown agent 000000000000. Register again.']]);
});

test('a link that cannot be written leaves the page for the agent to open, with why', async () => {
  const id = await registered();
  writeFileSync(join(dir, 'links'), '');
  assert.equal(await runOpen({ url: 'http://localhost:5173/', agent: id, addressOnly: false }, deps()), 0);
  assert.deepEqual(out, [`agent: ${id}`, 'listed as: my-site · landing page copy · claude-code',
    'open this address: http://localhost:5173/']);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^Not linked: E[A-Z]+: /);
  assert.deepEqual(opened, []);
});

test('a browser that cannot be started leaves the open address for the agent', async () => {
  await runOpen({ url: 'http://localhost:5173/', harness: 'x', about: '', addressOnly: false }, { ...deps(), open: () => false });
  assert.match(out.at(-1) ?? '', /^open this address: http:\/\/127\.0\.0\.1:\d+\/open\/[0-9a-f]{32}$/);
  assert.deepEqual(notes, ['Clicknote could not start the browser.']);
});

test('wait gets a send that was queued before it started, and then nothing more', async () => {
  const id = await registered();
  const sent = await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  assert.equal(await runWait({ agent: id }, waitDeps()), 0);
  assert.deepEqual(out, [sent.body.line]);
  out.length = 0;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 200);
  assert.equal(await runWait({ agent: id }, { ...waitDeps(), signal: stop.signal }), 1);
  assert.deepEqual(out, []);
});

test('wait gets a send that arrives while it waits, and the agent is listed as waiting meanwhile', async () => {
  const id = await registered();
  const waiting = runWait({ agent: id }, waitDeps());
  await until(async () => (await ask({ type: 'agents', url: 'x' })).body.agents[0].waiting === true);
  const sent = await ask({ type: 'send', id: '00000000000000a2', agent: id, send: payload() });
  assert.equal(await waiting, 0);
  assert.deepEqual(out, [sent.body.line]);
  assert.equal((await ask({ type: 'agents', url: 'x' })).body.agents[0].waiting, false);
});

test('once a wait is open the agent\'s inbox folder is there', async () => {
  const id = await registered();
  const stop = new AbortController();
  const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal });
  try {
    const folder = statSync(join(dir, 'inbox', id), { throwIfNoEntry: false });
    assert.equal(folder?.isDirectory(), true);
    if (process.platform !== 'win32') assert.equal(folder!.mode & 0o777, 0o700);
  } finally {
    stop.abort();
    await wait;
  }
});

// The wait looks for a send only once a minute, so a send that it gets within a few seconds came
// through the watch of the agent's folder.
test('a send that comes after the wait opened is handed out without the wait\'s look', async () => {
  const id = await registered();
  const stop = new AbortController();
  const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal, pollMs: 60_000 });
  const sent = await ask({ type: 'send', id: '00000000000000a3', agent: id, send: payload() });
  const timer = setTimeout(() => stop.abort(), 3_000);
  try {
    assert.equal(await wait, 0, 'the wait did not get the send within 3 seconds');
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
  assert.deepEqual(out, [sent.body.line]);
});

test('two sends come as two lines, oldest first', async () => {
  const id = await registered();
  const first = await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  const second = await ask({ type: 'send', id: '00000000000000a2', agent: id, send: payload() });
  await runWait({ agent: id }, waitDeps());
  assert.deepEqual(out, [first.body.line, second.body.line]);
});

test('a wait that cannot write its lines leaves the send for the next wait', async () => {
  const id = await registered();
  const sent = await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  await assert.rejects(runWait({ agent: id }, { ...waitDeps(), write: async () => { throw new Error('EPIPE'); } }));
  assert.equal(await runWait({ agent: id }, waitDeps()), 0);
  assert.deepEqual(out, [sent.body.line]);
});

test('a line that fails to be written gives every send of the wait back, and none is confirmed', async () => {
  const id = await registered();
  await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  await ask({ type: 'send', id: '00000000000000a2', agent: id, send: payload() });
  let written = 0;
  const failing = async () => {
    if (++written === 2) throw new Error('write EPIPE');
  };
  await assert.rejects(runWait({ agent: id }, { ...waitDeps(), write: failing }), { message: 'write EPIPE' });
  assert.deepEqual([sendState('00000000000000a1'), sendState('00000000000000a2')], ['queued', 'queued']);
  assert.deepEqual(claim(id).map(queued => queued.send), ['00000000000000a1', '00000000000000a2']);
});

// A line written on the program's standard output holds a listener on it until it is written, and
// a stream warns when more than ten are added.
test('the lines of a wait are written one after another', async () => {
  const id = await registered();
  for (let n = 1; n <= 12; n++) {
    await ask({ type: 'send', id: `00000000000000${n.toString(16).padStart(2, '0')}`, agent: id, send: payload() });
  }
  let writing = 0;
  let most = 0;
  const counted = async (line: string) => {
    most = Math.max(most, ++writing);
    await sleep(1);
    out.push(line);
    writing--;
  };
  assert.equal(await runWait({ agent: id }, { ...waitDeps(), write: counted }), 0);
  assert.deepEqual([out.length, most], [12, 1]);
});

test('a line that is written late is waited for, and the send is confirmed only after it', async () => {
  const id = await registered();
  await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  let written = () => {};
  let asked = false;
  const late = (line: string) => new Promise<void>(done => {
    asked = true;
    written = () => {
      out.push(line);
      done();
    };
  });
  const wait = runWait({ agent: id }, { ...waitDeps(), write: late });
  await until(() => asked);
  await sleep(50);
  assert.equal(sendState('00000000000000a1'), 'queued');
  written();
  assert.equal(await wait, 0);
  assert.equal(sendState('00000000000000a1'), 'picked_up');
  assert.equal(out.length, 1);
});

// The confirmation reads the time once, after the lines are written; a time that is not a number
// makes it throw before it moves a send, while giving the sends back reads no time.
test('a wait whose sends cannot be confirmed gives them back at once for the next wait', async t => {
  const id = await registered();
  const sent = await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  const now = t.mock.method(Date, 'now');
  await assert.rejects(runWait({ agent: id }, { ...waitDeps(), write: async () => { now.mock.mockImplementationOnce(() => NaN); } }),
    { name: 'TypeError', message: 'Not a time: NaN' });
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 1_000);
  try {
    assert.equal(await runWait({ agent: id }, { ...waitDeps(), signal: stop.signal }), 0);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(out, [sent.body.line]);
});

// A claim that finds the agent's lock held gives nothing after a second, and the lock is taken
// over only once it is five seconds old.
test('a wait that cannot claim while another holds the lock still ends on its signal', async () => {
  const id = await registered();
  await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  const lock = join(dir, 'inbox', id, 'claim.lock');
  writeFileSync(lock, '');
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 100);
  const start = performance.now();
  try {
    assert.equal(await runWait({ agent: id }, { ...waitDeps(), signal: stop.signal }), 1);
  } finally {
    clearTimeout(timer);
  }
  const waited = performance.now() - start;
  assert.ok(waited < 2_500, `waited ${waited} ms`);
  assert.deepEqual(out, []);
  rmSync(lock);
  assert.deepEqual(claim(id).map(queued => queued.send), ['00000000000000a1']);
});

test('wait with a new description changes how the agent is listed', async () => {
  const id = await registered();
  const stop = new AbortController();
  const waiting = runWait({ agent: id, about: 'checkout form' }, { ...waitDeps(), signal: stop.signal });
  await until(async () => (await ask({ type: 'agents', url: 'x' })).body.agents[0].about === 'checkout form');
  stop.abort();
  await waiting;
});

const TWO_HOURS = 2 * 3_600_000;

// Starts a wait for the agent and resolves, with the wait, once the bar lists the agent as
// waiting.
async function waitingFor(id: string, deps: WaitDeps): Promise<{ wait: Promise<number> }> {
  const wait = runWait({ agent: id }, deps);
  await until(() => listAgents().some(agent => agent.id === id && agent.waiting));
  return { wait };
}

test('a wait that ends with a send is a sign of life, so an agent that waited long stays listed', async () => {
  const id = await registered();
  const { wait } = await waitingFor(id, waitDeps());
  seenAgent(id, undefined, Date.now() - TWO_HOURS);
  const before = Date.now();
  await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  assert.equal(await wait, 0);
  assert.equal((readAgent(id)?.seen ?? 0) >= before, true);
  assert.deepEqual(listAgents().map(agent => agent.id), [id]);
});

test('each time a wait says that it still waits, it is a sign of life', async () => {
  const id = await registered();
  const stop = new AbortController();
  const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal, noteMs: 20 });
  const old = Date.now() - TWO_HOURS;
  seenAgent(id, undefined, old);
  try {
    await until(() => (readAgent(id)?.seen ?? old) > old);
  } finally {
    stop.abort();
    await wait;
  }
});

const STOPPED = 'Stopped waiting. You are off the list in the bar until you wait again.';

test('a wait that the signal ends takes its agent off the list', async () => {
  const id = await registered();
  const old = Date.now() - TWO_HOURS;
  seenAgent(id, undefined, old);
  const stop = new AbortController();
  const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal });
  const started = readAgent(id)?.seen ?? old;
  assert.equal(started > old, true);
  stop.abort();
  assert.equal(await wait, 1);
  assert.deepEqual([notes, out], [[STOPPED], []]);
  assert.deepEqual(listAgents(), []);
  assert.deepEqual([readAgent(id)?.seen, readAgent(id)?.left], [started, true]);
});

test('a wait that got a send keeps its agent listed', async () => {
  const id = await registered();
  await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  assert.equal(await runWait({ agent: id }, waitDeps()), 0);
  assert.deepEqual(listAgents().map(agent => agent.id), [id]);
  assert.equal(readAgent(id)?.left, undefined);
  assert.deepEqual(notes, []);
});

// The signal ends only the waiting: a send handed out already is written and confirmed.
test('a wait stopped as it hands out a send still confirms it and keeps its agent listed', async () => {
  const id = await registered();
  await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  const stop = new AbortController();
  const stopped = async (line: string) => {
    stop.abort();
    out.push(line);
  };
  assert.equal(await runWait({ agent: id }, { ...waitDeps(), signal: stop.signal, write: stopped }), 0);
  assert.equal(sendState('00000000000000a1'), 'picked_up');
  assert.deepEqual([out.length, notes], [1, []]);
  assert.deepEqual(listAgents().map(agent => agent.id), [id]);
  assert.equal(readAgent(id)?.left, undefined);
});

test('a later wait of an agent that left gets what was queued for it', async () => {
  const id = await registered();
  leaveAgent(id);
  enqueue(id, { send: '00000000000000a1', folder: '/x', line: 'the line of the send' });
  assert.equal(await runWait({ agent: id }, waitDeps()), 0);
  assert.deepEqual(out, ['the line of the send']);
  assert.deepEqual(listAgents().map(agent => [agent.id, agent.waiting]), [[id, false]]);
});

// Each wait is a process of its own, with a beacon of its own; two waits in this process would
// share one. So the other wait is its beacon, under the id of another process.
test('one of two waits stopped leaves the agent listed while the other waits', async () => {
  const id = await registered();
  const other = startBeacon('wait', id, process.pid + 1);
  try {
    const stop = new AbortController();
    const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal });
    stop.abort();
    assert.equal(await wait, 1);
    assert.deepEqual(listAgents().map(agent => [agent.id, agent.waiting]), [[id, true]]);
  } finally {
    other.stop();
  }
  assert.deepEqual(listAgents(), []);
});

// Here both waits run in this process, and what counts is the other wait's sign of life: its beat
// every 20 ms, and its end with a send. The end of the stopped wait runs no timer between its mark
// and the line of the test after it, so the mark is read before any beat of the other wait.
test('after one of two waits is stopped, a beat of the other takes the mark away, and its end with a send keeps the agent listed', async () => {
  const id = await registered();
  const keep = new AbortController();
  const other = runWait({ agent: id }, { ...waitDeps(), signal: keep.signal, noteMs: 20 });
  try {
    const stop = new AbortController();
    const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal });
    stop.abort();
    assert.equal(await wait, 1);
    assert.equal(readAgent(id)?.left, true);
    await until(() => readAgent(id)?.left === undefined);
    assert.deepEqual(listAgents().map(agent => agent.id), [id]);
    const sent = await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
    assert.equal(await other, 0);
    assert.deepEqual(out, [sent.body.line]);
    assert.deepEqual(listAgents().map(agent => agent.id), [id]);
    assert.equal(readAgent(id)?.left, undefined);
  } finally {
    keep.abort();
    await other;
  }
});

test('a sign of life that cannot be written changes nothing of how the wait ends', UNWRITABLE, async () => {
  const id = await registered();
  const stop = new AbortController();
  const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal, noteMs: 20 });
  const agents = join(dir, 'agents');
  chmodSync(agents, 0o500);
  try {
    await until(() => notes.filter(note => note === 'Still waiting for annotations.').length >= 2);
    stop.abort();
    assert.equal(await wait, 1);
  } finally {
    chmodSync(agents, 0o700);
  }
});

test('wait for an unknown agent is refused with 1', async () => {
  assert.equal(await runWait({ agent: '000000000000' }, waitDeps()), 1);
  assert.equal(await runWait({ agent: 'not an id' }, waitDeps()), 1);
  assert.deepEqual(notes, ['Unknown agent 000000000000. Register again.', 'Unknown agent not an id. Register again.']);
  assert.deepEqual(out, []);
});

test('wait says that it still waits, and says once when no bridge runs', async () => {
  const id = await registered();
  const stop = new AbortController();
  let ensured = 0;
  const waiting = runWait({ agent: id }, { ...waitDeps(), signal: stop.signal, noteMs: 20,
    ensure: async () => { ensured++; return { state: 'down', problem: null }; } });
  await until(() => notes.filter(note => note === 'Still waiting for annotations.').length >= 2);
  stop.abort();
  await waiting;
  assert.equal(notes[0], 'Clicknote is not running: Clicknote did not start.');
  assert.equal(notes.filter(note => note.startsWith('Clicknote is not running')).length, 1);
  assert.equal(ensured >= 2, true);
});

test('when no bridge runs, register says why and registers all the same', async () => {
  const down = { ...deps(), ensure: async () => ({ state: 'down', problem: 'port_in_use' }) as BridgeSeen };
  assert.equal(await runRegister({ harness: 'claude-code', about: '' }, down), 0);
  assert.deepEqual(notes, ['Clicknote is not running: port 47823 is held by another program, so Clicknote cannot start.']);
  assert.deepEqual(out.slice(1), ['listed as: my-site · claude-code']);
});

test('with a bridge of another version nothing is registered, and register and wait give 1', async () => {
  const id = await registered();
  const other = { ...deps(), ensure: async () => ({ state: 'other', record: running.record }) as BridgeSeen };
  assert.equal(await runRegister({ harness: 'x', about: '' }, other), 1);
  assert.equal(await runWait({ agent: id }, { ...waitDeps(), ...other }), 1);
  assert.equal(await runOpen({ url: 'http://localhost:5173/', harness: 'x', about: '', addressOnly: false }, other), 0);
  assert.deepEqual(out, ['open this address: http://localhost:5173/']);
  assert.equal((await ask({ type: 'agents', url: 'x' })).body.agents.length, 1);
  assert.equal(notes[0],
    'Clicknote is not running: the running Clicknote is another version than this command. Run stop, then run this again.');
});

test('a bridge that starts again on the same state folder keeps the list and the queue', async () => {
  const id = await registered();
  const sent = await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
  await bridge.close();
  bridge = await startBridge({ port: 0 });
  assert.deepEqual((await ask({ type: 'agents', url: 'x' })).body.agents.map((agent: { id: string }) => agent.id), [id]);
  assert.equal(await runWait({ agent: id }, waitDeps()), 0);
  assert.deepEqual(out, [sent.body.line]);
});

test('with a bridge of another version, open for a known agent writes nothing and gives the page with why', async () => {
  const id = await registered();
  const record = readAgent(id);
  const other = { ...deps(), ensure: async () => ({ state: 'other', record: running.record }) as BridgeSeen };
  assert.equal(await runOpen({ url: 'http://localhost:5173/', agent: id, about: 'new words', addressOnly: false }, other), 0);
  assert.deepEqual([out, notes], [['open this address: http://localhost:5173/'],
    ['Not linked: the running Clicknote is another version than this command. Run stop, then run this again.']]);
  assert.deepEqual(readAgent(id), record);
  assert.deepEqual(readdirSync(dir).filter(name => name === 'links'), []);
});

test('with no bridge running, open and wait for an agent that is not known give 1', async () => {
  const down = { ...waitDeps(), ensure: async () => ({ state: 'down', problem: null }) as BridgeSeen };
  assert.equal(await runOpen({ url: 'http://localhost:5173/', agent: '000000000000', addressOnly: false }, down), 1);
  assert.equal(await runWait({ agent: '000000000000' }, down), 1);
  assert.deepEqual([out, notes], [[], ['Unknown agent 000000000000. Register again.', 'Unknown agent 000000000000. Register again.']]);
});

test('after a wait ended by the signal, its beacon is gone and the agent is not listed', async () => {
  const id = await registered();
  const stop = new AbortController();
  const { wait } = await waitingFor(id, { ...waitDeps(), signal: stop.signal });
  stop.abort();
  assert.equal(await wait, 1);
  assert.deepEqual(readdirSync(join(dir, 'beacons')).filter(name => name.startsWith(`wait.${id}.`)), []);
  assert.deepEqual(listAgents(), []);
});

test('the line of a send in a state folder with a space quotes the path', async () => {
  await bridge.close();
  const spaced = mkdtempSync(join(tmpdir(), 'click note '));
  process.env.CLICKNOTE_STATE_DIR = spaced;
  bridge = await startBridge({ port: 0 });
  try {
    const id = await registered();
    await ask({ type: 'send', id: '00000000000000a1', agent: id, send: payload() });
    await runWait({ agent: id }, waitDeps());
    assert.equal(out[0].includes(`read "${join(spaced, 'sends')}`), true);
  } finally {
    rmSync(spaced, { recursive: true, force: true });
  }
});

test('stop asks a running bridge to stop and says how it went', async () => {
  let time = 0;
  const stopDeps = { note: (line: string) => { notes.push(line); }, now: () => time,
    sleep: async (ms: number) => { time += ms; } };
  assert.equal(await runStop(stopDeps), 0);
  writeBridgeRecord(running.record);
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    assert.equal(await runStop({ ...stopDeps, sleep: async ms => { time += ms; if (stopRequested()) beacon.stop(); } }), 0);
    const again = startBeacon('bridge', BRIDGE_KEY);
    try {
      assert.equal(await runStop(stopDeps), 1);
    } finally {
      again.stop();
    }
  } finally {
    beacon.stop();
  }
  assert.deepEqual(notes, ['Clicknote was not running.', 'Clicknote stopped.', 'Clicknote did not stop within 5 seconds.']);
});

test('stop looks for 5 seconds, every 100 ms', async () => {
  let time = 0;
  const pauses: number[] = [];
  writeBridgeRecord(running.record);
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    assert.equal(await runStop({ note: line => { notes.push(line); }, now: () => time,
      sleep: async ms => { pauses.push(ms); time += ms; } }), 1);
  } finally {
    beacon.stop();
  }
  assert.deepEqual([pauses.length, new Set(pauses)], [50, new Set([100])]);
});
