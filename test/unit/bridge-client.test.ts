import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bridgeDown, failed, fetchFailed, OLD_BRIDGE, OLD_EXTENSION, readEnvelope, readReply, sendToBridge, unanswered, versionMismatch,
} from '../../extension/src/bridge-client.ts';

const UNREADABLE = { ok: false, kind: 'failed', message: 'The bridge gave an answer that could not be read.', own: 'none' };
const ID = 'a1b2c3d4e5f6';
const AGENTS = [{ id: ID, folder: 'site', about: 'landing page copy', harness: 'claude-code', number: null, waiting: true }];
const SENT = { ok: true, folder: '/state/sends/2026-11-12T10-00-00', line: 'Browser annotations (1) on …', agent: ID };

test('a request that cannot connect means the bridge is not running', () => {
  assert.deepEqual(bridgeDown(new TypeError('Failed to fetch')),
    { ok: false, kind: 'bridge_down', message: 'Failed to fetch', own: 'none' });
});

test('versionMismatch says which side is older', () => {
  assert.deepEqual(versionMismatch(3), { ok: false, kind: 'version_mismatch', message: OLD_EXTENSION, own: 'refused' });
  assert.deepEqual(versionMismatch(1), { ok: false, kind: 'version_mismatch', message: OLD_BRIDGE, own: 'refused' });
  assert.equal(OLD_BRIDGE, 'The bridge is older than this extension. Ask your agent to stop Clicknote and to open the page '
    + 'again. Copy still works, without screenshots.');
  assert.equal(OLD_EXTENSION, 'This extension is older than the bridge. Load the newest zip from the release page and '
    + 'reload the extension. Copy still works, without screenshots.');
});

test('readEnvelope unwraps an answer of this protocol', () => {
  const agents = { ok: true, agents: AGENTS, preselect: null };
  assert.deepEqual(readEnvelope('agents', 200, { protocol: 2, version: '0.4.0', body: agents }), agents);
});

test('readEnvelope turns every other answer into a failure', () => {
  assert.deepEqual(readEnvelope('agents', 403, undefined),
    { ok: false, kind: 'failed', message: 'The bridge refused this extension.', own: 'refused' });
  assert.deepEqual(readEnvelope('agents', 404, undefined),
    { ok: false, kind: 'failed', message: 'The bridge answered with status 404.', own: 'refused' });
  assert.deepEqual(readEnvelope('agents', 200, 'ok'), UNREADABLE);
  assert.deepEqual(readEnvelope('agents', 200, { protocol: 2, version: '0.4.0' }), UNREADABLE);
  assert.deepEqual(readEnvelope('send', 200, { protocol: 3, version: '0.9.0', body: SENT }),
    { ok: false, kind: 'version_mismatch', message: OLD_EXTENSION, own: 'refused' });
});

// A bridge of another protocol may answer in a shape this extension does not know, and must
// still be told apart from an answer that cannot be read.
test('readEnvelope reads the protocol number before the rest', () => {
  assert.deepEqual(readEnvelope('agents', 200, { protocol: 3 }),
    { ok: false, kind: 'version_mismatch', message: OLD_EXTENSION, own: 'refused' });
});

// A bridge of protocol 1 lists its agents in the shape of protocol 1; its protocol number says it
// is older before that shape is read.
test('a bridge of protocol 1 is older than this extension', () => {
  const old = { ok: true, agents: [{ address: 't6m', agent: 'claude-code', status: '', where: 'site' }], preselect: null };
  assert.deepEqual(readEnvelope('agents', 200, { protocol: 1, version: '0.4.0', body: old }),
    { ok: false, kind: 'version_mismatch', message: OLD_BRIDGE, own: 'refused' });
});

test('an agent in the shape of protocol 1 is an answer that cannot be read, and one in this protocol\'s shape is taken', () => {
  const old = { address: 't6m', agent: 'claude-code', status: 'working', where: 'site / 1' };
  assert.deepEqual(readReply('agents', { ok: true, agents: [old], preselect: null }), UNREADABLE);
  assert.deepEqual(readReply('agents', { ok: true, agents: AGENTS, preselect: ID }), { ok: true, agents: AGENTS, preselect: ID });
  const numbered = [...AGENTS, { ...AGENTS[0], id: 'f6e5d4c3b2a1', number: 2, waiting: false }];
  assert.deepEqual(readReply('agents', { ok: true, agents: numbered, preselect: null }), { ok: true, agents: numbered, preselect: null });
  for (const broken of [{ id: ID }, { ...AGENTS[0], id: 7 }, { ...AGENTS[0], about: null }, { ...AGENTS[0], harness: undefined },
    { ...AGENTS[0], number: '2' }, { ...AGENTS[0], number: undefined }, { ...AGENTS[0], waiting: 'waiting' }]) {
    assert.deepEqual(readReply('agents', { ok: true, agents: [broken], preselect: null }), UNREADABLE, JSON.stringify(broken));
  }
});

