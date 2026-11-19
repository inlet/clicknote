import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { Agent, request, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { recordBinding } from '../../bridge/src/bindings.ts';
import { claim, confirm, enqueue, INBOX_KEEP_MS, sendState } from '../../bridge/src/inbox.ts';
import { writeLink } from '../../bridge/src/links.ts';
import { pageHeaders } from '../../bridge/src/open-page.ts';
import { STALE_MS, startBeacon } from '../../bridge/src/presence.ts';
import {
  AGENT_KEEP_MS, type Agent as Registered, leaveAgent, readAgent, registerAgent,
} from '../../bridge/src/registry.ts';
import { startBridge, type BridgeOptions, type RunningBridge } from '../../bridge/src/server.ts';
import { sendLine } from '../../shared/line.ts';
import { PROTOCOL } from '../../shared/types.ts';
import type { Annotation, SendPayload } from '../../shared/types.ts';
import { VERSION } from '../../shared/version.ts';

const EXT = 'chrome-extension://dacfmlfnipbinbogicdjfckblnjnbonl';

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
let dir = '';                 // the state folder
let bridge: RunningBridge;
let lines: string[] = [];
let agent: Registered;        // registered before each test

type Options = Omit<BridgeOptions, 'port' | 'log'>;

// Starts a bridge on a free port that logs into `lines`.
function start(options: Options = {}): Promise<RunningBridge> {
  lines = [];
  return startBridge({ port: 0, log: line => lines.push(line), ...options });
}

// Replaces the test's bridge with one started with these options.
async function useBridge(options: Options): Promise<void> {
  await bridge.close();
  bridge = await start(options);
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  raw: string;                // the body as text
  envelope: any;              // the body parsed, when it is JSON
  reused: boolean;            // whether the request went over a connection an earlier one used
}

// Sends exactly this request to a running bridge, the test's own unless `to` gives another, through
// the agent when one is given.
function send({ method, path = '/bridge', headers = {}, body, agent, to = bridge }:
  { method: string; path?: string; headers?: Record<string, string>; body?: string; agent?: Agent; to?: RunningBridge },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: to.port, method, path, headers, agent }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let envelope: unknown;
        try {
          envelope = JSON.parse(raw);
        } catch {
          envelope = undefined;
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, raw, envelope,
          reused: outgoing.reusedSocket });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

// Posts { protocol, version, body } as JSON with this Origin: the extension's when none is
// given, and no Origin header at all when it is given as undefined. The protocol is the bridge's
// own when none is given.
function post(body: object, ...rest: [origin?: string | undefined, protocol?: number]): Promise<Answer> {
  const origin = rest.length > 0 ? rest[0] : EXT;
  const protocol = rest[1] ?? PROTOCOL;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== undefined) headers.origin = origin;
  return send({ method: 'POST', headers, body: JSON.stringify({ protocol, version: 'test', body }) });
}

// Posts { protocol, version, body } as JSON to this bridge, in the bridge's own protocol, with the
// extension's Origin and with these headers over it.
function postOn(to: RunningBridge, body: object, headers: Record<string, string> = {}): Promise<Answer> {
  return send({ to, method: 'POST', headers: { 'content-type': 'application/json', origin: EXT, ...headers },
    body: JSON.stringify({ protocol: PROTOCOL, version: 'test', body }) });
}

// Asks this bridge as the extension does, and gives the envelope of its answer.
async function askOn(to: RunningBridge, body: object): Promise<any> {
  return (await postOn(to, body)).envelope;
}

// Asks the test's bridge as the extension does, and gives the envelope of its answer.
function ask(body: object): Promise<any> {
  return askOn(bridge, body);
}

// Gets this path from this bridge without an Origin, as a browser does that opens an address.
function getOn(to: RunningBridge, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return send({ to, method: 'GET', path, headers });
}

// Gets this path from the test's bridge without an Origin.
function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return getOn(bridge, path, headers);
}

// Asks the test's bridge for the head of this path, without an Origin.
function head(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return send({ method: 'HEAD', path, headers });
}

// The agent registered before each test, as the bar lists it.
function listedAgent(): object {
  return { id: agent.id, folder: 'my-site', about: 'landing page copy', harness: 'claude-code', number: null, waiting: false };
}

