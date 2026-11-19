import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EXTENSION_ID } from '../../shared/extension-id.ts';
import { BRIDGE_HOST, BRIDGE_PATH, PROTOCOL } from '../../shared/types.ts';
import type { BridgeError, BridgeRequest, BridgeResponse, Envelope } from '../../shared/types.ts';
import { VERSION } from '../../shared/version.ts';
import { recordBinding } from './bindings.ts';
import { handle, UNREADABLE } from './host.ts';
import { pruneInbox } from './inbox.ts';
import { LINK_CODE, type Link, markBound, pruneLinks, readLink } from './links.ts';
import { expiredPage, openPage, pageHeaders } from './open-page.ts';
import { pruneBeacons } from './presence.ts';
import { pruneAgents } from './registry.ts';

// What the bridge is started with. Only the port is required.
export interface BridgeOptions {
  port: number;                    // 0 takes a free port
  log?: (line: string) => void;    // one line per request; default: nothing
  maxBody?: number;                // bytes; default 64 * 1024 * 1024
  onActivity?: () => void;         // called for each request that passes the check of host and origin
  pruneMs?: number;                // how often old records are removed while it runs; default PRUNE_MS
}

// How often a bridge that runs removes old records: once an hour. One started by hand can run for
// weeks.
const PRUNE_MS = 3_600_000;

// A bridge that listens: the port and the address it is bound to, and how to stop it.
export interface RunningBridge {
  port: number;
  address: string;
  close(): Promise<void>;
}

// The only sender the bridge answers. The browser sets Origin itself and a web page cannot
// forge it, so this is what keeps pages from sending to an agent.
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

const TOO_LARGE = 'This send is too large for the bridge.';
const UNKNOWN_LINK = 'The bridge does not know this link.';

// The open address of a link is this path with the link's code after it.
const OPEN_PATH = '/open';

// The request types the log names. Any other type is logged as `-`.
const TYPES = new Set(['agents', 'send', 'copy', 'state', 'opened']);

interface State {
  log: (line: string) => void;
  onActivity: () => void;
  maxBody: number;
  host: string;                                  // the only Host header answered: 127.0.0.1:<port>
}

// Listens on 127.0.0.1 and answers the extension's requests, and the browser's requests for the
// open address of a link, until it is closed. Once it listens, removes old links, old agents,
// old sends in the agents' inboxes and stale beacons, and again every pruneMs while it runs, on a
// timer that does not keep the process alive and that ends when the bridge is closed. Rejects
// with the system's error (code EADDRINUSE) when the port is taken.
export function startBridge(options: BridgeOptions): Promise<RunningBridge> {
  const state: State = {
    log: options.log ?? (() => {}),
    onActivity: options.onActivity ?? (() => {}),
    maxBody: options.maxBody ?? 64 * 1024 * 1024,
    host: '',                                    // set once the port is known
  };
  const server = createServer((request, response) => {
    // Nothing in answer is meant to throw; if it does, there is no reply, and the log says so.
    answer(request, response, state).catch(() => {
      response.destroy();
      state.log(logLine('-', 'failed'));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, BRIDGE_HOST, () => {
      server.off('error', reject);
      const { address, port } = server.address() as AddressInfo;
      state.host = `${BRIDGE_HOST}:${port}`;
      pruneAll();
      const pruning = setInterval(pruneAll, options.pruneMs ?? PRUNE_MS);
      pruning.unref();
      resolve({
        port,
        address,
        close: () => {
          clearInterval(pruning);
          return close(server);
        },
      });
    });
  });
}

// Removes old links, old agents, old sends in the agents' inboxes and stale beacons.
function pruneAll(): void {
  pruneQuietly(pruneLinks);
  pruneQuietly(pruneAgents);
  pruneQuietly(pruneInbox);
  pruneQuietly(pruneBeacons);
}

// Answers one HTTP request and logs one line for it. The host the request is addressed to is
// checked first, for every path: a web page whose host name resolves to this computer would reach
// the bridge under that name. A GET of an open address carries no sender; see `open`. For the
// extension's path, the sender is checked before the body is read, so a refused sender cannot
// make the bridge list, write or queue anything.
async function answer(request: IncomingMessage, response: ServerResponse, state: State): Promise<void> {
  if (request.headers.host !== state.host) {
    empty(response, 403);
    state.log(logLine('-', 'refused'));
    return;
  }
  const path = (request.url ?? '').split('?')[0];
  if (request.method === 'GET' && path.startsWith(`${OPEN_PATH}/`)) {
    open(path, response, state);
    return;
  }
  if (path !== BRIDGE_PATH || (request.method !== 'POST' && request.method !== 'OPTIONS')) {
    empty(response, 404);
    state.log(logLine('-', 'refused'));
    return;
  }
  if (request.headers.origin !== ORIGIN) {
    empty(response, 403);
    state.log(logLine('-', 'refused'));
    return;
  }
  state.onActivity();
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
    }).end();
    state.log(logLine('-', 'ok'));
    return;
  }
  const bytes = await readBody(request, state.maxBody);
  if (bytes === null) return;                    // the sender went away; there is no one to answer
  if (bytes === 'too_large') {
    const reply = failure(TOO_LARGE);
    writeReply(response, reply);
    state.log(logLine('-', outcome(reply)));
    return;
  }
  const read = readRequest(bytes);
  try {
    const reply = 'reply' in read ? read.reply : await act(read.body);
    writeReply(response, reply);
    state.log(logLine(read.type, outcome(reply)));
  } catch {
    response.destroy();
    state.log(logLine(read.type, 'failed'));
  }
}

