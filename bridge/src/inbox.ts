import {
  closeSync, fchmodSync, lstatSync, openSync, readdirSync, renameSync, rmdirSync, statSync, watch, type FSWatcher,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './paths.ts';
import { AGENT_ID, readAgent } from './registry.ts';
import { makeFolders, readRecord, removeRecord, writeRecord } from './store.ts';

// A send that waits in an agent's inbox: its id, its folder, the line that names it to the agent,
// and when it was queued, in milliseconds.
export interface Queued { send: string; folder: string; line: string; at: number }
export type SendState = 'queued' | 'picked_up' | 'unknown';

// A send handed out and not confirmed is offered again this long after it was handed out, or
// sooner when the process it was handed to is gone.
export const CLAIM_MS = 60_000;
// A send's record is removed this long after the send was queued, whatever its state.
export const INBOX_KEEP_MS = 7 * 24 * 3_600_000;
// A temporary file of a write, or a claim's lock, that was last changed longer ago than this was
// left by a process that ended in the middle of the write or the claim, and is removed.
const LEFTOVER_MS = 24 * 3_600_000;

// The form of the id of a send: 16 hexadecimal characters.
export const SEND_ID = /^[0-9a-f]{16}$/;

// The names of a send's record in its agent's folder. The state of a send is in the name of its
// record, and what the record holds never changes, so each change of state is one rename:
// - <send>.json: queued;
// - <send>.claimed.<pid>.<time>: handed out to that process at that time, and not confirmed;
// - <send>.picked.<time>: picked up, confirmed at that time.
// The temporary file of a write does not match.
const QUEUED = /^([0-9a-f]{16})\.json$/;
const CLAIMED = /^([0-9a-f]{16})\.claimed\.([1-9][0-9]*)\.(-?[0-9]+)$/;
const PICKED = /^([0-9a-f]{16})\.picked\.(-?[0-9]+)$/;
// The name of the temporary file of a write of a send's record: <send>.json.<pid>.tmp, next to the
// record (see writeRecord).
const TEMPORARY = /^[0-9a-f]{16}\.json\.[0-9]+\.tmp$/;

// The most times a send's record is looked up when another process renames it while it is read or moved.
const TRIES = 5;

// The lock that a claim holds in the agent's folder. Its name is no record's name, so what lists
// the folder passes over it.
const LOCK = 'claim.lock';
// A claim that finds the lock held tries again every LOCK_TRY_MS, for at most LOCK_WAIT_MS.
const LOCK_WAIT_MS = 1_000;
const LOCK_TRY_MS = 20;
// A lock whose modification time lies further than this from now, before or after it, is stale.
// Holding the lock takes far less than a second, so a lock made that long ago was left by a
// process that ended while it held it, and one made that far ahead was made before the clock was
// set back.
const LOCK_STALE_MS = 5_000;
// The lock is user-only, as every file in the state folder.
const LOCK_MODE = 0o600;
// What a claim waits on between two tries for the lock. Nothing wakes it, so each wait runs out.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

type Hold =
  | { state: 'queued' }
  | { state: 'claimed'; pid: number; since: number }
  | { state: 'picked'; since: number };

// A file in an agent's folder whose name is that of a send's record.
interface Entry { send: string; path: string; hold: Hold }

// The inbox folder in the state folder, with a folder per agent.
function inboxFolder(): string {
  return join(stateDir(), 'inbox');
}

function agentFolder(agent: string): string {
  return join(inboxFolder(), agent);
}

// Queues the send for the agent at `now`. A send that an inbox already holds is left as it is,
// so there is one record per send. Throws a TypeError for an agent id or a send id of another
// form, a folder or a line that is not text, and a time that is not a number.
export function enqueue(agent: string, item: { send: string; folder: string; line: string }, now: number = Date.now()): void {
  if (typeof agent !== 'string' || !AGENT_ID.test(agent)) throw new TypeError(`Not an agent id: ${JSON.stringify(agent)}`);
  const { send, folder, line } = item;
  if (typeof send !== 'string' || !SEND_ID.test(send)) throw new TypeError(`Not a send id: ${JSON.stringify(send)}`);
  if (typeof folder !== 'string' || typeof line !== 'string') throw new TypeError('A send needs a folder and a line.');
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError(`Not a time: ${now}`);
  if (sendState(send) !== 'unknown') return;
  const queued: Queued = { send, folder, line, at: now };
  writeRecord(join(agentFolder(agent), `${send}.json`), queued);
}

// Makes the agent's inbox folder, and the folders above it, user-only, when they are not there, so
// that a wait can watch the folder before the first send to the agent is queued. A folder that is
// there is left as it is. Throws a TypeError for an agent id of another form.
export function makeInbox(agent: string): void {
  if (typeof agent !== 'string' || !AGENT_ID.test(agent)) throw new TypeError(`Not an agent id: ${JSON.stringify(agent)}`);
  makeFolders(agentFolder(agent));
}

// Hands out every send of the agent that is not picked up and not held by a live claim, oldest
// first, and claims each for the process `pid` at `now`. A claim is the rename of the send's
// record to a claimed name. Where a rename goes by the file's name, as on macOS and Linux, of two
// processes that rename one record one succeeds and the other finds it gone. On Windows a rename
// opens the file and then renames what it opened, so two processes that have both opened the
// record both succeed, and the rename alone does not decide who gets the send. That is decided by
// the agent's lock, which one process at a time holds on every system: the claim holds it while
// it looks at the inbox and renames, and removes it however the claim ends. A claim that does not
// get the lock within LOCK_WAIT_MS gives none this time. When a rename fails for another reason
// than a record that is gone, the sends claimed so far are given back and the error thrown on.
// None for an agent id of another form, and for an agent without an inbox, for which nothing is
// made; throws a TypeError for a pid or a time that cannot be written in a record's name.
export function claim(agent: string, pid: number = process.pid, now: number = Date.now()): Queued[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`Not a process id: ${pid}`);
  const stamp = timeStamp(now);
  if (typeof agent !== 'string' || !AGENT_ID.test(agent)) return [];
  const lock = takeLock(agentFolder(agent));
  if (lock === null) return [];
  try {
    const claimed: Queued[] = [];
    for (const { entry, queued } of offered(agent, now)) {
      try {
        renameSync(entry.path, join(dirname(entry.path), `${entry.send}.claimed.${pid}.${stamp}`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        try {
          release(agent, claimed.map(queued => queued.send));
        } catch {
          // The error of the claim is the one to give.
        }
        throw error;
      }
      claimed.push(queued);
    }
    return claimed;
  } finally {
    try {
      removeRecord(lock);
    } catch {
      // The sends or the error of the claim are the ones to give; a lock that is left is stale
      // after LOCK_STALE_MS, and the next claim removes it.
    }
  }
}

// Takes the lock in this agent's folder: makes the file LOCK in it, which fails while the file is
// there, for every process at once. While another process holds the lock, or on Windows while a
// lock is being removed (see beingRemoved), tries again every LOCK_TRY_MS, for at most
// LOCK_WAIT_MS; a lock that is stale is removed and taken. The path of the lock once it is taken.
// Null when the folder is not there, for which nothing is made, and when the lock is still held
// after LOCK_WAIT_MS. When making the lock still fails after LOCK_WAIT_MS for an error that
// beingRemoved accepts, the lock is not being removed, and that error is thrown.
function takeLock(folder: string): string | null {
  const lock = join(folder, LOCK);
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lock, 'wx', LOCK_MODE);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      const removing = beingRemoved(error);
      if (code !== 'EEXIST' && !removing) throw error;
      if (performance.now() >= deadline) {
        if (removing) throw error;
        return null;
      }
      // A lock that is being removed is waited for as one that is held.
      const state = removing ? 'held' : lockState(lock);
      // A lock that is gone in the meantime is tried again at once.
      if (state === 'gone') continue;
      if (state === 'stale') {
        // A stale lock is removed and tried again at once. Two processes that find it stale at the
        // same moment may both remove it, the second after the first has taken it anew, and then
        // both hold it. That needs a process that ended inside a claim and two claims in the same
        // instant after it, and gives at worst a send that is handed out twice, as a claim that
        // runs out also may.
        removeRecord(lock);
        continue;
      }
      Atomics.wait(PAUSE, 0, 0, LOCK_TRY_MS);
      continue;
    }
    try {
      try {
        fchmodSync(fd, LOCK_MODE);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      try {
        removeRecord(lock);
      } catch {
        // The error of the lock is the one to give.
      }
      throw error;
    }
    return lock;
  }
}