// The agent the bridge preselects on this page.
async function chosen(url: string): Promise<string | null> {
  return (await ask({ type: 'agents', url })).body.preselect;
}

beforeEach(async () => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-server-test-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
  agent = registerAgent({ harness: 'claude-code', about: 'landing page copy', folder: '/x/my-site' });
  bridge = await start();
});

afterEach(async () => {
  await bridge.close();
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

test('a request from the extension is answered in an envelope', async () => {
  const { status, headers, envelope } = await post({ type: 'agents', url: 'http://localhost:5173/' });
  assert.equal(status, 200);
  assert.equal(headers['access-control-allow-origin'], EXT);
  assert.deepEqual(envelope, { protocol: 2, version: VERSION, body: { ok: true, agents: [listedAgent()], preselect: null } });
});

test('any other sender is refused before anything is listed, written or queued', async () => {
  for (const origin of ['http://localhost:3000', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'null', undefined]) {
    const { status, headers, raw } = await post({ type: 'send', agent: agent.id, send: payload() }, origin);
    assert.equal(status, 403, String(origin));
    assert.equal(raw, '');
    assert.equal(headers['access-control-allow-origin'], undefined);
  }
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.equal(existsSync(join(dir, 'inbox')), false);
});

// A page whose host name resolves to this computer reaches the bridge under that name; even
// with the extension's Origin, such a request is refused before the body is read.
test('a request addressed to another host than 127.0.0.1 and the port is refused and nothing happens', async () => {
  const body = JSON.stringify({ protocol: PROTOCOL, version: 'test', body: { type: 'send', agent: agent.id, send: payload() } });
  for (const host of [`evil.example:${bridge.port}`, `localhost:${bridge.port}`, '127.0.0.1', `127.0.0.1:${bridge.port + 1}`]) {
    const { status, headers, raw } = await send({ method: 'POST', headers: { host, origin: EXT, 'content-type': 'application/json' }, body });
    assert.equal(status, 403, host);
    assert.equal(raw, '');
    assert.equal(headers['access-control-allow-origin'], undefined);
  }
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.equal(existsSync(join(dir, 'inbox')), false);
  assert.deepEqual(lines.map(line => line.slice(9)), ['- refused', '- refused', '- refused', '- refused']);
});

test('a request under another host name is refused on every path', async () => {
  for (const path of ['/bridge', '/open/x', '/anything']) {
    assert.equal((await get(path, { host: 'evil.test:1' })).status, 403, path);
  }
});

// A web page can post with fetch in mode 'no-cors', which sends no preflight; the bridge must
// refuse that post by its Origin before it reads the body.
test('a post from a web page without a preflight is refused and nothing happens', async () => {
  const { status } = await send({ method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ protocol: PROTOCOL, version: 'x', body: { type: 'send', agent: agent.id, send: payload() } }) });
  assert.equal(status, 403);
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.equal(existsSync(join(dir, 'inbox')), false);
});

test('a preflight is answered for the extension only', async () => {
  const mine = await send({ method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } });
  assert.equal(mine.status, 204);
  assert.equal(mine.headers['access-control-allow-origin'], EXT);
  const theirs = await send({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
  assert.equal(theirs.status, 403);
  assert.equal(theirs.headers['access-control-allow-origin'], undefined);
});

test('the preflight allows a JSON post, and every answer is JSON for the extension only', async () => {
  const preflight = await send({ method: 'OPTIONS', headers: { origin: EXT, 'access-control-request-method': 'POST' } });
  assert.equal(preflight.headers['access-control-allow-methods'], 'POST');
  assert.equal(preflight.headers['access-control-allow-headers'], 'content-type');
  for (const answer of [
    await post({ type: 'agents', url: 'http://localhost:5173/' }),
    await post({ type: 'frobnicate' }),
    await send({ method: 'POST', headers: { origin: EXT }, body: 'not json' }),
  ]) {
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['content-type'], 'application/json');
    assert.equal(answer.headers['access-control-allow-origin'], EXT);
    assert.equal(answer.envelope.protocol, 2);
    assert.equal(answer.envelope.version, VERSION);
  }
});

