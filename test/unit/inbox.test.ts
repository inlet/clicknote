import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  CLAIM_MS, INBOX_KEEP_MS, claim, confirm, enqueue, inboxState, makeInbox, pruneInbox, queuedFor, release, sendState,
  waitForSend,
} from '../../bridge/src/inbox.ts';
import { registerAgent } from '../../bridge/src/registry.ts';

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

// The files under the state folder, at any depth, whose name starts with a send id.
function inboxFiles(): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(path => /^[0-9a-f]{16}\./.test(basename(path)))
    .map(path => join(dir, path));
}

const INBOX_URL = pathToFileURL(join(import.meta.dirname, '../../bridge/src/inbox.ts')).href;
const run = promisify(execFile);

const AGENT = 'aaaaaaaaaaaa';
const item = (n: number) => ({ send: `000000000000000${n}`, folder: `/s/${n}`, line: `line ${n}` });

test('queued sends are claimed once, oldest first', () => {
  enqueue(AGENT, item(2), 200);
  enqueue(AGENT, item(1), 100);
  assert.deepEqual(claim(AGENT).map(queued => queued.line), ['line 1', 'line 2']);
  assert.deepEqual(claim(AGENT), []);
  assert.deepEqual(claim('bbbbbbbbbbbb'), []);
});

test('a confirmed send is picked up and is not offered again', () => {
  enqueue(AGENT, item(1));
  assert.equal(sendState(item(1).send), 'queued');
  claim(AGENT);
  assert.equal(sendState(item(1).send), 'queued');
  confirm(AGENT, [item(1).send]);
  assert.equal(sendState(item(1).send), 'picked_up');
  assert.deepEqual(claim(AGENT, process.pid, Date.now() + CLAIM_MS + 1), []);
  assert.equal(queuedFor(AGENT), 0);
});

test('a send claimed by a process that is gone is offered again at once', () => {
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  enqueue(AGENT, item(1));
  assert.equal(claim(AGENT, gone).length, 1);
  assert.equal(claim(AGENT).length, 1);
});

test('a claim that is a minute old is offered again', () => {
  enqueue(AGENT, item(1));
  claim(AGENT, process.pid, 1_000);
  assert.deepEqual(claim(AGENT, process.pid, 1_000 + CLAIM_MS), []);
  assert.equal(claim(AGENT, process.pid, 1_000 + CLAIM_MS + 1).length, 1);
});

test('a released send is offered again', () => {
  enqueue(AGENT, item(1));
  claim(AGENT);
  release(AGENT, [item(1).send]);
  assert.equal(claim(AGENT).length, 1);
});

test('a send no inbox holds is unknown, and ids of another form are refused or nothing', () => {
  assert.equal(sendState('0000000000000009'), 'unknown');
  assert.equal(sendState('../x'), 'unknown');
  assert.throws(() => enqueue('../x', item(1)), TypeError);
  assert.throws(() => enqueue(AGENT, { ...item(1), send: 'x' }), TypeError);
  assert.deepEqual(claim('../x'), []);
});

test('waiting ends at once when a send is there, and when one arrives', async () => {
  enqueue(AGENT, item(1));
  assert.equal(await waitForSend(AGENT, new AbortController().signal), true);
  claim(AGENT);
  confirm(AGENT, [item(1).send]);
  const waiting = waitForSend(AGENT, new AbortController().signal, 50);
  setTimeout(() => enqueue(AGENT, item(2)), 100);
  assert.equal(await waiting, true);
});

test('makeInbox makes the agent\'s folder user-only, and leaves one that is there as it is', () => {
  const folder = join(dir, 'inbox', AGENT);
  makeInbox(AGENT);
  assert.equal(statSync(folder).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(dir, 'inbox')).mode & 0o777, 0o700);
    assert.equal(statSync(folder).mode & 0o777, 0o700);
  }
  enqueue(AGENT, item(1));
  makeInbox(AGENT);
  assert.deepEqual(inboxState(AGENT, item(1).send), { state: 'queued', line: 'line 1' });
  assert.throws(() => makeInbox('../x'), TypeError);
  assert.deepEqual(readdirSync(join(dir, 'inbox')), [AGENT]);
});

test('a signal ends the waiting with false', async () => {
  const stop = new AbortController();
  const waiting = waitForSend(AGENT, stop.signal, 50);
  stop.abort();
  assert.equal(await waiting, false);
});