// Answers a GET to /open/<code> with the open page of that link, or with the expired page for a
// code it does not give. It carries no Origin: the browser sends none when it opens an address.
// It lists no agents, writes no send and queues nothing; the open page needs a code only a
// program of this user can know.
function open(path: string, response: ServerResponse, state: State): void {
  const code = path.slice(OPEN_PATH.length + 1);
  const link = currentLink(code);
  if (!link) {
    writePage(response, 404, expiredPage(), pageHeaders());
    state.log(logLine('open', 'expired'));
    return;
  }
  bindOnce(code, link);
  const nonce = randomBytes(16).toString('base64');
  writePage(response, 200, openPage(link, nonce), pageHeaders(nonce));
  state.log(logLine('open', 'ok'));
}

// The link with this code, read after old links are removed. A code of another form names no
// link, and removes nothing.
function currentLink(code: string): Link | null {
  if (!LINK_CODE.test(code)) return null;
  pruneQuietly(pruneLinks);
  return readLink(code);
}

// Binds the link's site to its agent at the first request for its code, so the bar chooses the
// agent on that site. A later request does not: coming back to the open address must not undo
// a send made since then.
function bindOnce(code: string, link: Link): void {
  if (link.bound) return;
  try {
    recordBinding(link.url, link.agent, 'link');
    markBound(code);
  } catch {
    // Only the choice by site is lost; the open page still names the agent, and the extension
    // still learns it from the code.
  }
}

// Removing old records is housekeeping: a failure there must not stop the bridge or an answer.
function pruneQuietly(prune: () => void): void {
  try {
    prune();
  } catch {
    // Left for the next prune; old links also for the next link that is read.
  }
}

// A page for the browser itself, with these headers.
function writePage(response: ServerResponse, status: number, html: string, headers: Record<string, string>): void {
  response.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(html) });
  response.end(html);
}