test('another path or method is not found', async () => {
  assert.equal((await send({ method: 'GET', headers: { origin: EXT } })).status, 404);
  assert.equal((await send({ method: 'POST', path: '/', headers: { origin: EXT }, body: '{}' })).status, 404);
});

test("the extension's requests count as activity, and a request for the open page does not", async () => {
  let count = 0;
  const counted = await startBridge({ port: 0, onActivity: () => { count++; } });
  try {
    await askOn(counted, { type: 'agents', url: 'http://localhost:5173/' });
    await getOn(counted, '/open/x');
    await postOn(counted, { type: 'agents', url: 'x' }, { origin: 'https://evil.test' });
    assert.equal(count, 1);
  } finally {
    await counted.close();
  }
});

test('another protocol number gets version_mismatch and nothing is done', async () => {
  const { envelope } = await post({ type: 'send', agent: agent.id, send: payload() }, EXT, 3);
  assert.equal(envelope.protocol, 2);
  assert.deepEqual(envelope.body,
    { ok: false, kind: 'version_mismatch', message: 'The extension speaks protocol 3 and the bridge protocol 2.' });
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.equal(existsSync(join(dir, 'inbox')), false);
});

// An extension of protocol 1 reads the protocol number of the answer before its body, so it says
// that the versions differ, whatever the body holds.
test('an extension of protocol 1 is told that the versions differ', async () => {
  for (const body of [{ type: 'agents', url: 'http://localhost:5173/' }, { type: 'send', agent: agent.id, send: payload() }]) {
    const { status, envelope } = await post(body, EXT, 1);
    assert.equal(status, 200);
    assert.equal(envelope.protocol, 2);
    assert.deepEqual(envelope.body,
      { ok: false, kind: 'version_mismatch', message: 'The extension speaks protocol 1 and the bridge protocol 2.' });
  }
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.equal(existsSync(join(dir, 'inbox')), false);
});

test('another protocol number gets version_mismatch whatever the rest of the body looks like', async () => {
  for (const body of [{ protocol: 1, version: 'x' }, { protocol: 1, body: [] }]) {
    const { envelope } = await send({ method: 'POST', headers: { origin: EXT }, body: JSON.stringify(body) });
    assert.deepEqual(envelope.body,
      { ok: false, kind: 'version_mismatch', message: 'The extension speaks protocol 1 and the bridge protocol 2.' });
  }
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.equal(existsSync(join(dir, 'inbox')), false);
  assert.deepEqual(lines.map(line => line.slice(9)), ['- version_mismatch', '- version_mismatch']);
});

test('a body that is not a request gets a failure', async () => {
  const agents = { type: 'agents', url: 'http://localhost:5173/' };
  for (const body of ['not json', '{}', '[]', JSON.stringify({ protocol: PROTOCOL, version: 'x', body: {} }),
    JSON.stringify({ protocol: '2', version: 'x', body: agents }), JSON.stringify({ protocol: PROTOCOL, body: agents })]) {
    const { envelope } = await send({ method: 'POST', headers: { origin: EXT }, body });
    assert.deepEqual(envelope.body, { ok: false, kind: 'failed', message: 'The bridge could not read this request.' });
  }
  const unknown = await post({ type: 'frobnicate' });
  assert.equal(unknown.envelope.body.kind, 'failed');
});

// 4 MB is still on its way when the bridge knows the request is over the limit. An answer given
// then, with the connection closed, is lost at the sender more often than not.
const OVERSIZED = JSON.stringify({ protocol: PROTOCOL, version: 'test',
  body: { type: 'copy', send: { ...payload(), note: 'x'.repeat(4 * 1024 * 1024) } } });
const LIST_AGENTS = JSON.stringify({ protocol: PROTOCOL, version: 'test', body: { type: 'agents', url: 'http://localhost:5173/' } });
const TOO_LARGE = { ok: false, kind: 'failed', message: 'This send is too large for the bridge.' };
const FROM_EXT = { origin: EXT, 'content-type': 'application/json' };
const CHUNKED = { ...FROM_EXT, 'transfer-encoding': 'chunked' };