// The bridge answers a send once it has queued it, with its line. An answer that says that a send
// still waits is of no request.
test('an answer that a send still waits is an answer that cannot be read', () => {
  const waiting = { ok: true, waiting: 'a1b2c3d4e5f60718' };
  for (const type of ['send', 'copy', 'agents', 'state'] as const) {
    assert.deepEqual(readReply(type, waiting), UNREADABLE, type);
  }
});

test('failed makes a failure from a message or an error', () => {
  assert.deepEqual(failed('No tab.'), { ok: false, kind: 'failed', message: 'No tab.' });
  assert.deepEqual(failed(new Error('Quota exceeded.')), { ok: false, kind: 'failed', message: 'Quota exceeded.' });
});

test('unanswered and fetchFailed make the failures of a bridge that gave no answer', () => {
  assert.deepEqual(unanswered('No outcome.'), { ok: false, kind: 'failed', message: 'No outcome.', own: 'none' });
  assert.deepEqual(fetchFailed(new DOMException('The operation timed out.', 'TimeoutError')),
    { ok: false, kind: 'failed', message: 'The bridge did not answer within 25 seconds.', own: 'none' });
  assert.deepEqual(fetchFailed(new TypeError('Failed to fetch')),
    { ok: false, kind: 'bridge_down', message: 'Failed to fetch', own: 'none' });
});

test('readReply passes the answers the bridge gives', () => {
  const agents = { ok: true, agents: AGENTS, preselect: ID };
  assert.deepEqual(readReply('agents', agents), agents);
  assert.deepEqual(readReply('agents', { ok: true, agents: [], preselect: null }), { ok: true, agents: [], preselect: null });
  assert.deepEqual(readReply('send', SENT), SENT);
  const copied = { ok: true, folder: SENT.folder, line: SENT.line };
  assert.deepEqual(readReply('copy', copied), copied);
  const gone = { ok: false, kind: 'agent_gone', message: `The agent ${ID} is no longer listed.` };
  assert.deepEqual(readReply('send', gone), gone);
  const down = { ok: false, kind: 'bridge_down', message: '' };
  assert.deepEqual(readReply('agents', down), down);
});

// The bridge's answer to the open page's code: the page the link opens and the agent it was made for.
test('an answer to opened is read with its page and its agent, and nothing else is', () => {
  const linked = { ok: true, url: 'file:///Users/you/site/index.html', agent: ID };
  assert.deepEqual(readReply('opened', linked), linked);
  const unknown = { ok: false, kind: 'failed', message: 'The bridge does not know this link.' };
  assert.deepEqual(readReply('opened', unknown), unknown);
  for (const reply of [
    { ok: true, url: linked.url },
    { ok: true, agent: ID },
    { ok: true, url: linked.url, agent: 7 },
    { ok: true, url: null, agent: ID },
    SENT,
    { ok: true, agents: AGENTS, preselect: null },
    { ok: true, waiting: 'a1b2c3d4e5f60718' },
  ]) {
    assert.deepEqual(readReply('opened', reply), UNREADABLE, JSON.stringify(reply));
  }
  assert.deepEqual(readReply('send', linked), UNREADABLE);
});

// The bridge's answer to a request for a send's state: how the send stands, and its line.
test('an answer to state is read with its state and its line, and nothing else is', () => {
  for (const state of ['picked_up', 'queued', 'agent_gone', 'unknown']) {
    const answer = { ok: true, state, line: SENT.line };
    assert.deepEqual(readReply('state', answer), answer, state);
  }
  const unknown = { ok: true, state: 'unknown', line: null };
  assert.deepEqual(readReply('state', unknown), unknown);
  const failure = { ok: false, kind: 'failed', message: 'The bridge could not read this request.' };
  assert.deepEqual(readReply('state', failure), failure);
  for (const reply of [
    { ok: true, state: 'gone', line: SENT.line },
    { ok: true, state: 'Queued', line: SENT.line },
    { ok: true, state: 7, line: SENT.line },
    { ok: true, line: SENT.line },
    { ok: true, state: 'queued' },
    { ok: true, state: 'queued', line: 7 },
    { ok: true, state: 'queued', line: undefined },
    SENT,
    { ok: true, waiting: 'a1b2c3d4e5f60718' },
    { ok: true, agents: AGENTS, preselect: null },
  ]) {
    assert.deepEqual(readReply('state', reply), UNREADABLE, JSON.stringify(reply));
  }
  assert.deepEqual(readReply('send', { ok: true, state: 'queued', line: SENT.line }), UNREADABLE);
});

