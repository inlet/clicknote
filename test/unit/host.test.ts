import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handle } from '../../bridge/src/host.ts';
import { preselect, recordBinding } from '../../bridge/src/bindings.ts';
import { claim, confirm, sendState } from '../../bridge/src/inbox.ts';
import { stateDir } from '../../bridge/src/paths.ts';
import { startBeacon } from '../../bridge/src/presence.ts';
import { type Agent, registerAgent, removeAgent } from '../../bridge/src/registry.ts';
import { pruneSends } from '../../bridge/src/sends.ts';
import { sendLine } from '../../shared/line.ts';
import type {
  AgentInfo, Annotation, BridgeError, BridgeResponse, SendPayload, SentOk,
} from '../../shared/types.ts';

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

let saved: string | undefined;
let dir = '';
let agent: Agent;

// The reply as a successful send or copy; fails the test when it is something else.
function sent(response: BridgeResponse): SentOk {
  if (!response.ok || !('folder' in response)) assert.fail(`expected a send reply, got ${JSON.stringify(response)}`);
  return response;
}

// The reply as a failure; fails the test when it is something else.
function failed(response: BridgeResponse): BridgeError {
  if (response.ok) assert.fail(`expected a failure, got ${JSON.stringify(response)}`);
  return response;
}

// The agents as handle lists them for the bar.
async function listed(): Promise<AgentInfo[]> {
  const reply = await handle({ type: 'agents', url: 'http://localhost:5173/' });
  if (!reply.ok || !('agents' in reply)) assert.fail(`expected a list of agents, got ${JSON.stringify(reply)}`);
  return reply.agents;
}

beforeEach(() => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-host-test-'));
  process.env.CLICKNOTE_STATE_DIR = join(dir, 'state');
  agent = registerAgent({ harness: 'claude-code', about: 'landing page copy', folder: '/x/my-site' });
});