test('a body over the limit is read to its end and then refused, with and without a content-length', async () => {
  await useBridge({ maxBody: 1000 });
  for (const headers of [FROM_EXT, CHUNKED]) {
    for (let i = 0; i < 10; i++) {
      const { status, envelope } = await send({ method: 'POST', headers, body: OVERSIZED });
      assert.equal(status, 200);
      assert.deepEqual(envelope.body, TOO_LARGE);
    }
  }
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.deepEqual(lines.map(line => line.slice(9)), Array(20).fill('- failed'));
});

test('a body of exactly the limit is read, and one byte more is refused', async () => {
  const size = Buffer.byteLength(LIST_AGENTS);
  for (const headers of [FROM_EXT, CHUNKED]) {
    await useBridge({ maxBody: size });
    assert.equal((await send({ method: 'POST', headers, body: LIST_AGENTS })).envelope.body.ok, true);
    await useBridge({ maxBody: size - 1 });
    assert.deepEqual((await send({ method: 'POST', headers, body: LIST_AGENTS })).envelope.body, TOO_LARGE);
  }
});

test('the connection of a refused oversized request serves the next request', async () => {
  await useBridge({ maxBody: 1000 });
  for (const headers of [FROM_EXT, CHUNKED]) {
    const keepAlive = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const refused = await send({ method: 'POST', headers, body: OVERSIZED, agent: keepAlive });
      assert.deepEqual(refused.envelope.body, TOO_LARGE);
      const next = await send({ method: 'POST', headers: FROM_EXT, body: LIST_AGENTS, agent: keepAlive });
      assert.equal(next.reused, true);
      assert.equal(next.envelope.body.ok, true);
    } finally {
      keepAlive.destroy();
    }
  }
});

test('a sender that goes away in the middle of an oversized request gets no log line, and the bridge goes on answering', async () => {
  await useBridge({ maxBody: 1000 });
  await new Promise<void>((resolve, reject) => {
    const socket = connect(bridge.port, '127.0.0.1', () => {
      const head = `POST /bridge HTTP/1.1\r\nHost: 127.0.0.1:${bridge.port}\r\nOrigin: ${EXT}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${4 * 1024 * 1024}\r\n\r\n`;
      socket.write(head + 'x'.repeat(64 * 1024), () => {
        socket.destroy();
        resolve();
      });
    });
    socket.on('error', reject);
  });
  assert.equal((await send({ method: 'POST', headers: FROM_EXT, body: LIST_AGENTS })).envelope.body.ok, true);
  assert.deepEqual(lines.map(line => line.slice(9)), ['agents ok']);
});

const ID = '0123456789abcdef';
const HELD = { ok: false, kind: 'failed', message: 'The bridge already has a send with this id.' };
const UNREADABLE = { ok: false, kind: 'failed', message: 'The bridge could not read this request.' };
const UNKNOWN_REQUEST = { ok: false, kind: 'failed', message: 'The bridge does not know this request.' };

test('a send is answered at once with its folder and its line', async () => {
  const { body } = await ask({ type: 'send', id: ID, agent: agent.id, send: payload() });
  assert.deepEqual(body, { ok: true, folder: body.folder, line: body.line, agent: agent.id });
  assert.equal(existsSync(join(body.folder, 'annotations.md')), true);
  assert.equal(body.line, sendLine(2, payload().page.url, join(body.folder, 'annotations.md')));
  assert.equal(sendState(ID), 'queued');
  assert.deepEqual(claim(agent.id).map(queued => [queued.send, queued.folder, queued.line]), [[ID, body.folder, body.line]]);
});

test('the state of a send is answered from its agent\'s inbox', async () => {
  const { line } = (await ask({ type: 'send', id: ID, agent: agent.id, send: payload() })).body;
  assert.deepEqual((await ask({ type: 'state', id: ID, agent: agent.id })).body, { ok: true, state: 'queued', line });
  claim(agent.id);
  confirm(agent.id, [ID]);
  assert.deepEqual((await ask({ type: 'state', id: ID, agent: agent.id })).body, { ok: true, state: 'picked_up', line });
  assert.deepEqual((await ask({ type: 'state', id: '0123456789abcde0', agent: agent.id })).body,
    { ok: true, state: 'unknown', line: null });
  assert.deepEqual(lines.map(line => line.slice(9)), ['send ok', 'state ok', 'state ok', 'state ok']);
});

