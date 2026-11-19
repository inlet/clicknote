import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  createIdle, ensureBridge, IDLE_MS, keepBridge, START_WAIT_MS, TICK_MS, type Idle, type StartDeps,
} from '../../bridge/src/life.ts';
import { startBeacon } from '../../bridge/src/presence.ts';
import {
  BRIDGE_KEY, STATE_FORMAT, clearOwnRecord, noteProblem, readBridgeRecord, requestStop, seeBridge, stopRequested,
  writeBridgeRecord,
} from '../../bridge/src/record.ts';
import { leaveAgent, registerAgent, removeAgent } from '../../bridge/src/registry.ts';
import { VERSION } from '../../shared/version.ts';

type SpawnOptions = Parameters<StartDeps['spawn']>[2];

let dir = '';
let saved: string | undefined;
let spawned: [string, string[], SpawnOptions][] = [];   // what ensureBridge started
let unrefs = 0;                                          // how often it let go of what it started
let time = 0;                                            // the clock of startDeps, moved by its sleep
let beacons: { stop(): void }[] = [];                   // the beacons a stand-in start began
beforeEach(() => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
  spawned = [];
  unrefs = 0;
  time = 0;
  beacons = [];
});
afterEach(() => {
  for (const beacon of beacons) beacon.stop();
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const record = { pid: 1, version: VERSION, format: STATE_FORMAT, port: 47824, auto: true };

// What ensureBridge uses: a start that only records, Node and the program at made-up paths, an
// environment of its own, and a clock that moves only when it sleeps.
function startDeps(): StartDeps {
  return {
    spawn: (file, args, options) => {
      spawned.push([file, args, options]);
      return { unref() { unrefs++; } };
    },
    execPath: '/node',
    self: '/skill/scripts/clicknote.mjs',
    env: { KEPT: 'yes' },
    sleep: async ms => { time += ms; },
    now: () => time,
  };
}

// Keeps a stand-in bridge on port 47824, whose close counts and then runs `close`, for process
// 4242. Its ticking is held for the test to call, and its exit recorded. `closed`, `exits` and
// `stopped` are read live; `ended()` resolves once the exit was called.
function keeping(auto: boolean, idle: Idle = { activity() {}, due: () => false },
  close: () => Promise<void> = async () => {}) {
  let tick = () => {};
  let closed = 0;
  let stopped = false;
  const exits: number[] = [];
  let exited = () => {};
  const ended = new Promise<void>(done => { exited = done; });
  const keeper = keepBridge({
    bridge: { port: 47824, address: '127.0.0.1', close: () => { closed++; return close(); } },
    auto,
    idle,
    pid: 4242,
    every: (ms, given) => {
      assert.equal(ms, TICK_MS);
      tick = given;
      return { stop() { stopped = true; } };
    },
    exit: code => {
      exits.push(code);
      exited();
    },
  });
  return {
    keeper,
    tick: () => tick(),
    ended: () => ended,
    get closed() { return closed; },
    exits,
    get stopped() { return stopped; },
  };
}

test('the idle clock is due ten minutes after the list became empty and the extension last asked', () => {
  let time = 0;
  const idle = createIdle(() => time);
  assert.equal(idle.due(1), false);
  time = 1_000;
  assert.equal(idle.due(0), false);
  time = 1_000 + IDLE_MS - 1;
  assert.equal(idle.due(0), false);
  idle.activity();
  time += IDLE_MS;
  assert.equal(idle.due(0), true);
  assert.equal(idle.due(1), false);
  assert.equal(idle.due(0), false);
});

test('the idle clock takes the time it is given', () => {
  let time = 0;
  const idle = createIdle(() => time, 50);
  assert.equal(idle.due(0), false);
  time = 50;
  assert.equal(idle.due(0), true);
});

test('ensureBridge leaves a running bridge and one of another version alone', async () => {
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    writeBridgeRecord(record);
    assert.equal((await ensureBridge(startDeps())).state, 'running');
    writeBridgeRecord({ ...record, version: '0.0.1' });
    assert.equal((await ensureBridge(startDeps())).state, 'other');
    assert.equal(spawned.length, 0);
  } finally {
    beacon.stop();
  }
});

test('ensureBridge starts the bridge on its own, in and with the state folder, and waits until it runs', async () => {
  const deps = startDeps();
  deps.spawn = (file, args, options) => {
    spawned.push([file, args, options]);
    writeBridgeRecord(record);
    beacons.push(startBeacon('bridge', BRIDGE_KEY));
    return { unref() { unrefs++; } };
  };
  assert.equal((await ensureBridge(deps)).state, 'running');
  assert.deepEqual(spawned.map(([file, args]) => [file, args]), [['/node', ['/skill/scripts/clicknote.mjs', '--auto']]]);
  const options = spawned[0][2];
  assert.deepEqual([options.detached, options.stdio, options.windowsHide], [true, 'ignore', true]);
  assert.equal(options.cwd, dir);
  assert.equal(options.env.CLICKNOTE_STATE_DIR, dir);
  assert.equal(options.env.KEPT, 'yes');
  assert.equal(unrefs, 1);
});

// The bridge runs in another folder than the command, so a relative path would name another
// folder there.
test('ensureBridge gives the bridge the full path of a state folder given as a relative path', async () => {
  process.env.CLICKNOTE_STATE_DIR = relative(process.cwd(), dir);
  await ensureBridge(startDeps());
  const options = spawned[0][2];
  assert.deepEqual([options.cwd, options.env.CLICKNOTE_STATE_DIR], [dir, dir]);
});

test('ensureBridge gives down with the problem when no bridge appears within five seconds', async () => {
  const deps = startDeps();
  deps.spawn = (file, args, options) => { spawned.push([file, args, options]); noteProblem('port_in_use'); return { unref() {} }; };
  assert.deepEqual(await ensureBridge(deps), { state: 'down', problem: 'port_in_use' });
  assert.equal(time >= START_WAIT_MS, true);
});

// A problem noted by an earlier start is not the reason a later start fails.
test('ensureBridge forgets a problem noted before it starts the bridge', async () => {
  noteProblem('port_in_use');
  assert.deepEqual(await ensureBridge(startDeps()), { state: 'down', problem: null });
  assert.equal(spawned.length, 1);
});

test('keepBridge records the bridge and beats for it, and takes both away at the end, once', async () => {
  const kept = keeping(true);
  assert.deepEqual(seeBridge(), { state: 'running',
    record: { pid: 4242, version: VERSION, format: STATE_FORMAT, port: 47824, auto: true } });
  await kept.keeper.end(0);
  assert.deepEqual([seeBridge(), kept.closed, kept.exits, kept.stopped], [{ state: 'down', problem: null }, 1, [0], true]);
  await kept.keeper.end(0);
  assert.deepEqual(kept.exits, [0]);
});

test('keepBridge clears a stop request that was left and ends on a new one, started by hand or by a command', async () => {
  for (const auto of [false, true]) {
    requestStop();
    const kept = keeping(auto);
    assert.equal(stopRequested(), false);
    kept.tick();
    assert.equal(kept.closed, 0);
    requestStop();
    kept.tick();
    await kept.ended();
    assert.deepEqual([kept.closed, kept.exits, stopRequested()], [1, [0], false]);
  }
});

test('keepBridge ends a bridge that a command started when it is idle, and not one started by hand', async () => {
  const byHand = keeping(false, { activity() {}, due: () => true });
  byHand.tick();
  assert.equal(byHand.closed, 0);
  await byHand.keeper.end(0);
  const auto = keeping(true, { activity() {}, due: agents => agents === 0 });
  const agent = registerAgent({ harness: 'x', about: '', folder: '/x' });
  auto.tick();
  assert.equal(auto.closed, 0);
  removeAgent(agent.id);
  auto.tick();
  await auto.ended();
  assert.deepEqual([auto.closed, auto.exits], [1, [0]]);
});

test('a bridge that a command started stops ten minutes after its only agent left', async () => {
  let time = 0;
  const kept = keeping(true, createIdle(() => time));
  const agent = registerAgent({ harness: 'x', about: '', folder: '/x' });
  kept.tick();
  time = 1_000;
  leaveAgent(agent.id);
  kept.tick();
  time = 1_000 + IDLE_MS - 1;
  kept.tick();
  assert.equal(kept.closed, 0);
  time = 1_000 + IDLE_MS;
  kept.tick();
  // The end starts closing the bridge at once, so a bridge that is not ending fails here rather
  // than waiting for an end that never comes.
  assert.equal(kept.closed, 1);
  await kept.ended();
  assert.deepEqual([kept.closed, kept.exits], [1, [0]]);
});

test('the bridge looks every second, well within the five seconds that stop waits', () => {
  assert.equal(TICK_MS, 1_000);
});

// The port is free from the start of the close, so another bridge can start, listen and write its
// record while the close of this one is under way.
test('a bridge whose close finishes late leaves what was written in the meantime where it is', async () => {
  let finish = () => {};
  const kept = keeping(true, undefined, () => new Promise<void>(done => { finish = done; }));
  const ending = kept.keeper.end(0);
  assert.deepEqual([seeBridge(), existsSync(join(dir, 'bridge.json'))], [{ state: 'down', problem: null }, false]);
  const other = { ...record, pid: 999 };
  writeBridgeRecord(other);
  requestStop();
  finish();
  await ending;
  assert.deepEqual([readBridgeRecord(), stopRequested(), kept.exits], [other, true, [0]]);
});

test('end leaves a record that names another process', async () => {
  const kept = keeping(false);
  const other = { ...record, pid: 999 };
  writeBridgeRecord(other);
  await kept.keeper.end(0);
  assert.deepEqual(readBridgeRecord(), other);
});

test('after the end, the beacons\' folder holds no beacon of the bridge', async () => {
  const kept = keeping(true);
  assert.deepEqual(readdirSync(join(dir, 'beacons')).filter(name => name.startsWith('bridge.')), ['bridge.bridge.4242']);
  await kept.keeper.end(0);
  assert.deepEqual(readdirSync(join(dir, 'beacons')).filter(name => name.startsWith('bridge.')), []);
});

test('a look writes the record again when it is gone, or when it names another process', async () => {
  const kept = keeping(true);
  const own = { pid: 4242, version: VERSION, format: STATE_FORMAT, port: 47824, auto: true };
  clearOwnRecord(4242);
  kept.tick();
  assert.deepEqual(readBridgeRecord(), own);
  writeBridgeRecord({ ...record, pid: 999 });
  kept.tick();
  assert.deepEqual(readBridgeRecord(), own);
  await kept.keeper.end(0);
});

test('end called twice closes the bridge once and exits once', async () => {
  const kept = keeping(false);
  const first = kept.keeper.end(0);
  const second = kept.keeper.end(1);
  assert.equal(first, second);
  await second;
  assert.deepEqual([kept.closed, kept.exits], [1, [0]]);
});

test('keepBridge ends with the code given, also when the bridge fails to close', async () => {
  const exits: number[] = [];
  const keeper = keepBridge({
    bridge: { port: 47824, address: '127.0.0.1', close: () => Promise.reject(new Error('not running')) },
    auto: false,
    idle: { activity() {}, due: () => false },
    pid: 4242,
    every: () => ({ stop() {} }),
    exit: code => { exits.push(code); },
  });
  await keeper.end(1);
  assert.deepEqual([exits, seeBridge()], [[1], { state: 'down', problem: null }]);
});