// What the lock at this path is, by its modification time: gone, stale (see LOCK_STALE_MS), or
// held. A lock whose time cannot be read for an error that beingRemoved accepts is held: it is
// waited for.
function lockState(lock: string): 'gone' | 'stale' | 'held' {
  let made: number | undefined;
  try {
    made = statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
  } catch (error) {
    if (beingRemoved(error)) return 'held';
    throw error;
  }
  if (made === undefined) return 'gone';
  return Math.abs(Date.now() - made) > LOCK_STALE_MS ? 'stale' : 'held';
}

// Whether this error of making or reading the lock may come from a lock that is being removed.
// While another process has a removed file open, as one that reads the lock's time does for a
// moment, Windows keeps the file in its folder until that process closes it, and opening it fails
// with EPERM or EACCES in the meantime. On other systems a removed file is gone at once, so these
// errors are a problem of permission there.
function beingRemoved(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
}

// Marks the sends as picked up at `now`, claimed or not. A send that the agent's inbox does not
// hold, or that is picked up already, is passed over.
export function confirm(agent: string, sends: string[], now: number = Date.now()): void {
  const stamp = timeStamp(now);
  for (const send of sends) move(agent, send, ['queued', 'claimed'], `${send}.picked.${stamp}`);
}

// Gives the claimed sends back to the agent's inbox, to be handed out again. A send that the
// agent's inbox does not hold, or that is not claimed, is passed over.
export function release(agent: string, sends: string[]): void {
  for (const send of sends) move(agent, send, ['claimed'], `${send}.json`);
}

