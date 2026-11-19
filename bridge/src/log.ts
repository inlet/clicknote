import { closeSync, fchmodSync, fstatSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.ts';

// The size in bytes past which the log keeps only its last half.
export const LOG_MAX_BYTES = 262_144;

// The log file is the user's only, as everything in the state folder is.
const FILE_MODE = 0o600;
const NEWLINE = 0x0a;

// The log of a bridge that runs without a terminal: a function that appends each line it is given
// to bridge.log in the state folder, and, when the file passes LOG_MAX_BYTES, keeps its last half,
// from the start of a line. The path is fixed at the start. It never throws: the bridge logs every
// request, and a line that cannot be written is lost.
export function fileLog(): (line: string) => void {
  const path = join(stateDir(), 'bridge.log');
  return line => {
    try {
      if (append(path, `${line}\n`) > LOG_MAX_BYTES) keepLastHalf(path);
    } catch {
      // A line that cannot be written is lost; the bridge goes on.
    }
  };
}

// Appends the text to the file, which is made when it is missing and is made user-only whatever
// the file mask is, and gives the file's size after it.
function append(path: string, text: string): number {
  const fd = openSync(path, 'a', FILE_MODE);
  try {
    fchmodSync(fd, FILE_MODE);
    writeSync(fd, text);
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

// Keeps the last LOG_MAX_BYTES / 2 bytes of the file, or less: from the start of the first line
// that begins in them. A file of that size or less is left as it is.
function keepLastHalf(path: string): void {
  const bytes = readFileSync(path);
  const start = bytes.length - LOG_MAX_BYTES / 2;
  if (start <= 0) return;
  // A line begins at `start` when the byte before it ends one.
  const end = bytes.indexOf(NEWLINE, start - 1);
  writeFileSync(path, bytes.subarray(end === -1 ? bytes.length : end + 1));
}
