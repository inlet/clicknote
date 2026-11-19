import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LINK_CODE, markBound, pruneLinks, readLink, writeLink } from '../../bridge/src/links.ts';
import { stateDir } from '../../bridge/src/paths.ts';

// Every variable a test may set; each is cleared before a test and restored after it.
const ENV_KEYS = ['CLICKNOTE_STATE_DIR'];
let savedEnv: Record<string, string | undefined> = {};
let dir = '';

const LINK = { url: 'http://localhost:3000/a?b#c', agent: 't8s', label: 'site / 1 · claude-code · t8s' };

// The file of the link with this code.
function linkFile(code: string): string {
  return join(stateDir(), 'links', `${code}.json`);
}

// A link file as writeLink writes it, with these fields changed or, given as undefined, left out.
function linkText(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ format: 1, ...LINK, at: 1000, bound: false, ...fields });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'clicknote-links-test-'));
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

test('a link is written under a new code and read back', () => {
  const code = writeLink(LINK, 1000);
  assert.match(code, LINK_CODE);
  assert.deepEqual(readLink(code, 1000), { ...LINK, at: 1000, bound: false });
  assert.equal(existsSync(join(dir, 'links', `${code}.json`)), true);
  assert.notEqual(writeLink(LINK, 1000), code);
});

test('a link holds for an hour', () => {
  const code = writeLink(LINK, 1000);
  assert.deepEqual(readLink(code, 1000 + 3_600_000), { ...LINK, at: 1000, bound: false });
  assert.equal(readLink(code, 1000 + 3_600_001), null);
});

test('a link is written and marked without leaving a temporary file', () => {
  const code = writeLink(LINK, 1000);
  assert.deepEqual(readdirSync(join(dir, 'links')), [`${code}.json`]);
  assert.deepEqual(readdirSync(dir), ['links']);
  markBound(code);
  assert.deepEqual(readdirSync(join(dir, 'links')), [`${code}.json`]);
  assert.deepEqual(readdirSync(dir), ['links']);
});

// The bridge prunes while the open command writes. Here the prune runs inside the write, after
// the temporary file is written and before it is renamed into the folder links.
test('a prune between the write and the rename of a link leaves the link alone', () => {
  const rename = fs.renameSync;
  mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    pruneLinks(1000);
    rename(from, to);
  });
  syncBuiltinESMExports();                       // links.ts imports renameSync by name
  try {
    const code = writeLink(LINK, 1000);
    assert.deepEqual(readLink(code, 1000), { ...LINK, at: 1000, bound: false });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

// A code is a secret of the user, and the state folder is usually listable by others.
test('a link is written through a temporary file named without its code', () => {
  const rename = fs.renameSync;
  const temporaries: string[] = [];
  mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    temporaries.push(String(from));
    rename(from, to);
  });
  syncBuiltinESMExports();                       // links.ts imports renameSync by name
  try {
    markBound(writeLink(LINK, 1000));
    const temporary = join(stateDir(), `link-${process.pid}.tmp`);
    assert.deepEqual(temporaries, [temporary, temporary]);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('a link is readable by the user only', { skip: process.platform === 'win32' }, () => {
  const code = writeLink(LINK, 1000);
  assert.equal(statSync(linkFile(code)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'links')).mode & 0o777, 0o700);
});

// Each code has a file of a good link under its name, so only the form of the code can refuse it.
// '../x' would name x.json next to the folder links.
test('a code of another form reads nothing and touches no file', () => {
  const codes = ['../x', 'ABCDEF0123456789ABCDEF0123456789', 'a'.repeat(31), 'a'.repeat(33), ''];
  mkdirSync(join(dir, 'links'));
  writeFileSync(join(dir, 'x.json'), linkText());
  for (const code of codes.slice(1)) writeFileSync(linkFile(code), linkText());
  for (const code of codes) assert.equal(readLink(code, 1000), null, JSON.stringify(code));
  assert.equal(existsSync(join(dir, 'x.json')), true);
  for (const code of codes.slice(1)) assert.equal(existsSync(linkFile(code)), true, code);
});

test('a file that is not a link of this form reads nothing', () => {
  const texts = [
    'not json',
    linkText({ format: 2 }),
    linkText({ agent: undefined }),
    linkText({ at: '1000' }),
    linkText({ url: 'javascript:alert(1)' }),
    linkText({ url: 'http:localhost' }),
    linkText({ url: 'http://a b/' }),
  ];
  for (const text of texts) {
    const code = writeLink(LINK, 1000);
    writeFileSync(linkFile(code), text);
    assert.equal(readLink(code, 1000), null, text);
  }
});

test('a bound link says so', () => {
  const code = writeLink(LINK, 1000);
  markBound(code);
  assert.deepEqual(readLink(code, 1000), { ...LINK, at: 1000, bound: true });
});

test('old and unreadable links are removed, and the others stay', () => {
  const now = 10_000_000;
  writeLink(LINK, now - 3_600_001);
  const current = writeLink(LINK, now);
  writeFileSync(linkFile(writeLink(LINK, now)), 'garbage');
  pruneLinks(now);
  assert.deepEqual(readdirSync(join(dir, 'links')), [`${current}.json`]);
});

test('pruning without a links folder does nothing', () => {
  pruneLinks();
  assert.equal(existsSync(join(dir, 'links')), false);
});

const LINKS = { skip: process.platform === 'win32' && 'making a link on Windows needs a privilege the tests may not have' };

test('a link file that is a link is not followed', LINKS, () => {
  const code = writeLink(LINK, 1000);
  const outside = mkdtempSync(join(tmpdir(), 'clicknote-links-outside-'));
  try {
    writeFileSync(join(outside, 'link.json'), linkText());
    rmSync(linkFile(code));
    symlinkSync(join(outside, 'link.json'), linkFile(code));
    assert.equal(readLink(code, 1000), null);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