test('a file in the inbox that is not a record is ignored', () => {
  enqueue(AGENT, item(1));
  const folder = dirname(inboxFiles()[0]);
  writeFileSync(join(folder, 'junk.json'), 'not json');
  assert.equal(claim(AGENT).length, 1);
});

// The temporary file of a write that has not been renamed yet, or that a write left behind.
test('the temporary file of a send\'s record is not claimed', () => {
  enqueue(AGENT, item(1));
  const folder = dirname(inboxFiles()[0]);
  writeFileSync(join(folder, `${item(2).send}.json.${process.pid}.tmp`),
    JSON.stringify({ send: item(2).send, folder: '/s/2', line: 'line 2', at: 1 }));
  assert.deepEqual(claim(AGENT).map(queued => queued.send), [item(1).send]);
  assert.equal(sendState(item(2).send), 'unknown');
});

test('records of sends older than seven days are removed', () => {
  enqueue(AGENT, item(1), 0);
  pruneInbox(INBOX_KEEP_MS + 1);
  assert.equal(sendState(item(1).send), 'unknown');
});

// The state of a send in one agent's inbox.

test('inboxState gives the state and the line of a send in that agent\'s inbox', () => {
  enqueue(AGENT, item(1));
  assert.deepEqual(inboxState(AGENT, item(1).send), { state: 'queued', line: 'line 1' });
  claim(AGENT);
  assert.deepEqual(inboxState(AGENT, item(1).send), { state: 'queued', line: 'line 1' });
  release(AGENT, [item(1).send]);
  assert.deepEqual(inboxState(AGENT, item(1).send), { state: 'queued', line: 'line 1' });
  claim(AGENT);
  confirm(AGENT, [item(1).send]);
  assert.deepEqual(inboxState(AGENT, item(1).send), { state: 'picked_up', line: 'line 1' });
});

test('inboxState gives null for another agent\'s send, an unknown id and an id of another form', () => {
  enqueue(AGENT, item(1));
  enqueue('bbbbbbbbbbbb', item(2));
  assert.equal(inboxState(AGENT, item(2).send), null);
  assert.equal(inboxState('bbbbbbbbbbbb', item(1).send), null);
  assert.equal(inboxState('cccccccccccc', item(1).send), null);       // an agent without an inbox
  assert.equal(inboxState(AGENT, '0000000000000009'), null);
  for (const send of ['../x', '000000000000000', '0000000000000001.json', 7 as unknown as string]) {
    assert.equal(inboxState(AGENT, send), null, String(send));
  }
  for (const agent of ['../x', 'aaaaaaaaaaa', 7 as unknown as string]) {
    assert.equal(inboxState(agent, item(1).send), null, String(agent));
  }
});

// What a write or a claim that ended in the middle leaves behind, and folders left empty.

const DAY = 24 * 3_600_000;

// Sets the modification time of the file at this path to `ms` milliseconds ago.
function age(path: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

test('pruneInbox removes a temporary file a write left behind and an agent\'s folder that is empty', () => {
  enqueue(AGENT, item(1));
  const folder = dirname(inboxFiles()[0]);
  const inbox = dirname(folder);
  const old = join(folder, `${item(2).send}.json.${process.pid}.tmp`);
  const young = join(folder, `${item(3).send}.json.4242.tmp`);
  writeFileSync(old, '{');
  writeFileSync(young, '{');
  age(old, DAY + 60_000);
  age(young, DAY - 60_000);
  const registered = registerAgent({ harness: 'codex', about: '', folder: '/x/site' });
  const unregistered = 'bbbbbbbbbbbb';
  mkdirSync(join(inbox, registered.id));
  mkdirSync(join(inbox, unregistered));
  pruneInbox();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(young), true);
  assert.deepEqual(inboxState(AGENT, item(1).send), { state: 'queued', line: 'line 1' });
  assert.deepEqual(readdirSync(inbox).sort(), [AGENT, registered.id].sort());
});