test('a request of a type the bridge does not know is answered so and logged as failed', async () => {
  const reply = await ask({ type: 'frobnicate', id: ID, agent: agent.id, url: 'http://localhost:5173/' });
  assert.deepEqual(reply.body, UNKNOWN_REQUEST);
  assert.deepEqual(lines.map(line => line.slice(9)), ['- failed']);
});

test('a send without an id, or with an id of another form, is refused before anything is written or queued', async () => {
  for (const id of [undefined, 'nope', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', 42, null]) {
    const { envelope } = await post({ type: 'send', id, agent: agent.id, send: payload() });
    assert.deepEqual(envelope.body, UNREADABLE, String(id));
  }
  assert.equal(existsSync(join(dir, 'sends')), false);
  assert.equal(existsSync(join(dir, 'inbox')), false);
});

test('a send whose id its agent\'s inbox holds is refused, and is queued once', async () => {
  const request = { type: 'send', id: ID, agent: agent.id, send: payload() };
  assert.equal((await ask(request)).body.ok, true);
  assert.deepEqual((await ask(request)).body, HELD);
  assert.deepEqual(claim(agent.id).map(queued => queued.send), [ID]);
  assert.equal(readdirSync(join(dir, 'sends')).length, 1);
});

test('a send to an agent that is not listed fails and is not queued', async () => {
  const { body } = await ask({ type: 'send', id: ID, agent: '000000000000', send: payload() });
  assert.deepEqual(body, { ok: false, kind: 'agent_gone', message: 'The agent 000000000000 is no longer listed.' });
  assert.equal(sendState(ID), 'unknown');
});

test('the list does not hold an agent that left, and a send to it is refused', async () => {
  assert.deepEqual((await ask({ type: 'agents', url: 'http://localhost:5173/' })).body.agents, [listedAgent()]);
  leaveAgent(agent.id);
  assert.deepEqual((await ask({ type: 'agents', url: 'http://localhost:5173/' })).body.agents, []);
  const { body } = await ask({ type: 'send', id: ID, agent: agent.id, send: payload() });
  assert.deepEqual(body, { ok: false, kind: 'agent_gone', message: `The agent ${agent.id} is no longer listed.` });
  assert.equal(sendState(ID), 'unknown');
});

test('a taken port rejects with EADDRINUSE', async () => {
  await assert.rejects(startBridge({ port: bridge.port }), { code: 'EADDRINUSE' });
});

test('the bridge listens on this computer only', () => {
  assert.equal(bridge.address, '127.0.0.1');
});

test('old agents, old sends and stale beacons are removed when the bridge starts', async () => {
  const old = registerAgent({ harness: 'codex', about: '', folder: '/x/old' }, Date.now() - AGENT_KEEP_MS - 1);
  enqueue(agent.id, { send: ID, folder: '/x', line: 'x' }, Date.now() - INBOX_KEEP_MS - 1);
  const beacon = startBeacon('wait', agent.id);
  const beat = join(dir, 'beacons', `wait.${agent.id}.${process.pid}`);
  const staleAt = (Date.now() - STALE_MS - 1_000) / 1_000;
  try {
    utimesSync(beat, staleAt, staleAt);
    await useBridge({});
    assert.equal(readAgent(old.id), null);
    assert.equal(readAgent(agent.id)?.id, agent.id);
    assert.equal(sendState(ID), 'unknown');
    assert.equal(existsSync(beat), false);
  } finally {
    beacon.stop();
  }
});

// A bridge started by hand can run for weeks.
test('old records are removed every pruneMs while the bridge runs, and no longer once it is closed', async () => {
  await useBridge({ pruneMs: 50 });
  const old = registerAgent({ harness: 'codex', about: '', folder: '/x/old' }, Date.now() - AGENT_KEEP_MS - 1);
  enqueue(agent.id, { send: ID, folder: '/x', line: 'x' }, Date.now() - INBOX_KEEP_MS - 1);
  const linkFile = join(dir, 'links', `${writeLink(link(), Date.now() - 3_600_001)}.json`);
  const end = Date.now() + 5_000;
  while ((readAgent(old.id) !== null || sendState(ID) !== 'unknown' || existsSync(linkFile)) && Date.now() < end) await sleep(20);
  assert.deepEqual([readAgent(old.id), sendState(ID), existsSync(linkFile)], [null, 'unknown', false]);
  await bridge.close();
  const later = registerAgent({ harness: 'codex', about: '', folder: '/x/later' }, Date.now() - AGENT_KEEP_MS - 1);
  await sleep(200);
  assert.equal(readAgent(later.id)?.id, later.id);
  bridge = await start();
});

test('by default the bridge removes old records once an hour', async t => {
  await bridge.close();
  t.mock.timers.enable({ apis: ['setInterval'] });
  bridge = await start();
  const old = registerAgent({ harness: 'codex', about: '', folder: '/x/old' }, Date.now() - AGENT_KEEP_MS - 1);
  t.mock.timers.tick(3_599_999);
  assert.equal(readAgent(old.id)?.id, old.id);
  t.mock.timers.tick(1);
  assert.equal(readAgent(old.id), null);
  await bridge.close();
  t.mock.timers.reset();
  bridge = await start();
});

// Nothing in the handling is meant to throw. If something does, the request gets no reply,
// and its line in the log must not go missing with it. Here the log itself throws once.
test('a request whose handling throws is logged as failed, with its type', async () => {
  await bridge.close();
  lines = [];
  let thrown = false;
  bridge = await startBridge({ port: 0, log: line => {
    if (thrown) return void lines.push(line);
    thrown = true;
    throw new Error('The log cannot be written.');
  } });
  await post({ type: 'agents', url: 'http://localhost:5173/' }).catch(() => undefined);
  assert.deepEqual(lines.map(line => line.slice(9)), ['agents failed']);
});

test('the log has one line per request and nothing of the annotations', async () => {
  await post({ type: 'send', id: ID, agent: agent.id, send: payload() });  // its comment is 'Make the button green.'
  await post({ type: 'agents', url: 'http://localhost:5173/' }, 'http://localhost:3000');
  assert.match(lines[0], /^\d\d:\d\d:\d\d send ok$/);
  assert.match(lines[1], /^\d\d:\d\d:\d\d - refused$/);
  assert.equal(lines.some(line => /green|localhost/.test(line)), false);
});

const HOUR = 3_600_000;
const EXPIRED = 'This link has expired. Ask your agent to open the page again.';
const UNKNOWN_LINK = { ok: false, kind: 'failed', message: 'The bridge does not know this link.' };

// A link for the agent registered before the test.
function link(): { url: string; agent: string; label: string } {
  return { url: 'http://localhost:3000/a', agent: agent.id, label: 'my-site · landing page copy · claude-code' };
}

// The nonce the content security policy of a page allows its script with.
function policyNonce(answer: Answer): string | undefined {
  return /script-src 'nonce-([^']*)'/.exec(String(answer.headers['content-security-policy']))?.[1];
}

