import { join } from 'node:path';
import { VERSION } from '../../shared/version.ts';
import { stateDir } from './paths.ts';
import { present } from './presence.ts';
import { readRecord, removeRecord, writeRecord } from './store.ts';

// The number of the form of the state folder. A bridge of another format reads and writes it in
// another way, so it is another bridge, as one of another version is.
export const STATE_FORMAT = 1;
// The key of the bridge's beacon: there is one bridge per state folder.
export const BRIDGE_KEY = 'bridge';

// What the bridge that runs says of itself: its process, its version, the format of the state
// folder it uses, the port it listens on, and whether a command started it.
export interface BridgeRecord { pid: number; version: string; format: number; port: number; auto: boolean }

// A problem a bridge that could not start notes for the command that started it.
type BridgeProblem = 'port_in_use';

// The bridge as the commands see it: running when it is this version's, other when it lives and is
// of another version or format, down with the problem noted when no bridge lives.
export type BridgeSeen =
  | { state: 'running'; record: BridgeRecord }
  | { state: 'other'; record: BridgeRecord }
  | { state: 'down'; problem: BridgeProblem | null };

const PROBLEMS: readonly unknown[] = ['port_in_use'] satisfies BridgeProblem[];

// The files in the state folder: the bridge's record, the problem noted, and the stop request.
function recordPath(): string {
  return join(stateDir(), 'bridge.json');
}

function problemPath(): string {
  return join(stateDir(), 'problem.json');
}

function stopPath(): string {
  return join(stateDir(), 'stop.json');
}

// Writes the bridge's record, and clears a problem that was noted: a bridge runs.
export function writeBridgeRecord(record: BridgeRecord): void {
  writeRecord(recordPath(), record);
  removeRecord(problemPath());
}

// Removes the bridge's record when it names the process `pid`. A record of another process, one
// that cannot be read, and none, are left as they are.
export function clearOwnRecord(pid: number): void {
  if (readBridgeRecord()?.pid === pid) removeRecord(recordPath());
}

// Notes the problem for which a bridge could not start. The bridge's record is left as it is.
export function noteProblem(problem: BridgeProblem): void {
  writeRecord(problemPath(), { problem });
}

// Removes the problem noted. The bridge's record is left as it is; a note that is not there
// changes nothing.
export function clearProblem(): void {
  removeRecord(problemPath());
}

// The bridge at `now`. Running or other only when the record is there with fields of the right
// type and the bridge's beacon beat no longer than STALE_MS before `now`; running when the record
// is of this VERSION and STATE_FORMAT. Else down, with the problem noted, or null for none or for
// a note that is not a known problem. Never throws.
export function seeBridge(now: number = Date.now()): BridgeSeen {
  const record = readBridgeRecord();
  if (record && present('bridge', BRIDGE_KEY, now)) {
    const state = record.version === VERSION && record.format === STATE_FORMAT ? 'running' : 'other';
    return { state, record };
  }
  return { state: 'down', problem: readProblem() };
}

// Asks the bridge that runs to stop.
export function requestStop(): void {
  writeRecord(stopPath(), {});
}

// Whether a stop is requested: the request is there as a record.
export function stopRequested(): boolean {
  return readRecord(stopPath()) !== undefined;
}

// Removes the stop request. A request that is not there changes nothing.
export function clearStop(): void {
  removeRecord(stopPath());
}

// The bridge's record, with its own fields only. Null when it is missing, not a record, or has a
// field of the wrong type: a pid that is not a positive whole number, a port outside 1 to 65535.
// Never throws.
export function readBridgeRecord(): BridgeRecord | null {
  const value = readRecord(recordPath());
  if (typeof value !== 'object' || value === null) return null;
  const { pid, version, format, port, auto } = value as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0
    || typeof version !== 'string'
    || typeof format !== 'number' || !Number.isSafeInteger(format)
    || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535
    || typeof auto !== 'boolean') return null;
  return { pid, version, format, port, auto };
}

// The problem noted, or null for none and for a note that is not a known problem.
function readProblem(): BridgeProblem | null {
  const value = readRecord(problemPath());
  if (typeof value !== 'object' || value === null) return null;
  const { problem } = value as Record<string, unknown>;
  return PROBLEMS.includes(problem) ? problem as BridgeProblem : null;
}
