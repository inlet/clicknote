import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.ts';
import { removeRecord, writeRecord } from './store.ts';

// What a beacon says is alive for its key: an agent's wait, or the bridge.
export type BeaconKind = 'wait' | 'bridge';

// A beacon beats every BEAT_MS; one that was not beaten for longer than STALE_MS is stale.
export const BEAT_MS = 5_000;
export const STALE_MS = 15_000;

const KINDS: readonly string[] = ['wait', 'bridge'] satisfies BeaconKind[];
const KEY = /^[0-9a-z]{1,40}$/;
// The name of a beacon's file, <kind>.<key>.<pid>. The temporary file of a write does not match.
const NAME = /^([a-z]+)\.([0-9a-z]{1,40})\.([1-9][0-9]*)$/;

// The beacons' own folder in the state folder.
function beaconsFolder(): string {
  return join(stateDir(), 'beacons');
}

// Writes the beacon of this kind and key for the process now, and again every BEAT_MS on a timer
// that does not keep the process alive. Each beat writes the file anew, so its modification time is
// the time of the beat, and a beacon that was pruned while the process lives comes back. The first
// write makes the folders it needs and throws when it fails; a later beat that fails, or that finds
// the beacons' folder gone, writes nothing and throws nothing, and the beacon goes stale. The path
// is fixed at the start. `stop` ends the timer and removes the beacon, once: a second call does
// nothing. Throws a TypeError for a kind, a key or a pid that cannot name a beacon's file.
export function startBeacon(kind: BeaconKind, key: string, pid: number = process.pid): { stop(): void } {
  if (!KINDS.includes(kind)) throw new TypeError(`Not a kind of beacon: ${JSON.stringify(kind)}`);
  if (typeof key !== 'string' || !KEY.test(key)) throw new TypeError(`Not a beacon key: ${JSON.stringify(key)}`);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`Not a process id: ${pid}`);
  const folder = beaconsFolder();
  const path = join(folder, `${kind}.${key}.${pid}`);
  // The file says nothing: its modification time is the beat.
  writeRecord(path, {});
  const timer = setInterval(() => {
    try {
      if (lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) writeRecord(path, {});
    } catch {
      // A beacon that cannot beat goes stale.
    }
  }, BEAT_MS);
  timer.unref();
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        removeRecord(path);
      } catch {
        // A beacon that cannot be removed goes stale.
      }
    },
  };
}

// Whether a beacon of this kind and key, of any process, was beaten no longer than STALE_MS before
// `now`. Only a regular file counts. Never throws.
export function present(kind: BeaconKind, key: string, now: number = Date.now()): boolean {
  const folder = beaconsFolder();
  return names(folder).some(name => {
    const match = NAME.exec(name);
    return match?.[1] === kind && match[2] === key && fresh(join(folder, name), now);
  });
}

// Removes every file in the beacons' folder that is stale at `now`: the beacons of processes that
// are gone, and a temporary file a write left behind.
export function pruneBeacons(now: number = Date.now()): void {
  const folder = beaconsFolder();
  for (const name of names(folder)) {
    const path = join(folder, name);
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats?.isFile() && now - stats.mtimeMs > STALE_MS) rmSync(path, { force: true });
  }
}

// Whether the regular file at this path was modified no longer than STALE_MS before `now`.
function fresh(path: string, now: number): boolean {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    return stats?.isFile() === true && now - stats.mtimeMs <= STALE_MS;
  } catch {
    return false;
  }
}

// The names in this folder. None when it is missing or cannot be read.
function names(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}