test('readReply turns anything else into a failure', () => {
  for (const [type, reply] of [
    ['agents', undefined],
    ['agents', null],
    ['agents', 'ok'],
    ['agents', {}],
    ['agents', { ok: 'yes' }],
    ['agents', { ok: true, agents: [{ id: ID }], preselect: null }],
    ['agents', { ok: true, agents: AGENTS }],
    ['agents', SENT],
    ['send', { ok: true, agents: AGENTS, preselect: null }],
    ['send', { ok: true, folder: SENT.folder }],
    ['copy', { ok: true, folder: SENT.folder, line: SENT.line, agent: 7 }],
    ['send', { ok: false, kind: 'teapot', message: 'Short and stout.' }],
    ['send', { ok: false, kind: 'agent_gone' }],
    // A kind of failure the bridge does not have, with an empty message.
    ['send', { ok: false, kind: 'blocked', message: '' }],
  ] as const) {
    assert.deepEqual(readReply(type, reply), UNREADABLE, JSON.stringify({ type, reply }));
  }
});

// sendToBridge reads three things from its surroundings: the flag of the test build, the
// manifest's version and fetch. Each test puts stand-ins in their place.
const surroundings = globalThis as unknown as { __E2E__?: boolean; chrome?: unknown; fetch: typeof fetch };
const realFetch = surroundings.fetch;
let calls: { url: string; init: RequestInit }[] = [];

function stand(answer: () => Promise<Response>, e2e = false): void {
  calls = [];
  surroundings.__E2E__ = e2e;
  surroundings.chrome = { runtime: { getManifest: () => ({ version: '9.9.9' }) } };
  surroundings.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as typeof fetch;
}

afterEach(() => {
  surroundings.fetch = realFetch;
  delete surroundings.chrome;
  delete surroundings.__E2E__;
});

const LIST = { type: 'agents', url: 'http://localhost:5173/' } as const;
const LISTED = { ok: true, agents: AGENTS, preselect: ID };
const answered = (body: unknown) => new Response(JSON.stringify({ protocol: 2, version: '0.0.0', body }), { status: 200 });
const timeout = () => new DOMException('The operation timed out.', 'TimeoutError');

test('sendToBridge posts the request in an envelope, to the bridge\'s port or the test port', async () => {
  for (const [e2e, port] of [[false, 47823], [true, 47824]] as const) {
    stand(async () => answered(LISTED), e2e);
    await sendToBridge(LIST);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://127.0.0.1:${port}/bridge`);
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json' });
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { protocol: 2, version: '9.9.9', body: LIST });
    assert.equal(calls[0].init.signal instanceof AbortSignal, true);
  }
});

test('sendToBridge gives the reply in an answer of this protocol', async () => {
  stand(async () => answered(LISTED));
  assert.deepEqual(await sendToBridge(LIST), LISTED);
});

test('sendToBridge reads a connection that fails as a bridge that is not running', async () => {
  stand(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await sendToBridge(LIST), { ok: false, kind: 'bridge_down', message: 'Failed to fetch', own: 'none' });
});

test('sendToBridge reads a timeout, while connecting or while the answer comes, as no answer in time', async () => {
  const noAnswer = { ok: false, kind: 'failed', message: 'The bridge did not answer within 25 seconds.', own: 'none' };
  stand(() => Promise.reject(timeout()));
  assert.deepEqual(await sendToBridge(LIST), noAnswer);
  stand(async () => ({ status: 200, text: () => Promise.reject(timeout()) }) as unknown as Response);
  assert.deepEqual(await sendToBridge(LIST), noAnswer);
});

test('sendToBridge reads a 403 and an answer that is not JSON as failures', async () => {
  stand(async () => new Response('', { status: 403 }));
  assert.deepEqual(await sendToBridge(LIST),
    { ok: false, kind: 'failed', message: 'The bridge refused this extension.', own: 'refused' });
  stand(async () => new Response('not json', { status: 200 }));
  assert.deepEqual(await sendToBridge(LIST), UNREADABLE);
});