// The state of the send in whichever inbox holds it: picked up once it is confirmed, queued until
// then, whether it is claimed or not, and unknown when no inbox holds it or for an id of another form.
export function sendState(send: string): SendState {
  if (typeof send !== 'string' || !SEND_ID.test(send)) return 'unknown';
  for (const agent of agentIds()) {
    const found = find(agent, send);
    if (found) return found.entry.hold.state === 'picked' ? 'picked_up' : 'queued';
  }
  return 'unknown';
}

// The state of the send in this agent's inbox, with the send's line: picked up once it is
// confirmed, queued until then, whether it is claimed or not. Looks in no other agent's inbox.
// Null for an agent id or a send id of another form, for an agent without an inbox, and for a
// send that the agent's inbox does not hold.
export function inboxState(agent: string, send: string): { state: 'queued' | 'picked_up'; line: string } | null {
  if (typeof send !== 'string' || !SEND_ID.test(send)) return null;
  const found = find(agent, send);
  if (!found) return null;
  return { state: found.entry.hold.state === 'picked' ? 'picked_up' : 'queued', line: found.queued.line };
}

// The number of the agent's sends that are not picked up, claimed or not.
export function queuedFor(agent: string): number {
  return entries(agent).filter(entry => entry.hold.state !== 'picked' && readQueued(entry)).length;
}

// Resolves true as soon as `claim` would hand out a send to the agent: at once when it already
// would, else on a change in the agent's folder, which is watched, or at a look every `pollMs`,
// which also sees a claim that runs out and stands in for a watch that cannot be started or that
// fails. The look every pollMs first starts the watch when it is not running, so a folder that is
// made later is watched from then on. Resolves false when the signal ends the waiting, or has ended it
// already. However it ends, the watch, the timer and the listener on the signal are gone.
export function waitForSend(agent: string, signal: AbortSignal, pollMs: number = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(false);
    if (claimable(agent)) return resolve(true);
    const folder = typeof agent === 'string' && AGENT_ID.test(agent) ? agentFolder(agent) : null;
    let watcher: FSWatcher | null = null;
    let ended = false;
    const end = (got: boolean): void => {
      ended = true;
      clearInterval(timer);
      signal.removeEventListener('abort', stop);
      unwatch();
      resolve(got);
    };
    const look = (): void => {
      if (!ended && claimable(agent)) end(true);
    };
    const unwatch = (): void => {
      watcher?.close();
      watcher = null;
    };
    const startWatch = (): void => {
      if (watcher || folder === null) return;
      try {
        const started = watch(folder, look);
        // A watch that fails is closed; the next look starts a new one.
        started.on('error', () => {
          started.close();
          if (watcher === started) watcher = null;
        });
        watcher = started;
      } catch {
        // The look every pollMs stands in for the watch.
      }
    };
    const stop = (): void => end(false);
    const timer = setInterval(() => {
      startWatch();
      look();
    }, pollMs);
    signal.addEventListener('abort', stop, { once: true });
    startWatch();
    // A send queued before the watch started.
    look();
  });
}

// In each agent's folder, removes the record of every send queued more than INBOX_KEEP_MS before
// `now`, whatever its state, and the temporary files of writes and the claim's lock when they were
// last changed more than LEFTOVER_MS before `now`. Then removes the folder of an agent that has no
// record any more when nothing is left in it. The folder of a registered agent stays, empty or
// not: a wait of that agent watches it. Any other file is left as it is.
// A lock is removed by its path after its time is read. When a claim finds that lock stale in
// between, removes it and takes the lock anew, its new lock is removed here. That needs a lock left
// for a day and a claim at that instant, and gives at worst a send that is handed out twice, as a
// stale lock may.
export function pruneInbox(now: number = Date.now()): void {
  for (const agent of agentIds()) {
    for (const entry of entries(agent)) {
      const queued = readQueued(entry);
      if (queued && now - queued.at > INBOX_KEEP_MS) removeRecord(entry.path);
    }
    const folder = agentFolder(agent);
    for (const name of names(folder)) {
      if (name !== LOCK && !TEMPORARY.test(name)) continue;
      const path = join(folder, name);
      const stats = lstatSync(path, { throwIfNoEntry: false });
      if (stats?.isFile() && now - stats.mtimeMs > LEFTOVER_MS) removeRecord(path);
    }
    if (readAgent(agent) === null) removeIfEmpty(folder);
  }
}

