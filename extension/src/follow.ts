import { agentLabel } from '../../shared/label.ts';
import { WAIT_SENTENCE } from '../../shared/types.ts';
import type { AgentInfo, BridgeError, ErrorKind } from '../../shared/types.ts';
import type { OwnFailure } from './bridge-client.ts';
import type { Offer, Tone } from './content/bar.ts';
import type { Followed, FollowedState, SendReply } from './messages.ts';

// How the bar follows a send once the bridge has it, and what it says about the send. The bridge
// answers a send as soon as it has queued it for the agent; the agent picks it up when it waits,
// at once or much later. So the bar asks how the send stands, and says which of these is true:
// the agent picked it up; it is queued and the agent gets it when it next waits; the agent is no
// longer listed and did not pick it up, though it still gets it if it comes back and waits again
// under its id. The bar says the last once: following ends with it, as it does once the agent has
// picked the send up. Neither Chrome nor the page is used here, so this loads in Node.

// How long after a send is stored the bar first asks how it stands: a waiting agent has picked it
// up by then. Then how often the bar asks, and until how long after the send started. After that
// it asks only when the user comes back to the page or uses the bar.
export const FOLLOW_FIRST_MS = 300;
export const FOLLOW_EVERY_MS = 2_000;
export const FOLLOW_FOR_MS = 30_000;

// How long after its start a send may still be arriving at the bridge. The bridge holds a send
// only once it has received all of it, which takes far less; until then it says `unknown` for it.
export const ARRIVE_MS = 10_000;

// The status line while the request of a send runs, and while the send may still be arriving.
export const SENDING = 'Sending…';

// What the status line shows: a text, its tone, and what it offers to copy, if anything.
export interface Shown { text: string; tone: Tone; offer?: Offer }

// Why Send is off, and what the user can copy to help, if anything. Copy still works in each case.
export interface SendOff { text: string; offer?: Offer }

// The sentence a user says to a coding agent so that it waits for the annotations, with the
// button that copies it. An agent that waits also starts the bridge.
export const WAIT_OFFER: Offer = { text: WAIT_SENTENCE, button: 'Copy sentence' };

const SEND_OFF: Partial<Record<ErrorKind, SendOff>> = {
  bridge_down: {
    text: 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works, without screenshots.',
    offer: WAIT_OFFER,
  },
};

// A send whose request got no answer of the bridge's own. The bridge may have it all the same,
// and a state that comes later says whether it does.
const NO_ANSWER: Shown = {
  text: 'Clicknote did not answer this send. Say this to your coding agent; this line then says whether the send arrived.',
  tone: 'problem',
  offer: WAIT_OFFER,
};

const AGENT_GONE = 'That agent is no longer listed. Choose another.';
const NOT_ARRIVED = 'This send did not arrive. Send again.';
const LIST_STAYS = 'The list has changed since, so it stays.';

// Why Send is off when `error` means that Send cannot work, else null. For a listing and a
// send. When the versions do not fit, the message says which side to update.
export function sendOff(error: BridgeError): SendOff | null {
  if (error.kind === 'version_mismatch') return { text: error.message };
  return SEND_OFF[error.kind] ?? null;
}

// Whether the request for a send got no answer of the bridge's own: a bridge that cannot be
// reached, or no answer that could be read. A refused and a broken connection look the same, so
// the bridge may have the send all the same. The record of such a send stays, so that a state
// asked for later can tell.
export function noAnswer(error: BridgeError | OwnFailure): boolean {
  return error.kind === 'bridge_down' || ('own' in error && error.own === 'none');
}

// Whether following ends with this state: true for picked_up, unknown and agent_gone, false for
// queued and sending. The bar says once that the agent is gone, and then forgets the send, though
// the send stays in the inbox of that agent, which gets it if it waits again under its id.
export function settled(state: FollowedState): boolean {
  return state === 'picked_up' || state === 'unknown' || state === 'agent_gone';
}

