import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_RECORD_BYTES, readRecord, removeRecord, writeRecord } from '../../bridge/src/store.ts';

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

test('a record is written, read back and removed', () => {
  const path = join(dir, 'agents', 'a.json');
  writeRecord(path, { a: 1 });
  assert.deepEqual(readRecord(path), { a: 1 });
  removeRecord(path);
  assert.equal(readRecord(path), undefined);
  removeRecord(path);
});

test('writing leaves no temporary file', () => {
  writeRecord(join(dir, 'a.json'), { a: 1 });
  assert.deepEqual(readdirSync(dir), ['a.json']);
});

test('a rename that fails throws and leaves no temporary file', () => {
  mkdirSync(join(dir, 'a.json'));
  writeFileSync(join(dir, 'a.json', 'inside'), '');
  assert.throws(() => writeRecord(join(dir, 'a.json'), { a: 1 }));
  assert.deepEqual(readdirSync(dir), ['a.json']);
});

test('a record and the folder made for it are user-only', { skip: process.platform === 'win32' }, () => {
  const path = join(dir, 'agents', 'a.json');
  writeRecord(path, {});
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'agents')).mode & 0o777, 0o700);
});

test('the modes are set whatever the file mask is', { skip: process.platform === 'win32' }, () => {
  // A mask that takes bits from the user too: only modes set by the functions themselves pass.
  const mask = process.umask(0o277);
  try {
    const path = join(dir, 'agents', 'more', 'a.json');
    writeRecord(path, {});
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'agents')).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'agents', 'more')).mode & 0o777, 0o700);
  } finally {
    process.umask(mask);
  }
});

test('what is not a record reads as undefined and nothing throws', () => {
  mkdirSync(join(dir, 'folder.json'));
  writeFileSync(join(dir, 'broken.json'), '{"a":');
  writeFileSync(join(dir, 'large.json'), JSON.stringify('x'.repeat(MAX_RECORD_BYTES)));
  for (const name of ['missing.json', 'folder.json', 'broken.json', 'large.json']) {
    assert.equal(readRecord(join(dir, name)), undefined, name);
  }
});

test('a link to a record reads as undefined', { skip: process.platform === 'win32' }, () => {
  writeFileSync(join(dir, 'real.json'), '{"a":1}');
  symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'));
  assert.equal(readRecord(join(dir, 'link.json')), undefined);
});
