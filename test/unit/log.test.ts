import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileLog, LOG_MAX_BYTES } from '../../bridge/src/log.ts';

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

// The one log file in the state folder.
function logFile(): string {
  const names = readdirSync(dir).filter(name => name.endsWith('.log'));
  assert.equal(names.length, 1, names.join(', '));
  return join(dir, names[0]);
}

test('the log is a file in the state folder, for the user only, one line per call', () => {
  const log = fileLog();
  log('12:00:00 agents ok');
  log('12:00:01 send ok');
  const file = logFile();
  assert.equal(readFileSync(file, 'utf8'), '12:00:00 agents ok\n12:00:01 send ok\n');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a log that grows past its limit keeps its last half, from the start of a line', () => {
  const log = fileLog();
  const line = '12:00:00 agents ok';
  for (let written = 0; written <= LOG_MAX_BYTES; written += line.length + 1) log(line);
  const text = readFileSync(logFile(), 'utf8');
  assert.equal(text.length <= LOG_MAX_BYTES / 2 + line.length + 1, true);
  assert.equal(text.startsWith(line), true);
  assert.equal(text.endsWith(`${line}\n`), true);
});

// The server logs a line for every request; a log that throws would end the bridge.
test('a line that cannot be written is lost without an error', () => {
  const notAFolder = join(dir, 'state');
  writeFileSync(notAFolder, '');
  process.env.CLICKNOTE_STATE_DIR = notAFolder;
  const log = fileLog();
  assert.doesNotThrow(() => log('12:00:00 agents ok'));
});