// Whether a send started at `startedAt` may still be arriving at the bridge at `now`: from its
// start up to ARRIVE_MS after it; a start that lies after `now`, as after the clock was set back,
// does not count. Until then, `unknown` for a send the bridge has not yet had is no answer yet;
// after that, it means that the send never arrived.
export function stillArriving(startedAt: number, now: number): boolean {
  return now >= startedAt && now - startedAt <= ARRIVE_MS;
}

// What the bar shows for a send of `count` annotations to `agent` that stands as `reply` says.
// `arrived`: whether the send has reached the bridge, which tells the two meanings of `unknown`
// apart: a send the bridge no longer knows, and one that never arrived. The agent is named by its
// label. The line of the send is offered to copy while it can still go to another agent: when it
// is queued, when its agent is gone, and when the bridge no longer knows it.
export function shows(reply: Followed, agent: AgentInfo, count: number, arrived: boolean): Shown {
  const sent = `Sent ${count} ${count === 1 ? 'annotation' : 'annotations'} to ${agentLabel(agent)}`;
  const them = count === 1 ? 'it' : 'them';
  const line = reply.line === null ? {} : { offer: { text: reply.line, button: 'Copy line', code: true } };
  const shown: Shown = (() => {
    switch (reply.state) {
      case 'sending':
        return { text: SENDING, tone: 'quiet' };
      case 'queued':
        return { text: `${sent}. Queued: the agent gets ${them} when it next waits.`, tone: 'quiet', ...line };
      case 'picked_up':
        return { text: `${sent}. The agent picked ${them} up.`, tone: 'done' };
      case 'agent_gone':
        return {
          text: `${sent}, but that agent is no longer listed and did not pick ${them} up. `
            + `Copy the line and paste it into another agent. If that agent comes back and waits again, it still gets ${them}.`,
          tone: 'problem',
          ...line,
        };
      case 'unknown':
        return arrived
          ? { text: `${sent}. Clicknote no longer knows whether the agent picked ${them} up.`, tone: 'problem', ...line }
          : { text: NOT_ARRIVED, tone: 'problem' };
    }
  })();
  return reply.kept ? { ...shown, text: `${shown.text} ${LIST_STAYS}` } : shown;
}

// What the bar shows when the request for a send failed. Without an answer of the bridge's own,
// the bar says so and offers the sentence that starts an agent and with it the bridge; the state
// is asked for again later. When the versions do not fit, the message says which side to update.
export function sendFailed(error: BridgeError | OwnFailure): Shown {
  if (noAnswer(error)) return NO_ANSWER;
  if (error.kind === 'version_mismatch') return { text: error.message, tone: 'problem' };
  if (error.kind === 'agent_gone') return { text: AGENT_GONE, tone: 'problem' };
  return { text: `Sending failed: ${error.message}`, tone: 'problem' };
}

// Asks every FOLLOW_EVERY_MS until the state is settled, a failure comes, or FOLLOW_FOR_MS have
// passed since `from`. Calls `show` with each answer. Gives the last answer, or null when nothing
// was asked.
// The first ask is made after `delay` milliseconds, at once without one, and a `from` that lies
// FOLLOW_FOR_MS or more in the past makes it the only one. A send that is still arriving
// (`sending`) is asked about again whatever the time: that state lasts ARRIVE_MS at most. Once
// `signal` has ended, nothing more is asked or shown: an answer that comes after it is given back
// without being shown.
export async function follow(deps: {
  ask: () => Promise<SendReply>; show: (reply: SendReply) => void;
  sleep: (ms: number) => Promise<void>; now: () => number; from: number; signal: AbortSignal; delay?: number;
}): Promise<SendReply | null> {
  const { ask, show, sleep, now, from, signal, delay = 0 } = deps;
  if (delay > 0) {
    await sleep(delay);
    if (signal.aborted) return null;
  }
  for (;;) {
    const reply = await ask();
    if (signal.aborted) return reply;
    show(reply);
    if (!reply.ok || settled(reply.state)) return reply;
    if (reply.state !== 'sending' && now() - from >= FOLLOW_FOR_MS) return reply;
    await sleep(FOLLOW_EVERY_MS);
    if (signal.aborted) return reply;
  }
}
