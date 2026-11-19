import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BEAT_MS, STALE_MS, present, pruneBeacons, startBeacon as start, type BeaconKind,
} from '../../bridge/src/presence.ts';

// Every beacon a test starts, to be stopped before the folder is removed.
const started: { stop(): void }[] = [];
function startBeacon(kind: BeaconKind, key: string, pid?: number): { stop(): void } {
  const beacon = start(kind, key, pid);
  started.push(beacon);
  return beacon;
}

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
});
afterEach(() => {
  for (const beacon of started.splice(0)) beacon.stop();
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

// The path of the one beacon there is: the one file in the one folder in the state folder.
function beaconPath(state = dir): string {
  const [folder] = readdirSync(state);
  const [file] = readdirSync(join(state, folder));
  return join(state, folder, file);
}

test('a beacon makes its key present until it is stopped', () => {
  assert.equal(present('wait', 'abc123'), false);
  const beacon = startBeacon('wait', 'abc123');
  assert.equal(present('wait', 'abc123'), true);
  beacon.stop();
  assert.equal(present('wait', 'abc123'), false);
});

test('a beacon that no longer beats is gone after fifteen seconds', () => {
  startBeacon('wait', 'abc123');
  assert.equal(present('wait', 'abc123', Date.now() + STALE_MS - 1_000), true);
  assert.equal(present('wait', 'abc123', Date.now() + STALE_MS + 1_000), false);
});

test('another kind or another key is not present', () => {
  startBeacon('wait', 'abc123');
  assert.equal(present('bridge', 'abc123'), false);
  assert.equal(present('wait', 'abc124'), false);
});

test('two processes can beat for one key, and one of them stopping leaves it present', () => {
  const first = startBeacon('wait', 'abc123', 111);
  startBeacon('wait', 'abc123', 222);
  first.stop();
  assert.equal(present('wait', 'abc123'), true);
});

test('a key that could leave the folder is refused', () => {
  assert.throws(() => startBeacon('wait', '../x'), TypeError);
  assert.throws(() => startBeacon('wait', ''), TypeError);
});

test('pruning removes the stale beacons only', () => {
  startBeacon('wait', 'old', 111);
  pruneBeacons(Date.now() + STALE_MS + 1_000);
  assert.equal(present('wait', 'old', Date.now()), false);
  startBeacon('wait', 'new');
  pruneBeacons();
  assert.equal(present('wait', 'new'), true);
});

test('a kind, key or pid that cannot name a beacon is refused, and is never present', () => {
  for (const key of ['ABC', 'a.b', 'a'.repeat(41)]) {
    assert.throws(() => startBeacon('wait', key), TypeError, key);
    assert.equal(present('wait', key), false, key);
  }
  assert.throws(() => startBeacon('x' as BeaconKind, 'abc123'), TypeError);
  for (const pid of [0, -1, 1.5, Number.NaN]) assert.throws(() => startBeacon('wait', 'abc123', pid), TypeError, `${pid}`);
  assert.equal(present('wait', 'abc123'), false);
});

test('stopping a beacon twice leaves a beacon started again for the key', () => {
  const beacon = startBeacon('wait', 'abc123', 111);
  beacon.stop();
  startBeacon('wait', 'abc123', 111);
  beacon.stop();
  assert.equal(present('wait', 'abc123'), true);
});

test('each beat renews the time of the beacon', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const beacon = startBeacon('wait', 'abc123');
  try {
    const old = new Date(Date.now() - STALE_MS - 5_000);
    utimesSync(beaconPath(), old, old);
    assert.equal(present('wait', 'abc123'), false);
    mock.timers.tick(BEAT_MS);
    assert.equal(present('wait', 'abc123'), true);
  } finally {
    beacon.stop();
    mock.timers.reset();
  }
});

test('a beat brings back a beacon that was pruned while its process lives', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const beacon = startBeacon('wait', 'abc123', 111);
  try {
    pruneBeacons(Date.now() + STALE_MS + 1_000);
    assert.equal(present('wait', 'abc123'), false);
    mock.timers.tick(BEAT_MS);
    assert.equal(present('wait', 'abc123'), true);
  } finally {
    beacon.stop();
    mock.timers.reset();
  }
});

test('a beat after the state folder was removed does not throw and does not make it again', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const beacon = startBeacon('wait', 'abc123');
  try {
    rmSync(dir, { recursive: true, force: true });
    mock.timers.tick(BEAT_MS);
    assert.equal(existsSync(dir), false);
    assert.equal(present('wait', 'abc123'), false);
  } finally {
    beacon.stop();
    mock.timers.reset();
  }
});

test('the beacon and the folders made for it are user-only whatever the file mask is', { skip: process.platform === 'win32' }, () => {
  // A mask that takes bits from the user too: only modes set by the code itself pass.
  const mask = process.umask(0o277);
  try {
    const state = join(dir, 'state');
    process.env.CLICKNOTE_STATE_DIR = state;
    startBeacon('wait', 'abc123');
    const path = beaconPath(state);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
    assert.equal(statSync(state).mode & 0o777, 0o700);
  } finally {
    process.umask(mask);
  }
});

test('a beacon does not keep its process alive', () => {
  const url = pathToFileURL(join(import.meta.dirname, '../../bridge/src/presence.ts')).href;
  const script = `const { startBeacon } = await import(${JSON.stringify(url)}); startBeacon('wait', 'abc123');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, CLICKNOTE_STATE_DIR: dir }, timeout: 5_000,
  });
  assert.equal(result.signal, null, 'the process was still running');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(present('wait', 'abc123'), true);
});
