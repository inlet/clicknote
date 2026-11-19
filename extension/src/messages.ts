import type { AgentInfo, Annotation, BridgeError, Intent, PageInfo, Rect, SendStatus } from '../../shared/types.ts';
import type { OwnFailure } from './bridge-client.ts';

// The messages between the content script and the service worker.

// The unsent annotations of a tab, kept by the service worker until they are sent or copied.
export interface Draft { url: string; note: string; annotations: Annotation[] }

// What a send carried, as far as it can change afterwards.
export interface Sent { note: string; annotations: { id: string; comment: string; intent: Intent }[] }

// The send a tab follows, kept by the service worker from before its request. A page that loads
// meanwhile goes on following it, on whatever page the tab shows: its id, when it started, the
// agent as the bar showed it, and what it carried, which tells whether the tab's draft is still the
// one it sent. It holds no URL, so it stays with the tab when the page changes.
export interface SendRecord {
  id: string;
  startedAt: number;
  agent: AgentInfo;            // as the bar showed it
  sent: Sent;
  line: string | null;         // the send's line once the bridge has it; null until then
  kept: boolean;               // the list stayed, because it had changed since
  status: SendStatus | null;   // the last state the bridge gave
}

// How a send stands: a state the bridge gives, or `sending`, which only the extension gives: the
// send was started a short while ago and the bridge does not have it yet, so it may still be
// arriving (stillArriving in follow.ts).
export type FollowedState = SendStatus | 'sending';

// The answer to `send` and to `send:state`: how the send stands, or a failure.
// A failure with `own` was made by the extension, as the bridge gave no reply of its own.
export type Followed = { ok: true; state: FollowedState; line: string | null; kept: boolean };
export type SendReply = Followed | BridgeError | OwnFailure;

// The answer to `send:state` for an id that is not the id of the tab's record: the tab no longer
// follows that send, because a newer send took its place or its record has gone. The service
// worker gives it without asking the bridge, and the page shows nothing for it.
export interface NotFollowed { followed: false }

// From the content script to the service worker, with the answer to each. When the service
// worker cannot handle a message, it answers `{ ok: false, kind: 'failed', message }` instead.
export type ToBackground =
  | { type: 'draft:load'; url: string }                       // -> { draft: Draft | null }
  | { type: 'draft:save'; draft: Draft }                      // -> { ok: true }
  | { type: 'capture'; id: string; rect: Rect; viewport: { width: number; height: number } }  // -> { ok: boolean }
  | { type: 'crop:get'; id: string }                          // -> { dataUrl: string | null }
  | { type: 'crop:delete'; id: string }                       // -> { ok: true }
  | { type: 'agents'; url: string }                           // -> BridgeResponse
  | { type: 'send'; agent: AgentInfo; page: PageInfo }        // -> SendReply
  | { type: 'send:state'; id: string }                        // -> SendReply | NotFollowed
  | { type: 'send:load' }                                     // -> { record: SendRecord | null }
  | { type: 'copy'; page: PageInfo }                          // -> BridgeResponse
  | { type: 'opened'; code: string };                         // -> { ok: boolean }, from the open page

// From the service worker to the content script: show the UI, or hide it when it shows.
export type ToContent = { type: 'toggle' };
