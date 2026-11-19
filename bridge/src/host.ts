import { join } from 'node:path';
import { sendLine } from '../../shared/line.ts';
import type {
  AgentsOk, BridgeError, BridgeRequest, BridgeResponse, ErrorKind, SendPayload, SentOk, StateOk,
} from '../../shared/types.ts';
import { preselect, recordBinding } from './bindings.ts';
import { enqueue, inboxState, SEND_ID } from './inbox.ts';
import { listAgents } from './registry.ts';
import { pruneSends, writeSend } from './sends.ts';

// What the bridge says about a request it cannot act on.
export const UNREADABLE = 'The bridge could not read this request.';
const HELD_ID = 'The bridge already has a send with this id.';

// A failure the bridge reports to the extension, with the kind the bar explains.
export class BridgeFailure extends Error {
  kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = 'BridgeFailure';
    this.kind = kind;
  }
}

// Answers one request from the extension. Never throws: a BridgeFailure becomes its kind
// and message, and any other error becomes kind `failed`. The request comes from JSON, so its
// fields may be anything: a send needs an id of the form of a send's, and a request for a send's
// state needs an id and an agent that are text.
export async function handle(request: BridgeRequest): Promise<BridgeResponse> {
  try {
    switch (request.type) {
      case 'agents':
        return agents(request.url);
      case 'send':
        checkPayload(request.send);
        if (typeof request.id !== 'string' || !SEND_ID.test(request.id)) throw new BridgeFailure('failed', UNREADABLE);
        return send(request.id, request.agent, request.send);
      case 'copy':
        checkPayload(request.send);
        return copy(request.send);
      case 'state':
        if (typeof request.id !== 'string' || typeof request.agent !== 'string') {
          throw new BridgeFailure('failed', UNREADABLE);
        }
        return state(request.id, request.agent);
      default:
        throw new BridgeFailure('failed', 'The bridge does not know this request.');
    }
  } catch (error) {
    return failure(error);
  }
}

// Checks what flows into file names and into the line for the agent, before anything is
// listed, written or queued: the page's URL is a string without white space or control
// characters that parses as a URL, and each annotation's number is a positive whole number.
// Only the extension's requests get here, and it sends neither, but the bridge does not rely
// on that: a number such as `../x` would write outside the state folder.
function checkPayload(payload: unknown): void {
  const ok = isRecord(payload) && isRecord(payload.page) && Array.isArray(payload.annotations)
    && isOneUrl(payload.page.url)
    && payload.annotations.every(annotation => isRecord(annotation) && isCount(annotation.number));
  if (!ok) throw new BridgeFailure('failed', UNREADABLE);
}

function isOneUrl(value: unknown): boolean {
  return typeof value === 'string' && !/[\s\p{Cc}]/u.test(value) && URL.canParse(value);
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The registered agents as the bar lists them, and the agent to preselect for the page.
function agents(url: string): AgentsOk {
  const list = listAgents();
  return { ok: true, agents: list, preselect: preselect(url, list) };
}

// Refuses an agent that is not listed, and a send whose id the agent's inbox holds already, before
// anything is written. Then writes the folder, prunes old ones, queues the line for the agent under
// the send's id and binds the site to the agent.
function send(id: string, agent: string, payload: SendPayload): SentOk {
  if (!isListed(agent)) {
    throw new BridgeFailure('agent_gone', `The agent ${agent} is no longer listed.`);
  }
  if (inboxState(agent, id) !== null) throw new BridgeFailure('failed', HELD_ID);
  const folder = writeSend(payload);
  pruneQuietly();
  const line = sendLine(payload.annotations.length, payload.page.url, join(folder, 'annotations.md'));
  enqueue(agent, { send: id, folder, line });
  bindQuietly(payload.page.url, agent);
  return { ok: true, folder, line, agent };
}

// How the send with this id stands for this agent, as the agent's inbox holds it, with its line:
// picked up, or queued, or agent_gone for a queued send whose agent is no longer listed. Unknown,
// without a line, when the agent's inbox does not hold it, also for an id or an agent id of
// another form.
function state(id: string, agent: string): StateOk {
  const held = inboxState(agent, id);
  if (held === null) return { ok: true, state: 'unknown', line: null };
  if (held.state === 'queued' && !isListed(agent)) return { ok: true, state: 'agent_gone', line: held.line };
  return { ok: true, state: held.state, line: held.line };
}

// Whether the agent is in the list the bar shows now.
function isListed(agent: string): boolean {
  return listAgents().some(listed => listed.id === agent);
}

// Writes the folder and gives the line for the clipboard, for no agent in particular.
function copy(payload: SendPayload): SentOk {
  const folder = writeSend(payload);
  pruneQuietly();
  const line = sendLine(payload.annotations.length, payload.page.url, join(folder, 'annotations.md'));
  return { ok: true, folder, line };
}

// Removing old send folders is housekeeping: a failure there must not stop a send or a copy.
function pruneQuietly(): void {
  try {
    pruneSends();
  } catch {
    // Left for the next send to try again.
  }
}

// Binds the site after a queued send. The send is queued, so a failure here must not turn the
// reply into a failure: the user would send again and the agent would get it twice.
function bindQuietly(url: string, agent: string): void {
  try {
    recordBinding(url, agent, 'send');
  } catch {
    // Only the preselection is lost.
  }
}

function failure(error: unknown): BridgeError {
  if (error instanceof BridgeFailure) return { ok: false, kind: error.kind, message: error.message };
  return { ok: false, kind: 'failed', message: error instanceof Error ? error.message : String(error) };
}
