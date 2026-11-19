import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../../shared/version.ts';
import { startBeacon } from '../../bridge/src/presence.ts';
import {
  BRIDGE_KEY, STATE_FORMAT, clearOwnRecord, clearProblem, clearStop, noteProblem, readBridgeRecord, requestStop, seeBridge,
  stopRequested, writeBridgeRecord, type BridgeRecord,
} from '../../bridge/src/record.ts';

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

const record = { pid: 1, version: VERSION, format: STATE_FORMAT, port: 47824, auto: true };

test('a bridge runs when its record is there and its beacon beats', () => {
  assert.deepEqual(seeBridge(), { state: 'down', problem: null });
  writeBridgeRecord(record);
  assert.deepEqual(seeBridge(), { state: 'down', problem: null });
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    assert.deepEqual(seeBridge(), { state: 'running', record });
  } finally {
    beacon.stop();
  }
});

test('a live bridge of another version or format is another bridge', () => {
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    writeBridgeRecord({ ...record, version: '0.0.1' });
    assert.equal(seeBridge().state, 'other');
    writeBridgeRecord({ ...record, format: STATE_FORMAT + 1 });
    assert.equal(seeBridge().state, 'other');
  } finally {
    beacon.stop();
  }
});

test('a noted problem comes with down and goes when a bridge writes its record', () => {
  noteProblem('port_in_use');
  assert.deepEqual(seeBridge(), { state: 'down', problem: 'port_in_use' });
  writeBridgeRecord(record);
  clearOwnRecord(record.pid);
  assert.deepEqual(seeBridge(), { state: 'down', problem: null });
});

test('the record is removed only when it names the process given', () => {
  writeBridgeRecord(record);
  clearOwnRecord(record.pid + 1);
  assert.deepEqual(readBridgeRecord(), record);
  clearOwnRecord(record.pid);
  assert.equal(readBridgeRecord(), null);
  clearOwnRecord(record.pid);
  assert.equal(readBridgeRecord(), null);
});

test('a noted problem is cleared, and the bridge\'s record stays', () => {
  writeBridgeRecord(record);
  noteProblem('port_in_use');
  clearProblem();
  assert.deepEqual(seeBridge(), { state: 'down', problem: null });
  clearProblem();
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    assert.deepEqual(seeBridge(), { state: 'running', record });
  } finally {
    beacon.stop();
  }
});

test('a record of another shape is no record', () => {
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    writeBridgeRecord({ ...record, pid: 'x' } as unknown as BridgeRecord);
    assert.equal(seeBridge().state, 'down');
  } finally {
    beacon.stop();
  }
});

test('a stop is requested, seen and cleared', () => {
  assert.equal(stopRequested(), false);
  requestStop();
  assert.equal(stopRequested(), true);
  clearStop();
  assert.equal(stopRequested(), false);
});
