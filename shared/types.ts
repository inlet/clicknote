export type Intent = 'change' | 'question';
export interface Rect { x: number; y: number; width: number; height: number }

export interface Annotation {
  id: string;                      // stable, 8 characters
  number: number;                  // 1-based position in the list
  intent: Intent;
  comment: string;
  label: string;                   // div "01 Fn Hold your hotkey…" 1132x499
  selector: string;
  domPath: string;
  text: string;                    // at most 500 characters
  html: string;                    // at most 2,000 characters
  rect: Rect;                      // CSS pixels, relative to the viewport when the element was picked
  styles: Record<string, string>;
  screenshot: string | null;       // file name; the bridge fills it in
}

export interface PageInfo {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  sourceFile: string | null;       // local path for file:// pages
}

export interface SendPayload {
  page: PageInfo;
  note: string;                    // the general comment
  annotations: Annotation[];
  images: Record<string, string>;  // annotation id -> base64 PNG, no data: prefix
}

// An agent as the bar lists it. Every part is cleaned and cut by the bridge.
export interface AgentInfo {
  id: string;             // 12 hexadecimal characters
  folder: string;         // the name of its project folder
  about: string;          // what it says it works on; may be empty
  harness: string;        // may be empty
  number: number | null;  // set when another agent reads the same
  waiting: boolean;       // a wait of it is open now
}

export type ErrorKind = 'bridge_down' | 'version_mismatch' | 'agent_gone' | 'failed';

// How a send stands. `agent_gone`: it is queued, and its agent is no longer listed.
// `unknown`: the bridge holds no send with this id for this agent.
export type SendStatus = 'picked_up' | 'queued' | 'agent_gone' | 'unknown';

// What the extension asks the bridge. BridgeResponse is what the bridge answers.
export type BridgeRequest =
  | { type: 'agents'; url: string }
  | { type: 'send'; id: string; agent: string; send: SendPayload }
  | { type: 'copy'; send: SendPayload }
  | { type: 'opened'; code: string }
  | { type: 'state'; id: string; agent: string };

// The answer to an `agents` request.
export interface AgentsOk { ok: true; agents: AgentInfo[]; preselect: string | null }

// The answer to a `send` or `copy` request.
export interface SentOk { ok: true; folder: string; line: string; agent?: string }

// The answer to an `opened` request: the page the link with that code opens, and the id of the
// agent it was made for.
export interface OpenedOk { ok: true; url: string; agent: string }

// The answer to a `state` request. `line` is the send's line, null for `unknown`.
export interface StateOk { ok: true; state: SendStatus; line: string | null }

export interface BridgeError { ok: false; kind: ErrorKind; message: string }

export type BridgeResponse = AgentsOk | SentOk | OpenedOk | StateOk | BridgeError;

// What goes over HTTP, in both directions.
export interface Envelope<T> { protocol: number; version: string; body: T }

// The version of the protocol between the extension and the bridge.
export const PROTOCOL = 2;

// Where the bridge listens. The test build of the extension uses BRIDGE_PORT_E2E.
export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_PORT = 47823;
export const BRIDGE_PORT_E2E = 47824;
export const BRIDGE_PATH = '/bridge';

// What the bar tells the user to say to an agent when none is listed.
export const WAIT_SENTENCE = 'Wait for my annotations with the clicknote skill.';

export const STYLE_PROPS = ['font-family', 'font-size', 'font-weight', 'line-height',
  'color', 'background-color', 'margin', 'padding', 'display'] as const;
