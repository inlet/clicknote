import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir, stateDirFor } from '../../bridge/src/paths.ts';

// Every variable a test may set; each is cleared before a test and restored after it.
const ENV_KEYS = ['CLICKNOTE_STATE_DIR'];
let savedEnv: Record<string, string | undefined> = {};
let dir = '';

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'clicknote-paths-test-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('the state folder per system', () => {
  assert.equal(stateDirFor('darwin', {}, '/Users/you'), '/Users/you/.local/state/clicknote');
  assert.equal(stateDirFor('linux', {}, '/home/you'), '/home/you/.local/state/clicknote');
  assert.equal(stateDirFor('win32', { LOCALAPPDATA: 'C:\\Users\\you\\AppData\\Local' }, 'C:\\Users\\you'),
    'C:\\Users\\you\\AppData\\Local\\clicknote');
  assert.equal(stateDirFor('win32', {}, 'C:\\Users\\you'), 'C:\\Users\\you\\AppData\\Local\\clicknote');
});

test('XDG_STATE_HOME does not move the state folder', () => {
  assert.equal(stateDirFor('linux', { XDG_STATE_HOME: '/x/state' }, '/home/you'), '/home/you/.local/state/clicknote');
});

test('CLICKNOTE_STATE_DIR replaces the state folder on every system', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.equal(stateDirFor(platform, { CLICKNOTE_STATE_DIR: '/tmp/x' }, '/h'), '/tmp/x');
  }
  assert.equal(stateDirFor('darwin', { CLICKNOTE_STATE_DIR: '' }, '/h'), '/h/.local/state/clicknote');
});

// A folder relative to wherever the bridge was started would move with each start.
test('a LOCALAPPDATA that is empty or relative falls back to the folder under the home', () => {
  assert.equal(stateDirFor('win32', { LOCALAPPDATA: '' }, 'C:\\Users\\you'), 'C:\\Users\\you\\AppData\\Local\\clicknote');
  assert.equal(stateDirFor('win32', { LOCALAPPDATA: 'Local' }, 'C:\\Users\\you'), 'C:\\Users\\you\\AppData\\Local\\clicknote');
});

test('a LOCALAPPDATA that ends in a separator gives one separator before the folder name', () => {
  for (const local of ['C:\\Users\\you\\AppData\\Local\\', 'C:\\Users\\you\\AppData\\Local/']) {
    assert.equal(stateDirFor('win32', { LOCALAPPDATA: local }, 'C:\\Users\\you'),
      'C:\\Users\\you\\AppData\\Local\\clicknote');
  }
});

test('stateDir is the folder for this system', () => {
  assert.equal(stateDir(), dir);                              // CLICKNOTE_STATE_DIR, set by beforeEach
  delete process.env.CLICKNOTE_STATE_DIR;
  assert.equal(stateDir(), stateDirFor(process.platform, process.env, homedir()));
});
