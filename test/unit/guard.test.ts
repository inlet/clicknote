import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureStateDir, StateFolderError } from '../../bridge/src/guard.ts';

let dir = '';
let saved: string | undefined;
// The file mask is process-wide: every test starts with the usual 022, whatever the shell had,
// and the mask found is put back after it.
let mask = 0;
beforeEach(() => {
  mask = process.umask(0o022);
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
});
afterEach(() => {
  process.umask(mask);
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const MODES = { skip: process.platform === 'win32' && 'Windows has no file modes for other users' };
const LINKS = { skip: process.platform === 'win32' && 'making a link on Windows needs a privilege the tests may not have' };
const OWNERS = { skip: process.platform === 'win32' && 'Windows gives a file no owner that the check could compare' };
// macOS lets a user lock their own file with chflags uchg, so that its mode cannot be changed;
// the other systems need root for that.
const LOCKS = { skip: process.platform !== 'darwin' && 'only macOS lets a user lock a file without root' };

const mode = (path: string) => statSync(path).mode & 0o777;

// Locks this file or folder against a change of mode, runs the body, and unlocks it again.
function whileLocked(path: string, body: () => void): void {
  execFileSync('chflags', ['uchg', path]);
  try {
    body();
  } finally {
    execFileSync('chflags', ['nouchg', path]);
  }
}

test('the state folder is made and given on every system', () => {
  rmSync(dir, { recursive: true });
  assert.equal(secureStateDir(), dir);
  assert.ok(statSync(dir).isDirectory());
});

test('a state folder that is not a folder is refused', () => {
  rmSync(dir, { recursive: true });
  writeFileSync(dir, '');
  assert.throws(() => secureStateDir(), (error: Error) =>
    error instanceof StateFolderError && error.message === `The state folder ${dir} is not a folder. Clicknote does not use it.`);
});

test('an entry inside that cannot be closed is passed over, and the rest are closed', LOCKS, () => {
  writeFileSync(join(dir, 'locked'), 'x', { mode: 0o644 });
  writeFileSync(join(dir, 'open'), 'x', { mode: 0o644 });
  mkdirSync(join(dir, 'sub'), { mode: 0o755 });
  writeFileSync(join(dir, 'sub', 'file'), 'x', { mode: 0o644 });
  whileLocked(join(dir, 'locked'), () => {
    assert.equal(secureStateDir(), dir);
    assert.equal(mode(join(dir, 'locked')), 0o644);
  });
  assert.equal(mode(join(dir, 'open')), 0o600);
  assert.equal(mode(join(dir, 'sub')), 0o700);
  assert.equal(mode(join(dir, 'sub', 'file')), 0o600);
});

test('a state folder that cannot be closed itself stops the program', LOCKS, () => {
  chmodSync(dir, 0o755);
  whileLocked(dir, () => {
    assert.throws(() => secureStateDir(), { code: 'EPERM' });
  });
});

test('a new state folder is made for the user only', MODES, () => {
  rmSync(dir, { recursive: true });
  assert.equal(secureStateDir(), dir);
  assert.equal(mode(dir), 0o700);
});

test('what is written afterwards is user-only without a mode being given', MODES, () => {
  secureStateDir();
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'file'), '');
  assert.equal(mode(join(dir, 'sub')), 0o700);
  assert.equal(mode(join(dir, 'sub', 'file')), 0o600);
});

test('folders and files left open are closed, at every depth', MODES, () => {
  mkdirSync(join(dir, 'sends', '20261113-154441'), { recursive: true, mode: 0o755 });
  writeFileSync(join(dir, 'sends', '20261113-154441', 'annotations.md'), 'x', { mode: 0o644 });
  writeFileSync(join(dir, 'bindings.json'), '{}', { mode: 0o644 });
  chmodSync(dir, 0o755);
  secureStateDir();
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(join(dir, 'sends')), 0o700);
  assert.equal(mode(join(dir, 'sends', '20261113-154441')), 0o700);
  assert.equal(mode(join(dir, 'sends', '20261113-154441', 'annotations.md')), 0o600);
  assert.equal(mode(join(dir, 'bindings.json')), 0o600);
});

test('a state folder that is a link is refused', LINKS, () => {
  const real = mkdtempSync(join(tmpdir(), 'clicknote-real-'));
  rmSync(dir, { recursive: true });
  symlinkSync(real, dir);
  assert.throws(() => secureStateDir(), (error: Error) =>
    error instanceof StateFolderError && error.message === `The state folder ${dir} is a link. Clicknote does not use it.`);
  unlinkSync(dir);
  rmSync(real, { recursive: true });
});

test('a state folder of another user is refused', OWNERS, () => {
  const other = (process.getuid?.() ?? 0) + 1;
  assert.throws(() => secureStateDir(other), (error: Error) =>
    error instanceof StateFolderError
    && error.message === `The state folder ${dir} belongs to another user. Clicknote does not use it.`);
});

// The relative path would name another folder from every working folder.
test('a state folder that is not a full path is refused before anything is made', () => {
  const relative = `clicknote-relative-${process.pid}`;
  process.env.CLICKNOTE_STATE_DIR = join(relative, 'state');
  try {
    assert.throws(() => secureStateDir(), (error: Error) => error instanceof StateFolderError
      && error.message === `The state folder ${join(relative, 'state')} is not a full path. Clicknote does not use it.`);
    assert.equal(existsSync(relative), false);
  } finally {
    rmSync(relative, { recursive: true, force: true });
  }
});

test('a link inside the state folder is left alone and not followed', LINKS, () => {
  const outside = mkdtempSync(join(tmpdir(), 'clicknote-out-'));
  writeFileSync(join(outside, 'open'), 'x', { mode: 0o644 });
  symlinkSync(outside, join(dir, 'link'));
  secureStateDir();
  assert.equal(mode(join(outside, 'open')), 0o644);
  rmSync(outside, { recursive: true });
});