test('the open address serves the open page with its headers', async () => {
  const answer = await get(`/open/${writeLink(link())}`);
  assert.equal(answer.status, 200);
  const nonce = policyNonce(answer);
  assert.match(String(nonce), /^[A-Za-z0-9+/]{22}==$/);          // 16 bytes in base64
  for (const [name, value] of Object.entries(pageHeaders(nonce))) assert.equal(answer.headers[name], value, name);
  const page = new JSDOM(answer.raw).window.document;
  assert.equal(page.body.textContent!.includes('Opening http://localhost:3000/a for'), true);
  assert.equal(page.querySelector('script')?.getAttribute('nonce'), nonce);
});

test('two requests for the same page get two nonces', async () => {
  const code = writeLink(link());
  const first = policyNonce(await get(`/open/${code}`));
  const second = policyNonce(await get(`/open/${code}`));
  assert.equal(typeof first, 'string');
  assert.notEqual(first, second);
});

test('an unknown code, a code of another form and an old link get the expired page', async () => {
  const code = writeLink(link());
  const old = writeLink(link(), Date.now() - HOUR - 1);
  for (const path of [`/open/${'0'.repeat(32)}`, '/open/abc', `/open/${code}/x`, `/open/${old}`]) {
    const answer = await get(path);
    assert.equal(answer.status, 404, path);
    assert.equal(answer.raw.includes(EXPIRED), true, path);
    for (const [name, value] of Object.entries(pageHeaders())) assert.equal(answer.headers[name], value, name);
  }
});