test('pruneInbox removes a claim lock older than a day, and a folder that held nothing else', () => {
  const inbox = join(dir, 'inbox');
  const kept = registerAgent({ harness: 'codex', about: '', folder: '/x/site' }).id;
  for (const agent of [AGENT, kept, 'bbbbbbbbbbbb', 'cccccccccccc']) mkdirSync(join(inbox, agent), { recursive: true });
  // An agent without a record whose folder holds an old lock and an old temporary file only.
  writeFileSync(join(inbox, AGENT, 'claim.lock'), '');
  writeFileSync(join(inbox, AGENT, `${item(1).send}.json.4242.tmp`), '{');
  age(join(inbox, AGENT, 'claim.lock'), DAY + 60_000);
  age(join(inbox, AGENT, `${item(1).send}.json.4242.tmp`), DAY + 60_000);
  // A registered agent whose folder holds an old lock only.
  writeFileSync(join(inbox, kept, 'claim.lock'), '');
  age(join(inbox, kept, 'claim.lock'), DAY + 60_000);
  // An agent without a record whose folder holds a lock that is younger than a day.
  writeFileSync(join(inbox, 'bbbbbbbbbbbb', 'claim.lock'), '');
  age(join(inbox, 'bbbbbbbbbbbb', 'claim.lock'), DAY - 60_000);
  // An agent without a record whose folder holds a file that is not a record nor a leftover.
  writeFileSync(join(inbox, 'cccccccccccc', 'junk.json'), '');
  age(join(inbox, 'cccccccccccc', 'junk.json'), 2 * DAY);
  pruneInbox();
  assert.deepEqual(readdirSync(inbox).sort(), [kept, 'bbbbbbbbbbbb', 'cccccccccccc'].sort());
  assert.deepEqual(readdirSync(join(inbox, kept)), []);
  assert.deepEqual(readdirSync(join(inbox, 'bbbbbbbbbbbb')), ['claim.lock']);
  assert.deepEqual(readdirSync(join(inbox, 'cccccccccccc')), ['junk.json']);
});

test('pruneInbox removes the folder of an agent without a record once its last send is removed', () => {
  enqueue(AGENT, item(1), 0);
  enqueue(AGENT, item(2));
  pruneInbox();
  assert.equal(inboxState(AGENT, item(1).send), null);
  assert.equal(inboxState(AGENT, item(2).send)?.state, 'queued');
  pruneInbox(Date.now() + INBOX_KEEP_MS + 1);
  assert.equal(existsSync(join(dir, 'inbox', AGENT)), false);
});

// Claims, confirmations and their edges.

test('a claim gives each send as it was queued', () => {
  enqueue(AGENT, item(1), 100);
  assert.deepEqual(claim(AGENT), [{ send: item(1).send, folder: '/s/1', line: 'line 1', at: 100 }]);
});

test('sends queued in the same millisecond are claimed in the order of their ids', () => {
  enqueue(AGENT, item(3), 100);
  enqueue(AGENT, item(1), 100);
  enqueue(AGENT, item(2), 100);
  assert.deepEqual(claim(AGENT).map(queued => queued.line), ['line 1', 'line 2', 'line 3']);
});

test('a send claimed by another process that lives is not offered', () => {
  enqueue(AGENT, item(1));
  assert.equal(claim(AGENT, process.ppid).length, 1);
  assert.deepEqual(claim(AGENT), []);
  assert.equal(sendState(item(1).send), 'queued');
  assert.equal(queuedFor(AGENT), 1);
});

test('processes that claim at the same time get each send once', async () => {
  const sends = Array.from({ length: 40 }, (_, n) => n.toString(16).padStart(16, '0'));
  for (const [n, send] of sends.entries()) enqueue(AGENT, { send, folder: `/s/${n}`, line: `line ${n}` }, n);
  // Every process claims for this one, which lives throughout, so no claim of theirs is offered again.
  const script = `
    const { claim } = await import(process.argv[1]);
    await new Promise(done => setTimeout(done, Number(process.argv[3]) - Date.now()));
    process.stdout.write(JSON.stringify(claim(process.argv[2], ${process.pid}).map(queued => queued.send)));`;
  const start = String(Date.now() + 500);
  const outputs = await Promise.all(Array.from({ length: 4 }, () =>
    run(process.execPath, ['--input-type=module', '-e', script, INBOX_URL, AGENT, start], { timeout: 10_000 })));
  const claimed = outputs.flatMap(({ stdout }) => JSON.parse(stdout) as string[]);
  assert.deepEqual(claimed.sort(), sends);
});

test('a confirmation needs no claim, and one of a send that is not there changes nothing', () => {
  enqueue(AGENT, item(1));
  confirm(AGENT, [item(1).send, '0000000000000009', '../x']);
  assert.equal(sendState(item(1).send), 'picked_up');
  confirm('../x', [item(1).send]);
  confirm('bbbbbbbbbbbb', [item(1).send]);
  assert.equal(sendState(item(1).send), 'picked_up');
});