// The request in a body that was read whole, with the request type to log; or, for a body that
// is not a request of this protocol, the reply to it. The protocol number is checked before the
// rest of the shape: an extension of another protocol may send a shape this bridge does not
// know, and must still be told that the versions differ. Only the type of the request is checked
// here; what it holds is checked where it is acted on.
function readRequest(bytes: Buffer): { type: string; reply: BridgeResponse } | { type: string; body: BridgeRequest } {
  const value = parseJson(bytes);
  if (!isRecord(value) || typeof value.protocol !== 'number') return { type: '-', reply: failure(UNREADABLE) };
  const { protocol, version, body } = value;
  if (protocol !== PROTOCOL) {
    const message = `The extension speaks protocol ${protocol} and the bridge protocol ${PROTOCOL}.`;
    return { type: logType(body), reply: { ok: false, kind: 'version_mismatch', message } };
  }
  if (typeof version !== 'string' || !isRecord(body) || typeof body.type !== 'string') {
    return { type: '-', reply: failure(UNREADABLE) };
  }
  return { type: logType(body), body: body as BridgeRequest };
}

// The reply to a request of this protocol. A send is answered once it is queued; a request of a
// type the bridge does not know gets a failure from handle.
async function act(body: BridgeRequest): Promise<BridgeResponse> {
  return body.type === 'opened' ? opened(body.code) : handle(body);
}

// The page and the agent of the link with this code, for the extension, which reads the code on
// the open page. A code the bridge does not give a link for gets a failure. The body comes from
// JSON, so the code may be anything.
function opened(code: unknown): BridgeResponse {
  const link = typeof code === 'string' ? currentLink(code) : null;
  if (!link) return failure(UNKNOWN_LINK);
  return { ok: true, url: link.url, agent: link.agent };
}

// Reads the body to its end, also when it is over maxBody, so the sender is there to get the
// answer. The body is over the limit from the start when content-length says so, else from the
// chunk that takes it past maxBody; from then on no chunk is kept, and the ones held are dropped.
// At the end, gives 'too_large' for a body over the limit, else its bytes. Gives null when the
// sender goes away before the end.
function readBody(request: IncomingMessage, maxBody: number): Promise<Buffer | 'too_large' | null> {
  return new Promise(resolve => {
    let tooLarge = Number(request.headers['content-length']) > maxBody;
    let chunks: Buffer[] = [];
    let size = 0;
    const done = (value: Buffer | 'too_large' | null) => {
      request.off('data', onData).off('end', onEnd).off('error', onGone).off('close', onGone);
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size <= maxBody) {
        chunks.push(chunk);
        return;
      }
      tooLarge = true;
      chunks = [];
    };
    const onEnd = () => done(tooLarge ? 'too_large' : Buffer.concat(chunks));
    const onGone = () => done(null);
    request.on('data', onData).on('end', onEnd).on('error', onGone).on('close', onGone);
  });
}

// The JSON value in these bytes, or undefined when they are not JSON.
function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
}

// The request type for the log: a type the bridge knows, else `-`.
function logType(body: unknown): string {
  return isRecord(body) && typeof body.type === 'string' && TYPES.has(body.type) ? body.type : '-';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A 200 with the reply in the bridge's envelope, readable by the extension only.
function writeReply(response: ServerResponse, reply: BridgeResponse): void {
  const envelope: Envelope<BridgeResponse> = { protocol: PROTOCOL, version: VERSION, body: reply };
  const json = JSON.stringify(envelope);
  response.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'access-control-allow-origin': ORIGIN,
  });
  response.end(json);
}

// A status with no body. The connection is closed after it, so a body that was sent along is
// not read.
function empty(response: ServerResponse, status: number): void {
  response.writeHead(status, { connection: 'close' }).end();
}

function failure(message: string): BridgeError {
  return { ok: false, kind: 'failed', message };
}

// `ok`, or the error kind.
function outcome(reply: BridgeResponse): string {
  return reply.ok ? 'ok' : reply.kind;
}

// A line of the bridge's log: `HH:MM:SS <type> <outcome>` in local time.
export function logLine(type: string, result: string, now = new Date()): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())} ${type} ${result}`;
}

// Stops listening and closes the idle keep-alive connections. Resolves once the requests that are
// still open have been answered.
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