// The state folder is the user's, but the bridge does not run what a file there holds.
test('a link whose URL is not http, https or file gets the expired page and binds nothing', async () => {
  const code = writeLink(link());
  const file = join(dir, 'links', `${code}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), url: 'javascript:alert(1)' }));
  const answer = await get(`/open/${code}`);
  assert.equal(answer.status, 404);
  assert.equal(answer.raw.includes('alert'), false);
  assert.equal(existsSync(join(dir, 'bindings.json')), false);
});

test('the first request for a code binds the site, and a later one does not', async () => {
  const code = writeLink(link());
  await get(`/open/${code}`);
  assert.equal(await chosen('http://localhost:3000/'), agent.id);
  const other = registerAgent({ harness: 'codex', about: 'tests', folder: '/x/my-site' });
  recordBinding('http://localhost:3000/', other.id, 'send');
  await get(`/open/${code}`);
  assert.equal(await chosen('http://localhost:3000/'), other.id);
});

test('a link whose site cannot be bound still gets its page', async () => {
  mkdirSync(join(dir, 'bindings.json'));
  assert.equal((await get(`/open/${writeLink(link())}`)).status, 200);
});

test('a request for the open address under another host name is refused', async () => {
  const code = writeLink(link());
  for (const path of [`/open/${code}`, '/open']) {
    const { status, raw } = await get(path, { host: `evil.test:${bridge.port}` });
    assert.equal(status, 403, path);
    assert.equal(raw, '', path);
  }
  assert.equal(await chosen('http://localhost:3000/'), null);
});

test('the open address is for GET only', async () => {
  const code = writeLink(link());
  const { status } = await send({ method: 'POST', path: `/open/${code}`, headers: { origin: EXT }, body: '{}' });
  assert.equal(status, 404);
  assert.equal(await chosen('http://localhost:3000/'), null);
});

test('the question without a code and a HEAD of an open address are gone', async () => {
  assert.equal((await get('/open')).status, 404);
  const code = writeLink({ url: 'http://localhost:5173/', agent: agent.id, label: 'x' });
  assert.equal((await head(`/open/${code}`)).status, 404);
  assert.equal((await get(`/open/${code}`)).status, 200);
});

test('the extension learns whose link a code is', async () => {
  const code = writeLink(link());
  assert.deepEqual((await post({ type: 'opened', code })).envelope.body,
    { ok: true, url: 'http://localhost:3000/a', agent: agent.id });
  for (const unknown of ['0'.repeat(32), 'abc', 42]) {
    assert.deepEqual((await post({ type: 'opened', code: unknown })).envelope.body, UNKNOWN_LINK, String(unknown));
  }
  assert.equal((await post({ type: 'opened', code }, undefined)).status, 403);
});

test('the log names the requests and nothing of the link', async () => {
  const code = writeLink(link());
  await get(`/open/${code}`);
  await get('/open/abc');
  await get(`/open/${code}`, { host: `evil.test:${bridge.port}` });
  await post({ type: 'opened', code });
  await post({ type: 'opened', code: 'abc' });
  assert.deepEqual(lines.map(line => line.slice(9)),
    ['open ok', 'open expired', '- refused', 'opened ok', 'opened failed']);
  assert.equal(lines.every(line => /^\d\d:\d\d:\d\d /.test(line)), true);
  assert.equal(lines.some(line => line.includes(code) || line.includes('localhost:3000')), false);
});

test('old links are removed when the bridge starts and when a link is read', async () => {
  const links = join(dir, 'links');
  const current = writeLink(link());
  writeLink(link(), Date.now() - HOUR - 1);
  await useBridge({});
  assert.deepEqual(readdirSync(links), [`${current}.json`]);
  writeLink(link(), Date.now() - HOUR - 1);
  await get(`/open/${'0'.repeat(32)}`);
  assert.deepEqual(readdirSync(links), [`${current}.json`]);
  writeLink(link(), Date.now() - HOUR - 1);
  await post({ type: 'opened', code: '0'.repeat(32) });
  assert.deepEqual(readdirSync(links), [`${current}.json`]);
});