test('only a claimed send is released', () => {
  enqueue(AGENT, item(1));
  enqueue(AGENT, item(2));
  claim(AGENT);
  confirm(AGENT, [item(1).send]);
  release(AGENT, [item(1).send, item(2).send, '0000000000000009', '../x']);
  assert.equal(sendState(item(1).send), 'picked_up');
  assert.deepEqual(claim(AGENT).map(queued => queued.line), ['line 2']);
  release('../x', [item(2).send]);
});

test('a send that an inbox holds is not queued again', () => {
  enqueue(AGENT, item(1));
  claim(AGENT);
  confirm(AGENT, [item(1).send]);
  enqueue(AGENT, item(1));
  assert.equal(sendState(item(1).send), 'picked_up');
  assert.deepEqual(claim(AGENT), []);
  assert.equal(inboxFiles().length, 1);
});

test('the sends that are not picked up are counted, claimed or not', () => {
  for (const n of [1, 2, 3]) enqueue(AGENT, item(n), n);
  assert.equal(queuedFor(AGENT), 3);
  claim(AGENT);
  assert.equal(queuedFor(AGENT), 3);
  confirm(AGENT, [item(1).send]);
  assert.equal(queuedFor(AGENT), 2);
  assert.equal(queuedFor('bbbbbbbbbbbb'), 0);
  assert.equal(queuedFor('../x'), 0);
});

test('the state of a send is found in the inbox of any agent', () => {
  enqueue('bbbbbbbbbbbb', item(1));
  assert.equal(sendState(item(1).send), 'queued');
  assert.deepEqual(claim(AGENT), []);
});

test('an item that cannot be a record is refused', () => {
  assert.throws(() => enqueue(AGENT, { ...item(1), folder: 7 as unknown as string }), TypeError);
  assert.throws(() => enqueue(AGENT, { ...item(1), line: null as unknown as string }), TypeError);
  assert.throws(() => enqueue(AGENT, item(1), Number.NaN), TypeError);
  assert.throws(() => claim(AGENT, 0), TypeError);
  assert.throws(() => claim(AGENT, 1.5), TypeError);
  assert.throws(() => claim(AGENT, process.pid, Number.POSITIVE_INFINITY), TypeError);
  assert.deepEqual(inboxFiles(), []);
});

test('a file named for a send that does not hold its record is ignored', () => {
  enqueue(AGENT, item(1));
  const folder = dirname(inboxFiles()[0]);
  writeFileSync(join(folder, `${item(2).send}.json`), 'not json');
  writeFileSync(join(folder, `${item(3).send}.json`), JSON.stringify({ ...item(1), at: 0 }));
  writeFileSync(join(folder, `${item(4).send}.json`), JSON.stringify({ ...item(4), at: 'now' }));
  assert.deepEqual(claim(AGENT).map(queued => queued.line), ['line 1']);
  assert.equal(queuedFor(AGENT), 1);
  for (const n of [2, 3, 4]) assert.equal(sendState(item(n).send), 'unknown');
});

test('records are removed seven days after they were queued, whatever their state', () => {
  for (const n of [1, 2, 3]) enqueue(AGENT, item(n), n);
  claim(AGENT, process.pid, 10);
  confirm(AGENT, [item(1).send]);
  enqueue(AGENT, item(4), INBOX_KEEP_MS);
  pruneInbox(INBOX_KEEP_MS + 3);
  assert.equal(sendState(item(1).send), 'unknown');
  assert.equal(sendState(item(2).send), 'unknown');
  assert.equal(sendState(item(3).send), 'queued');
  assert.equal(sendState(item(4).send), 'queued');
});

test('inbox records and their folders are user-only, also once claimed and picked up', { skip: process.platform === 'win32' }, () => {
  const mask = process.umask(0o277);
  try {
    enqueue(AGENT, item(1));
    enqueue(AGENT, item(2));
    claim(AGENT);
    confirm(AGENT, [item(1).send]);
    const files = inboxFiles();
    assert.equal(files.length, 2);
    for (const file of files) assert.equal(statSync(file).mode & 0o777, 0o600, file);
    assert.equal(statSync(dirname(files[0])).mode & 0o777, 0o700);
    assert.equal(statSync(dirname(dirname(files[0]))).mode & 0o777, 0o700);
  } finally {
    process.umask(mask);
  }
});

// The lock that lets one process at a time claim an agent's sends.

