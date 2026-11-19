import { BRIDGE_HOST, BRIDGE_PATH, BRIDGE_PORT, BRIDGE_PORT_E2E, PROTOCOL } from '../../shared/types.ts';
import type {
  AgentInfo, BridgeError, BridgeRequest, BridgeResponse, Envelope, ErrorKind, SendStatus,
} from '../../shared/types.ts';

// Calling the bridge over HTTP, and reading what comes back. Only the service worker calls
// `sendToBridge`, never the page, so the request carries the extension's origin, the one sender
// the bridge answers. Chrome APIs are used inside `sendToBridge` only, so the rest loads in Node.

// True in the build for the browser tests (`node build.mjs --e2e`). Not defined in Node, so it
// is read inside `bridgePort` only.
declare const __E2E__: boolean;

// What the bar says when the protocol numbers of the extension and the bridge differ.
export const OLD_EXTENSION = 'This extension is older than the bridge. Load the newest zip from the release page and reload the extension. Copy still works, without screenshots.';
export const OLD_BRIDGE = 'The bridge is older than this extension. Ask your agent to stop Clicknote and to open the page again. Copy still works, without screenshots.';

const UNREADABLE = 'The bridge gave an answer that could not be read.';
const REFUSED = 'The bridge refused this extension.';
const NO_ANSWER = 'The bridge did not answer within 25 seconds.';

// A request the bridge has not answered within this time is not being answered.
const TIMEOUT_MS = 25_000;

// Every ErrorKind, so a reply can be checked at run time. The type makes the list complete.
const ERROR_KINDS: Record<ErrorKind, true> = { bridge_down: true, version_mismatch: true, agent_gone: true, failed: true };
// Every SendStatus, so a reply can be checked at run time. The type makes the list complete.
const SEND_STATUSES: Record<SendStatus, true> = { picked_up: true, queued: true, agent_gone: true, unknown: true };

// A failure the extension makes itself, because the bridge gave no reply of its own.
// `refused`: the answer shows that the bridge did not act on the request.
// `none`: no answer that could be read.
// For a send, that tells whether the bridge may have it all the same (see noAnswer in follow.ts).
export interface OwnFailure extends BridgeError { own: 'refused' | 'none' }

// The bridge's own reply, or a failure the extension made in its place.
export type ClientReply = BridgeResponse | OwnFailure;

// The port of this build's bridge: the test build's is the test port, on which no bridge a user
// runs listens.
export function bridgePort(): number {
  return __E2E__ ? BRIDGE_PORT_E2E : BRIDGE_PORT;
}