afterEach(() => {
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

test('agents returns the registered agents in the shape the bar reads, and the preselection', async () => {
  recordBinding('http://localhost:5173/', agent.id, 'send');
  assert.deepEqual(await handle({ type: 'agents', url: 'http://localhost:5173/' }), {
    ok: true,
    agents: [{ id: agent.id, folder: 'my-site', about: 'landing page copy', harness: 'claude-code', number: null, waiting: false }],
    preselect: agent.id,
  });
});

test("the list carries each agent's parts and whether it waits", async () => {
  const beacon = startBeacon('wait', agent.id);
  try {
    assert.deepEqual(await handle({ type: 'agents', url: 'https://example.com/' }), {
      ok: true,
      agents: [{ id: agent.id, folder: 'my-site', about: 'landing page copy', harness: 'claude-code', number: null, waiting: true }],
      preselect: null,
    });
  } finally {
    beacon.stop();
  }
});

test('a later agent that reads the same carries its number', async () => {
  // A millisecond after the agent of beforeEach at the least, so it is listed after that one.
  const second = registerAgent({ harness: 'claude-code', about: 'landing page copy', folder: '/x/my-site' },
    agent.registered + 1);
  assert.deepEqual((await listed()).map(info => [info.id, info.number]), [[agent.id, null], [second.id, 2]]);
});

test('an agent that says nothing of its work is listed with that part empty', async () => {
  const bare = registerAgent({ harness: 'codex', about: '', folder: '/x/other' }, agent.registered + 1);
  assert.deepEqual((await listed()).find(info => info.id === bare.id),
    { id: bare.id, folder: 'other', about: '', harness: 'codex', number: null, waiting: false });
});

test('send writes the folder, queues the line for the agent and binds the site', async () => {
  const reply = await handle({ type: 'send', id: '00000000000000a1', agent: agent.id, send: payload() });
  assert.equal(reply.ok, true);
  const { folder, line } = reply as SentOk;
  assert.equal(existsSync(join(folder, 'annotations.md')), true);
  assert.equal(sendState('00000000000000a1'), 'queued');
  assert.deepEqual(claim(agent.id).map(queued => [queued.send, queued.folder, queued.line]),
    [['00000000000000a1', folder, line]]);
  assert.equal(preselect('http://localhost:5173/x', await listed()), agent.id);
});

test('send replies with the folder, the line and the agent', async () => {
  const reply = await handle({ type: 'send', id: '00000000000000a1', agent: agent.id, send: payload() });
  const { folder } = sent(reply);
  assert.deepEqual(reply,
    { ok: true, folder, line: sendLine(2, payload().page.url, join(folder, 'annotations.md')), agent: agent.id });
});

test('an agent that is not listed is refused before anything is written', async () => {
  assert.deepEqual(await handle({ type: 'send', id: '00000000000000a1', agent: '000000000000', send: payload() }),
    { ok: false, kind: 'agent_gone', message: 'The agent 000000000000 is no longer listed.' });
  assert.equal(existsSync(join(stateDir(), 'sends')), false);
});

test('a send without an id, or with an id of another form, is refused before anything is written', async () => {
  const request = { type: 'send', agent: agent.id, send: payload() };
  for (const id of [undefined, 'nope', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', 42, null]) {
    assert.deepEqual(await handle({ ...request, id } as unknown as Parameters<typeof handle>[0]),
      { ok: false, kind: 'failed', message: 'The bridge could not read this request.' }, String(id));
  }
  assert.equal(existsSync(join(stateDir(), 'sends')), false);
  assert.equal(existsSync(join(stateDir(), 'inbox')), false);
});

// The state of a send, as the extension asks for it.

const HELD = { ok: false, kind: 'failed', message: 'The bridge already has a send with this id.' };

// The line of a send the agent's inbox holds, as the reply to a send gave it.
async function sendTo(to: string, id: string): Promise<string> {
  return sent(await handle({ type: 'send', id, agent: to, send: payload() })).line;
}

test('a send to a waiting agent and to a busy agent each end in the right state', async () => {
  const busy = registerAgent({ harness: 'codex', about: 'tests', folder: '/x/other' }, agent.registered + 1);
  const beacon = startBeacon('wait', agent.id);
  try {
    const toWaiting = await sendTo(agent.id, '00000000000000a1');
    const toBusy = await sendTo(busy.id, '00000000000000b1');
    assert.deepEqual(await handle({ type: 'state', id: '00000000000000a1', agent: agent.id }),
      { ok: true, state: 'queued', line: toWaiting });
    assert.deepEqual(await handle({ type: 'state', id: '00000000000000b1', agent: busy.id }),
      { ok: true, state: 'queued', line: toBusy });
    // What a wait of the waiting agent does: it takes the send, and confirms it once it has written it.
    assert.deepEqual(claim(agent.id).map(queued => queued.send), ['00000000000000a1']);
    confirm(agent.id, ['00000000000000a1']);
    assert.deepEqual(await handle({ type: 'state', id: '00000000000000a1', agent: agent.id }),
      { ok: true, state: 'picked_up', line: toWaiting });
    assert.deepEqual(await handle({ type: 'state', id: '00000000000000b1', agent: busy.id }),
      { ok: true, state: 'queued', line: toBusy });
  } finally {
    beacon.stop();
  }
});

test('a queued send whose agent left the list is agent_gone', async () => {
  const queued = await sendTo(agent.id, '00000000000000a1');
  const picked = await sendTo(agent.id, '00000000000000a2');
  confirm(agent.id, ['00000000000000a2']);
  removeAgent(agent.id);
  assert.deepEqual(await listed(), []);
  assert.deepEqual(await handle({ type: 'state', id: '00000000000000a1', agent: agent.id }),
    { ok: true, state: 'agent_gone', line: queued });
  // A send the agent picked up before it left stays picked up.
  assert.deepEqual(await handle({ type: 'state', id: '00000000000000a2', agent: agent.id }),
    { ok: true, state: 'picked_up', line: picked });
});

test('a send the bridge does not hold is unknown', async () => {
  const other = registerAgent({ harness: 'codex', about: 'tests', folder: '/x/other' });
  await sendTo(agent.id, '00000000000000a1');
  const unknown = { ok: true, state: 'unknown', line: null };
  assert.deepEqual(await handle({ type: 'state', id: '00000000000000a9', agent: agent.id }), unknown);
  // The send is in the inbox of another agent than the one asked about.
  assert.deepEqual(await handle({ type: 'state', id: '00000000000000a1', agent: other.id }), unknown);
  for (const [id, of] of [['nope', agent.id], ['../x', agent.id], ['00000000000000a1', '../x'], ['00000000000000a1', '000000000000']]) {
    assert.deepEqual(await handle({ type: 'state', id, agent: of }), unknown, `${id} ${of}`);
  }
});

test('a state request without an id or an agent is refused', async () => {
  for (const request of [{ type: 'state', agent: agent.id }, { type: 'state', id: '00000000000000a1' },
    { type: 'state', id: 7, agent: agent.id }, { type: 'state', id: '00000000000000a1', agent: null }]) {
    assert.deepEqual(await handle(request as unknown as Parameters<typeof handle>[0]),
      { ok: false, kind: 'failed', message: 'The bridge could not read this request.' }, JSON.stringify(request));
  }
});

test('a send with an id the agent\'s inbox already holds is refused before anything is written', async () => {
  const line = await sendTo(agent.id, '00000000000000a1');
  assert.deepEqual(await handle({ type: 'send', id: '00000000000000a1', agent: agent.id, send: payload() }), HELD);
  assert.equal(readdirSync(join(stateDir(), 'sends')).length, 1);
  // Also once it is picked up.
  confirm(agent.id, ['00000000000000a1']);
  assert.deepEqual(await handle({ type: 'send', id: '00000000000000a1', agent: agent.id, send: payload() }), HELD);
  assert.equal(readdirSync(join(stateDir(), 'sends')).length, 1);
  assert.deepEqual(await handle({ type: 'state', id: '00000000000000a1', agent: agent.id }),
    { ok: true, state: 'picked_up', line });
});

test('copy writes the folder and gives the line, for no agent', async () => {
  const r = sent(await handle({ type: 'copy', send: payload() }));
  assert.equal(r.line, sendLine(2, payload().page.url, join(r.folder, 'annotations.md')));
  assert.equal(existsSync(join(r.folder, 'annotations.md')), true);
  assert.equal(existsSync(join(stateDir(), 'inbox')), false);
});

test('a failure while pruning old sends does not stop a send or a copy',
  { skip: process.platform === 'win32' && 'Windows has no file mode that stops a folder from being listed' }, async () => {
  const sends = join(stateDir(), 'sends');
  mkdirSync(sends, { recursive: true });
  chmodSync(sends, 0o300);   // folders can be made in it, but it cannot be listed
  try {
    assert.throws(() => pruneSends());
    const r = sent(await handle({ type: 'send', id: '00000000000000a1', agent: agent.id, send: payload() }));
    assert.equal(existsSync(join(r.folder, 'annotations.md')), true);
    assert.equal(sendState('00000000000000a1'), 'queued');
    assert.equal(sent(await handle({ type: 'copy', send: payload() })).ok, true);
  } finally {
    chmodSync(sends, 0o700);
  }
});

test('a queued send stays successful when the binding cannot be stored', async () => {
  mkdirSync(join(stateDir(), 'bindings.json'), { recursive: true });   // the store cannot be written
  assert.throws(() => recordBinding(payload().page.url, agent.id, 'send'));
  const r = await handle({ type: 'send', id: '00000000000000a1', agent: agent.id, send: payload() });
  assert.equal(r.ok, true);
  assert.equal(sendState('00000000000000a1'), 'queued');
  assert.equal(existsSync(sent(r).folder), true);
});

// Only the extension gets this far, and it sends neither, but the bridge does not rely on that:
// a number that is a path would write outside the state folder, and a URL with a line break
// would put a second line into what the agent reads.
test('a send or copy whose number or URL could escape is refused before anything is written or queued', async () => {
  const png = Buffer.from('not really a png').toString('base64');
  const escaping: SendPayload = {
    ...payload(),
    annotations: [annotation({ number: '../../../escaped' as unknown as number })],
    images: { a1b2c3d4: png },
  };
  const twoLines: SendPayload = { ...payload(), page: { ...payload().page, url: 'http://localhost:5173/\nrm -rf ~' } };
  for (const send of [escaping, twoLines]) {
    for (const request of [{ type: 'send', id: '00000000000000a1', agent: agent.id, send }, { type: 'copy', send }] as const) {
      assert.deepEqual(await handle(request),
        { ok: false, kind: 'failed', message: 'The bridge could not read this request.' }, request.type);
    }
  }
  assert.equal(existsSync(join(stateDir(), 'sends')), false);
  assert.deepEqual(readdirSync(dir), ['state']);              // nothing beside the state folder
  assert.equal(existsSync(join(stateDir(), 'inbox')), false);
});

test('a URL with white space or a control character, or that is not a URL, is refused', async () => {
  for (const url of ['http://localhost:5173/a b', 'http://localhost:5173/\u0007', 'http://localhost:5173/\u00a0', 'not a url', 42]) {
    const send = { ...payload(), page: { ...payload().page, url: url as string } };
    assert.equal(failed(await handle({ type: 'copy', send })).message, 'The bridge could not read this request.', String(url));
  }
  for (const number of [0, -1, 1.5, Number.NaN, '1']) {
    const send = { ...payload(), annotations: [annotation({ number: number as number })] };
    assert.equal(failed(await handle({ type: 'copy', send })).message, 'The bridge could not read this request.', String(number));
  }
  assert.equal(existsSync(join(stateDir(), 'sends')), false);
});

test('any other error becomes a failure and handle does not throw', async () => {
  const broken = { type: 'copy', send: null } as unknown as Parameters<typeof handle>[0];
  assert.equal(failed(await handle(broken)).kind, 'failed');
  const unknown = { type: 'frobnicate' } as unknown as Parameters<typeof handle>[0];
  assert.equal(failed(await handle(unknown)).kind, 'failed');
});
