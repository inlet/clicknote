import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentLabel } from '../../shared/label.ts';
import { stateDir } from './paths.ts';
import { present } from './presence.ts';
import { readRecord, removeRecord, writeRecord } from './store.ts';

// The form of an agent id: 12 hexadecimal characters.
export const AGENT_ID = /^[0-9a-f]{12}$/;
// An agent is listed for this long after its last sign of life.
export const AGENT_TTL_MS = 3_600_000;
// An agent's record is removed when the agent was not seen for this long.
export const AGENT_KEEP_MS = 7 * 24 * 3_600_000;
// The most characters (code points) of one part of an agent's label.
export const PART_MAX = 60;

// An agent that registered, as its record holds it. `about` is what it says it works on, `folder`
// the last part of its project folder. `registered` and `seen` are times in milliseconds: when it
// registered, and its last sign of life. `left` is there, and true, when a wait of the agent was
// stopped from outside after its last sign of life (see leaveAgent).
export interface Agent {
  id: string; harness: string; about: string; folder: string;
  registered: number; seen: number;
  left?: true;
}

// An agent as the bar lists it.
export interface ListedAgent {
  id: string; folder: string; about: string; harness: string;
  number: number | null;      // 2, 3, … for a later agent that reads the same as an earlier one
  waiting: boolean;
}

// The name of an agent's record file.
const RECORD_NAME = /^([0-9a-f]{12})\.json$/;
const CONTROL = /[\p{Cc}\p{Cf}]/gu;
const SPACE = /\p{White_Space}+/gu;

// The agents' own folder in the state folder.
function agentsFolder(): string {
  return join(stateDir(), 'agents');
}

function agentPath(id: string): string {
  return join(agentsFolder(), `${id}.json`);
}

// The text as one clean line: white space, also a control character that is white space such as a
// tab or a line break, becomes a space; the other control and format characters are removed; each
// run of spaces becomes one; the ends are trimmed; and the text is cut to PART_MAX code points.
export function cleanPart(text: string): string {
  const line = text.replace(SPACE, ' ').replace(CONTROL, '').replace(SPACE, ' ').trim();
  return Array.from(line).slice(0, PART_MAX).join('').trimEnd();
}

// Registers a new agent under a new id and returns it. `folder` is stored as the last part of the
// path given, after the last `/` or `\`, and every part is cleaned.
export function registerAgent(
  input: { harness: string; about: string; folder: string },
  now: number = Date.now(),
): Agent {
  let id: string;
  do id = randomBytes(6).toString('hex');
  while (lstatSync(agentPath(id), { throwIfNoEntry: false }));
  const agent: Agent = {
    id,
    harness: cleanPart(input.harness),
    about: cleanPart(input.about),
    folder: cleanPart(lastPart(input.folder)),
    registered: now,
    seen: now,
  };
  writeRecord(agentPath(id), agent);
  return agent;
}

// A sign of life of the agent: sets its last sign of life to `now`, takes away that it left, and,
// when `about` is given, sets what it works on. The agent as it is now; null for an id of another
// form or without a record.
export function seenAgent(id: string, about?: string, now: number = Date.now()): Agent | null {
  const agent = readAgent(id);
  if (!agent) return null;
  agent.seen = now;
  delete agent.left;
  if (about !== undefined) agent.about = cleanPart(about);
  writeRecord(agentPath(id), agent);
  return agent;
}

// Marks the agent as left, as a wait of it that is stopped from outside does: it is listed only
// while a wait of it is open, until its next sign of life. Its last sign of life stays as it is,
// so its record is kept as long as before. An id of another form, or without a record, changes
// nothing.
export function leaveAgent(id: string): void {
  const agent = readAgent(id);
  if (agent) writeRecord(agentPath(id), { ...agent, left: true });
}

// The agent with this id. Null for an id of another form, and for a record that is missing or
// that does not fit: of another id, with a field of the wrong type, or with a `left` that is not
// true.
export function readAgent(id: string): Agent | null {
  if (!AGENT_ID.test(id)) return null;
  const value = readRecord(agentPath(id));
  if (typeof value !== 'object' || value === null) return null;
  const { harness, about, folder, registered, seen, left } = value as Record<string, unknown>;
  if ((value as Record<string, unknown>).id !== id
    || typeof harness !== 'string' || typeof about !== 'string' || typeof folder !== 'string'
    || typeof registered !== 'number' || !Number.isFinite(registered)
    || typeof seen !== 'number' || !Number.isFinite(seen)
    || (left !== undefined && left !== true)) return null;
  const agent: Agent = { id, harness, about, folder, registered, seen };
  if (left) agent.left = true;
  return agent;
}

// Removes the agent's record. An id of another form, or without a record, changes nothing.
export function removeAgent(id: string): void {
  if (AGENT_ID.test(id)) removeRecord(agentPath(id));
}

// The agents to list at `now`, oldest registration first, then by id. An agent is listed while it
// waits, and, unless it left, for AGENT_TTL_MS after its last sign of life. Of the agents that
// read the same, each later one gets a number.
export function listAgents(now: number = Date.now()): ListedAgent[] {
  const listed = agentIds()
    .map(readAgent)
    .filter((agent): agent is Agent => agent !== null)
    .map(agent => ({ agent, waiting: present('wait', agent.id, now) }))
    .filter(({ agent, waiting }) => waiting || (!agent.left && now - agent.seen <= AGENT_TTL_MS))
    .sort((a, b) => a.agent.registered - b.agent.registered || compare(a.agent.id, b.agent.id));
  const counts = new Map<string, number>();
  return listed.map(({ agent: { id, folder, about, harness }, waiting }) => {
    const label = agentLabel({ folder, about, harness, number: null });
    const count = (counts.get(label) ?? 0) + 1;
    counts.set(label, count);
    return { id, folder, about, harness, number: count > 1 ? count : null, waiting };
  });
}

// Removes the record of every agent whose last sign of life is more than AGENT_KEEP_MS before
// `now`. A file that is not an agent's record is left as it is.
export function pruneAgents(now: number = Date.now()): void {
  for (const id of agentIds()) {
    const agent = readAgent(id);
    if (agent && now - agent.seen > AGENT_KEEP_MS) removeRecord(agentPath(id));
  }
}

// The ids of the record files in the agents' folder. None when it is missing or cannot be read.
function agentIds(): string[] {
  let names: string[];
  try {
    names = readdirSync(agentsFolder());
  } catch {
    return [];
  }
  return names.flatMap(name => RECORD_NAME.exec(name)?.[1] ?? []);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The last part of a path, after the last `/` or `\`; a separator at the end is passed over.
function lastPart(path: string): string {
  return path.split(/[\\/]/).filter(part => part !== '').at(-1) ?? '';
}