// One request to the bridge and its reply. Never throws. The test build calls the test port.
export async function sendToBridge(request: BridgeRequest): Promise<ClientReply> {
  const port = bridgePort();
  const envelope: Envelope<BridgeRequest> = { protocol: PROTOCOL, version: chrome.runtime.getManifest().version, body: request };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`http://${BRIDGE_HOST}:${port}${BRIDGE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
      signal,
    });
  } catch (error) {
    return fetchFailed(error);
  }
  try {
    return readEnvelope(request.type, response.status, await payloadOf(response));
  } catch (error) {
    return unanswered(timedOut(error) ? NO_ANSWER : error);
  }
}

// A failure of kind `failed`, from a message or an error.
export function failed(problem: unknown): BridgeError {
  return { ok: false, kind: 'failed', message: messageOf(problem) };
}

// A failure of kind `failed` for a request that got no answer that could be read.
export function unanswered(problem: unknown): OwnFailure {
  return { ...failed(problem), own: 'none' };
}

// A request that `fetch` rejected: no answer in time, or no connection at all.
export function fetchFailed(error: unknown): OwnFailure {
  return timedOut(error) ? unanswered(NO_ANSWER) : bridgeDown(error);
}

// A request that cannot connect: the bridge is not running.
export function bridgeDown(problem: unknown): OwnFailure {
  return { ok: false, kind: 'bridge_down', message: messageOf(problem), own: 'none' };
}

// The bridge speaks another protocol than this extension. The higher number is the newer side.
// Such a bridge does nothing with a request of this protocol.
export function versionMismatch(bridgeProtocol: number): OwnFailure {
  return {
    ok: false, kind: 'version_mismatch', message: bridgeProtocol > PROTOCOL ? OLD_EXTENSION : OLD_BRIDGE, own: 'refused',
  };
}

// The reply in the bridge's answer, from its HTTP status and the JSON it carried (undefined
// when it carried none). The protocol number is checked before the rest of the envelope, so a
// bridge of another protocol is told apart from an answer that cannot be read. A status other
// than 200 means the bridge did not act on the request.
export function readEnvelope(type: BridgeRequest['type'], status: number, payload: unknown): ClientReply {
  if (status === 403) return refused(REFUSED);
  if (status !== 200) return refused(`The bridge answered with status ${status}.`);
  if (!isRecord(payload) || typeof payload.protocol !== 'number') return unanswered(UNREADABLE);
  if (payload.protocol !== PROTOCOL) return versionMismatch(payload.protocol);
  if (typeof payload.version !== 'string' || !Object.hasOwn(payload, 'body')) return unanswered(UNREADABLE);
  return readReply(type, payload.body);
}

// The bridge's reply when it has the shape the request asks for: an AgentsOk for `agents`,
// an OpenedOk for `opened`, a StateOk for `state`, a SentOk for `send` and `copy`, or a
// BridgeError for any of them. Anything else is a failure, as an answer that could not be read.
export function readReply(type: BridgeRequest['type'], reply: unknown): ClientReply {
  if (!isRecord(reply)) return unanswered(UNREADABLE);
  if (reply.ok === false) {
    const { kind, message } = reply;
    return isErrorKind(kind) && typeof message === 'string' ? { ok: false, kind, message } : unanswered(UNREADABLE);
  }
  if (reply.ok !== true) return unanswered(UNREADABLE);
  if (type === 'agents') {
    const { agents, preselect } = reply;
    const valid = Array.isArray(agents) && agents.every(isAgentInfo)
      && (preselect === null || typeof preselect === 'string');
    return valid ? { ok: true, agents, preselect } : unanswered(UNREADABLE);
  }
  if (type === 'opened') {
    const { url, agent } = reply;
    return typeof url === 'string' && typeof agent === 'string' ? { ok: true, url, agent } : unanswered(UNREADABLE);
  }
  if (type === 'state') {
    const { state, line } = reply;
    return isSendStatus(state) && (typeof line === 'string' || line === null)
      ? { ok: true, state, line } : unanswered(UNREADABLE);
  }
  const { folder, line, agent } = reply;
  if (typeof folder !== 'string' || typeof line !== 'string') return unanswered(UNREADABLE);
  if (agent === undefined) return { ok: true, folder, line };
  return typeof agent === 'string' ? { ok: true, folder, line, agent } : unanswered(UNREADABLE);
}

// A failure of kind `failed` for an answer that shows the bridge did not act on the request.
function refused(problem: unknown): OwnFailure {
  return { ...failed(problem), own: 'refused' };
}

// The JSON of an answer with status 200, else undefined, as when it is not JSON. Only a 200
// carries a body. Rejects when the body stops coming, as on the timeout.
async function payloadOf(response: Response): Promise<unknown> {
  if (response.status !== 200) return undefined;
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// True for the rejection of AbortSignal.timeout.
function timedOut(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'TimeoutError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && Object.hasOwn(ERROR_KINDS, value);
}

// Whether `value` is one of the states a send can have.
export function isSendStatus(value: unknown): value is SendStatus {
  return typeof value === 'string' && Object.hasOwn(SEND_STATUSES, value);
}

// An agent in the shape of this protocol: its id and its parts as strings, its number a whole
// number or null, and whether it waits.
function isAgentInfo(value: unknown): value is AgentInfo {
  if (!isRecord(value)) return false;
  const { id, folder, about, harness, number, waiting } = value;
  return [id, folder, about, harness].every(field => typeof field === 'string')
    && (number === null || Number.isSafeInteger(number)) && typeof waiting === 'boolean';
}

function messageOf(problem: unknown): string {
  if (typeof problem === 'string') return problem;
  if (problem instanceof Error) return problem.message;
  // fetch and Chrome reject with an Error, but check for any object with a message.
  const message = (problem as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(problem);
}