test('a claim made while another holds the agent\'s lock gives nothing', () => {
  enqueue(AGENT, item(1));
  const record = inboxFiles()[0];
  const lock = join(dirname(record), 'claim.lock');
  writeFileSync(lock, '');
  const start = performance.now();
  assert.deepEqual(claim(AGENT), []);
  const waited = performance.now() - start;
  assert.ok(waited >= 950 && waited < 4_000, `waited ${waited} ms`);
  assert.equal(sendState(item(1).send), 'queued');
  assert.deepEqual(inboxFiles(), [record]);
  assert.equal(existsSync(lock), true);
});

test('a claim removes a lock that was left behind and takes the send', () => {
  enqueue(AGENT, item(1));
  const lock = join(dirname(inboxFiles()[0]), 'claim.lock');
  writeFileSync(lock, '');
  const tenSecondsAgo = new Date(Date.now() - 10_000);
  utimesSync(lock, tenSecondsAgo, tenSecondsAgo);
  assert.deepEqual(claim(AGENT).map(queued => queued.send), [item(1).send]);
  assert.equal(existsSync(lock), false);
});

// A clock that was set back after the lock was made.
test('a claim removes a lock made more than five seconds in the future and takes the send', () => {
  enqueue(AGENT, item(1));
  const lock = join(dirname(inboxFiles()[0]), 'claim.lock');
  writeFileSync(lock, '');
  const tenSecondsAhead = new Date(Date.now() + 10_000);
  utimesSync(lock, tenSecondsAhead, tenSecondsAhead);
  assert.deepEqual(claim(AGENT).map(queued => queued.send), [item(1).send]);
  assert.equal(existsSync(lock), false);
});