// Removes this folder when it is empty. A folder that is not empty is left as it is, so a send
// queued in the meantime keeps it; so is one that cannot be removed for another reason, such as one
// that Windows holds while it is watched, which the next prune tries again, and does not stop the
// prune of the other folders.
function removeIfEmpty(folder: string): void {
  try {
    rmdirSync(folder);
  } catch {
    // Left as it is.
  }
}

// Whether `claim` would hand out a send to the agent now.
function claimable(agent: string): boolean {
  return offered(agent, Date.now()).length > 0;
}

// The sends of the agent that are not picked up and not held by a live claim at `now`, with what
// their records hold, oldest first, then by id.
function offered(agent: string, now: number): { entry: Entry; queued: Queued }[] {
  return entries(agent)
    .filter(entry => entry.hold.state === 'queued' || (entry.hold.state === 'claimed' && !live(entry.hold, now)))
    .flatMap(entry => {
      const queued = readQueued(entry);
      return queued ? [{ entry, queued }] : [];
    })
    .sort((a, b) => a.queued.at - b.queued.at || compare(a.entry.send, b.entry.send));
}

// Whether a claim holds its send at `now`: it was made no longer than CLAIM_MS before, and its
// process exists. Only a process that is not there makes a claim lapse sooner; one that exists
// and may not be signalled by this one still holds it.
function live(hold: { pid: number; since: number }, now: number): boolean {
  if (now - hold.since > CLAIM_MS) return false;
  try {
    process.kill(hold.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

// Renames the agent's record of this send to `to` when the send is in one of the states `from`.
// A record that another process renames in the meantime is looked up again.
function move(agent: string, send: string, from: readonly Hold['state'][], to: string): void {
  if (typeof send !== 'string' || !SEND_ID.test(send)) return;
  for (let tries = 0; tries < TRIES; tries++) {
    const found = find(agent, send);
    if (!found || !from.includes(found.entry.hold.state)) return;
    try {
      renameSync(found.entry.path, join(dirname(found.entry.path), to));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

// The agent's record of this send, with what it holds. A record that cannot be read is looked up
// again, as another process may have renamed it in between; null when none fits.
function find(agent: string, send: string): { entry: Entry; queued: Queued } | null {
  for (let tries = 0; tries < TRIES; tries++) {
    const entry = entries(agent).find(entry => entry.send === send);
    if (!entry) return null;
    const queued = readQueued(entry);
    if (queued) return { entry, queued };
  }
  return null;
}

// What a send's record holds. Null when it cannot be read, or when it does not fit: of another
// send than its name says, or with a field of the wrong type.
function readQueued(entry: Entry): Queued | null {
  const value = readRecord(entry.path);
  if (typeof value !== 'object' || value === null) return null;
  const { send, folder, line, at } = value as Record<string, unknown>;
  if (send !== entry.send || typeof folder !== 'string' || typeof line !== 'string'
    || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { send: entry.send, folder, line, at };
}

// The files in the agent's folder whose names are those of a send's record. None for an agent
// id of another form, or when the folder is missing or cannot be read.
function entries(agent: string): Entry[] {
  if (typeof agent !== 'string' || !AGENT_ID.test(agent)) return [];
  const folder = agentFolder(agent);
  return names(folder).flatMap(name => {
    const entry = parse(folder, name);
    return entry ? [entry] : [];
  });
}

// The send and its state that this name of a file in `folder` says. Null for another name.
function parse(folder: string, name: string): Entry | null {
  const path = join(folder, name);
  const queued = QUEUED.exec(name);
  if (queued) return { send: queued[1], path, hold: { state: 'queued' } };
  const claimed = CLAIMED.exec(name);
  if (claimed) {
    const pid = Number(claimed[2]);
    const since = Number(claimed[3]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(since)) return null;
    return { send: claimed[1], path, hold: { state: 'claimed', pid, since } };
  }
  const picked = PICKED.exec(name);
  if (picked) {
    const since = Number(picked[2]);
    if (!Number.isSafeInteger(since)) return null;
    return { send: picked[1], path, hold: { state: 'picked', since } };
  }
  return null;
}

// The ids of the agents' folders in the inbox folder.
function agentIds(): string[] {
  return names(inboxFolder()).filter(name => AGENT_ID.test(name));
}

// The names in this folder. None when it is missing or cannot be read.
function names(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

// A time as it is written in a record's name: whole milliseconds. Throws a TypeError for a time
// that cannot be written so.
function timeStamp(now: number): number {
  const stamp = Math.floor(now);
  if (!Number.isSafeInteger(stamp)) throw new TypeError(`Not a time: ${now}`);
  return stamp;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
