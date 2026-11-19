import { chmodSync, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The largest record that is read, in bytes. A larger file is not a record.
export const MAX_RECORD_BYTES = 65_536;

// The modes of what is written in the state folder: its folders and its files are the user's only.
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;

// The JSON value in the file at this path. Undefined for a file that is missing, for anything
// that is not a regular file (a folder, a link, which is not followed), for a file over
// MAX_RECORD_BYTES, and for a file that is not JSON. Never throws.
export function readRecord(path: string): unknown {
  try {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (!stats?.isFile() || stats.size > MAX_RECORD_BYTES) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

// Writes the value as JSON to the file at this path, through a temporary file and a rename, so a
// reader never sees half a record. Makes the folders up to the file that are missing, each
// user-only, and makes the file user-only, whatever the file mask is; a folder that is there is
// left as it is. The temporary file is <path>.<pid>.tmp, next to the record, so the rename stays
// on one file system; one left by an earlier process of the same pid is removed first, and it is
// made new, so a link in its place is never followed. When the write or the rename fails, the
// temporary file is removed and the error thrown on.
export function writeRecord(path: string, value: unknown): void {
  makeFolders(dirname(path));
  const temp = `${path}.${process.pid}.tmp`;
  try {
    rmSync(temp, { force: true });
    const fd = openSync(temp, 'wx', FILE_MODE);
    try {
      fchmodSync(fd, FILE_MODE);
      writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The error of the write or the rename is the one to give.
    }
    throw error;
  }
}

// Removes the file at this path. A file that is not there changes nothing.
export function removeRecord(path: string): void {
  rmSync(path, { force: true });
}

// Makes this folder and the folders above it that are missing, from the top down, and gives each
// one it makes the folder mode at once: the mode given to mkdir is cut by the file mask, and a
// mask that takes the user's own bits would otherwise keep the next folder from being made in it.
// A folder another process makes in the meantime is taken as it is.
export function makeFolders(folder: string): void {
  const missing: string[] = [];
  for (let at = resolve(folder); !lstatSync(at, { throwIfNoEntry: false }); at = dirname(at)) {
    missing.unshift(at);
    if (dirname(at) === at) break;
  }
  for (const at of missing) {
    try {
      mkdirSync(at, { mode: FOLDER_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    chmodSync(at, FOLDER_MODE);
  }
}