// Runs `body` as if the program ran on `platform`, with the fs call `call` failing for the claim
// lock with `code` the first `fails` times; every other call is the real one. Gives the number of
// calls for the lock.
function withLockFailing(
  platform: NodeJS.Platform, call: 'openSync' | 'statSync', code: string, fails: number, body: () => void,
): number {
  const real = fs[call] as (...args: unknown[]) => unknown;
  const was = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(was);
  let calls = 0;
  mock.method(fs, call, (...args: unknown[]) => {
    if (basename(String(args[0])) === 'claim.lock' && calls++ < fails) {
      throw Object.assign(new Error(`${code}: operation not permitted, ${call}`), { code });
    }
    return real(...args);
  });
  syncBuiltinESMExports();                       // inbox.ts imports openSync and statSync by name
  Object.defineProperty(process, 'platform', { ...was, value: platform });
  try {
    body();
  } finally {
    Object.defineProperty(process, 'platform', was);
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  return calls;
}

// While another process has a removed file open, Windows keeps the file in its folder, and making
// it anew fails with EPERM or EACCES.
test('on Windows a lock that is being removed is waited for', () => {
  for (const [n, code] of [[1, 'EPERM'], [2, 'EACCES']] as const) {
    enqueue(AGENT, item(n));
    const calls = withLockFailing('win32', 'openSync', code, 3, () => {
      assert.deepEqual(claim(AGENT).map(queued => queued.send), [item(n).send]);
    });
    assert.equal(calls, 4);
    assert.equal(existsSync(join(dirname(inboxFiles()[0]), 'claim.lock')), false);
  }
});

test('on Windows a lock that cannot be made for a permission is thrown after the wait', () => {
  enqueue(AGENT, item(1));
  const record = inboxFiles()[0];
  const start = performance.now();
  withLockFailing('win32', 'openSync', 'EPERM', Number.POSITIVE_INFINITY, () => {
    assert.throws(() => claim(AGENT), { code: 'EPERM' });
  });
  const waited = performance.now() - start;
  assert.ok(waited >= 950 && waited < 4_000, `waited ${waited} ms`);
  assert.deepEqual(inboxFiles(), [record]);
});

test('on another system a lock that cannot be made for a permission is thrown at once', () => {
  enqueue(AGENT, item(1));
  const record = inboxFiles()[0];
  for (const code of ['EPERM', 'EACCES']) {
    const start = performance.now();
    const calls = withLockFailing('linux', 'openSync', code, Number.POSITIVE_INFINITY, () => {
      assert.throws(() => claim(AGENT), { code });
    });
    assert.equal(calls, 1);
    assert.ok(performance.now() - start < 500);
  }
  assert.deepEqual(inboxFiles(), [record]);
});

// Reading the time of a lock that is being removed fails on Windows as making it does.
test('on Windows a lock whose time cannot be read while it is being removed is looked at again', () => {
  enqueue(AGENT, item(1));
  const lock = join(dirname(inboxFiles()[0]), 'claim.lock');
  writeFileSync(lock, '');
  const tenSecondsAgo = new Date(Date.now() - 10_000);
  utimesSync(lock, tenSecondsAgo, tenSecondsAgo);
  const calls = withLockFailing('win32', 'statSync', 'EPERM', 1, () => {
    assert.deepEqual(claim(AGENT).map(queued => queued.send), [item(1).send]);
  });
  assert.equal(calls, 2);
  assert.equal(existsSync(lock), false);
  enqueue(AGENT, item(2));
  writeFileSync(lock, '');
  withLockFailing('linux', 'statSync', 'EPERM', 1, () => {
    assert.throws(() => claim(AGENT), { code: 'EPERM' });
  });
});

test('a claim leaves no lock behind, also when it throws', () => {
  enqueue(AGENT, item(1));
  const folder = dirname(inboxFiles()[0]);
  const lock = join(folder, 'claim.lock');
  assert.equal(claim(AGENT).length, 1);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(claim(AGENT), []);
  assert.equal(existsSync(lock), false);
  // A folder in the place of the claimed name makes the rename of the claim fail.
  enqueue(AGENT, item(2));
  mkdirSync(join(folder, `${item(2).send}.claimed.${process.pid}.1000`));
  assert.throws(() => claim(AGENT, process.pid, 1_000));
  assert.equal(existsSync(lock), false);
});

test('a claim for an agent without an inbox makes nothing', () => {
  assert.deepEqual(claim(AGENT), []);
  assert.deepEqual(readdirSync(dir), []);
  enqueue('bbbbbbbbbbbb', item(1));
  const inbox = dirname(dirname(inboxFiles()[0]));
  assert.deepEqual(claim(AGENT), []);
  assert.deepEqual(readdirSync(inbox), ['bbbbbbbbbbbb']);
});

test('the lock is not counted as a send', async () => {
  enqueue(AGENT, item(1));
  const record = inboxFiles()[0];
  const lock = join(dirname(record), 'claim.lock');
  rmSync(record);
  writeFileSync(lock, '');
  assert.equal(queuedFor(AGENT), 0);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  assert.equal(await waitForSend(AGENT, stop.signal, 20), false);
  assert.equal(inboxState(AGENT, item(1).send), null);
  pruneInbox();
  assert.equal(existsSync(lock), true);
});

// Waiting.

test('a signal that has ended ends the waiting at once with false', async () => {
  enqueue(AGENT, item(1));
  const stop = new AbortController();
  stop.abort();
  assert.equal(await waitForSend(AGENT, stop.signal), false);
});

test('waiting ends when a send arrives for an agent whose inbox was not there yet', async () => {
  const waiting = waitForSend(AGENT, new AbortController().signal, 50);
  setTimeout(() => enqueue(AGENT, item(1)), 100);
  assert.equal(await waiting, true);
});

test('waiting ends when a claim runs out, without a change in the inbox', async () => {
  enqueue(AGENT, item(1));
  claim(AGENT, process.pid, Date.now() - CLAIM_MS + 200);
  assert.deepEqual(claim(AGENT), []);
  assert.equal(await waitForSend(AGENT, new AbortController().signal, 50), true);
});

test('waiting for an agent id of another form ends only by the signal', async () => {
  const stop = new AbortController();
  const waiting = waitForSend('../x', stop.signal, 20);
  setTimeout(() => stop.abort(), 100);
  assert.equal(await waiting, false);
});

test('waiting leaves nothing behind that keeps the process alive, however it ends', async () => {
  const script = `
    const { claim, confirm, enqueue, waitForSend } = await import(process.argv[1]);
    const agent = process.argv[2];
    enqueue(agent, { send: '0000000000000001', folder: '/s/1', line: 'line 1' });
    claim(agent);
    confirm(agent, ['0000000000000001']);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const ended = await waitForSend(agent, stop.signal, 50);
    const waiting = waitForSend(agent, new AbortController().signal, 50);
    enqueue(agent, { send: '0000000000000002', folder: '/s/2', line: 'line 2' });
    process.stdout.write(JSON.stringify([ended, await waiting]));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script, INBOX_URL, AGENT],
    { timeout: 5_000 });
  assert.deepEqual(JSON.parse(stdout), [false, true]);
});
