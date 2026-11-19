import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isOpenAddress, openAddress, openerFor, startOpener } from '../../bridge/src/opener.ts';

const CODE = 'a'.repeat(32);

test('only the bridge own open address is an open address', () => {
  assert.equal(isOpenAddress(`http://127.0.0.1:47823/open/${CODE}`), true);
  assert.equal(isOpenAddress(`http://127.0.0.1:47824/open/${CODE}`), true);
  for (const other of [`http://127.0.0.1:47823/open/${CODE}?x=1`, `http://localhost:47823/open/${CODE}`,
    `https://127.0.0.1:47823/open/${CODE}`, `http://127.0.0.1:47823/open/${CODE.slice(1)}`,
    `http://127.0.0.1:1/open/${CODE}`, '-a Calculator', 'file:///etc/passwd', `http://127.0.0.1:47823/open/${CODE}\n`]) {
    assert.equal(isOpenAddress(other), false, other);
  }
});

test('each system has its opener, and none of them is a shell', () => {
  assert.deepEqual(openerFor('darwin'), { file: 'open', args: [] });
  assert.deepEqual(openerFor('linux'), { file: 'xdg-open', args: [] });
  assert.deepEqual(openerFor('win32'), { file: 'rundll32', args: ['url.dll,FileProtocolHandler'] });
});

test('an open address is opened, and nothing else is', () => {
  const started: [string, string[]][] = [];
  const deps = { platform: 'win32' as const, start: (file: string, args: string[]) => { started.push([file, args]); return true; } };
  const address = `http://127.0.0.1:47823/open/${CODE}`;
  assert.equal(openAddress(address, deps), true);
  assert.equal(openAddress('http://localhost:3000/', deps), false);
  assert.deepEqual(started, [['rundll32', ['url.dll,FileProtocolHandler', address]]]);
});

test('an opener that cannot be started gives false', () => {
  const address = `http://127.0.0.1:47823/open/${CODE}`;
  assert.equal(openAddress(address, { platform: 'linux', start: () => { throw new Error('ENOENT'); } }), false);
  assert.equal(openAddress(address, { platform: 'linux', start: () => false }), false);
});

// A program that does not exist reports that as an event after the start, which would end the
// test's process when nothing listened for it.
test('a program that does not exist is not started: false, and no error escapes', async () => {
  assert.equal(startOpener('clicknote-no-such-opener', [`http://127.0.0.1:47823/open/${CODE}`], 0o022), false);
  assert.equal(openAddress(`http://127.0.0.1:47823/open/${CODE}`,
    { platform: 'linux', start: (_file, args) => startOpener('clicknote-no-such-opener', args, 0o022) }), false);
  await sleep(100);
});

test('a program that exists is started', () => {
  assert.equal(startOpener(process.execPath, ['-e', ''], 0o022), true);
});

test('the program gets the file mask given, and this process keeps its own',
  { skip: process.platform === 'win32' && 'Windows has no file modes for other users' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clicknote-opener-'));
  const own = process.umask(0o077);
  try {
    const file = join(dir, 'made');
    const script = `require('node:fs').writeFileSync(${JSON.stringify(file)}, '')`;
    assert.equal(startOpener(process.execPath, ['-e', script], 0o022), true);
    assert.equal(process.umask(0o077), 0o077);
    const end = Date.now() + 5_000;
    while (!existsSync(file) && Date.now() < end) await sleep(20);
    assert.equal(statSync(file).mode & 0o777, 0o644);
  } finally {
    process.umask(own);
    rmSync(dir, { recursive: true, force: true });
  }
});
