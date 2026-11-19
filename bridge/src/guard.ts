import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { stateDir } from './paths.ts';

// The modes of what is in the state folder: its folders and its files are the user's only.
const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;

// A state folder Clicknote does not use: one that is not a full path, one that is a link, one that
// is not a folder, or one of another user.
export class StateFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateFolderError';
  }
}

// Makes the state folder the user's only, and gives its path. Sets the process's file mask to
// 077, so that what the process writes afterwards is user-only without a mode being given; refuses
// a path that is not a full path, before anything is made, as it would name another folder from
// every working folder; makes the folder when it is missing; refuses a folder that is a link, a
// path that is not a folder, and a folder whose owner is not `uid`; closes the folder; and closes
// what is open inside it, at every depth. Every check is made with lstat, so nothing follows a
// link: a link inside the folder is left as it is. A failure to make or close the folder itself
// throws. A `uid` of null skips the owner check. On Windows only the mask is set, a path that is
// not a full path refused, the folder made and a path that is not a folder refused: it has no
// modes for other users and no owner in a file's uid, and a link there is not refused, so the
// folder it leads to is what counts.
export function secureStateDir(uid: number | null = process.getuid?.() ?? null): string {
  process.umask(0o077);
  const dir = stateDir();
  if (!isAbsolute(dir)) {
    throw new StateFolderError(`The state folder ${dir} is not a full path. Clicknote does not use it.`);
  }
  if (!lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir, { recursive: true, mode: FOLDER_MODE });
  if (process.platform === 'win32') {
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw notAFolder(dir);
    return dir;
  }
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink()) throw new StateFolderError(`The state folder ${dir} is a link. Clicknote does not use it.`);
  if (!stats.isDirectory()) throw notAFolder(dir);
  if (uid !== null && stats.uid !== uid) {
    throw new StateFolderError(`The state folder ${dir} belongs to another user. Clicknote does not use it.`);
  }
  setMode(dir, stats);
  closeInside(dir);
  return dir;
}

function notAFolder(dir: string): StateFolderError {
  return new StateFolderError(`The state folder ${dir} is not a folder. Clicknote does not use it.`);
}

// Sets this entry, whose stats come from lstat and which is not a link, to FOLDER_MODE when it is
// a folder and to FILE_MODE otherwise, when it has another mode.
function setMode(path: string, stats: Stats): void {
  const mode = stats.isDirectory() ? FOLDER_MODE : FILE_MODE;
  if ((stats.mode & 0o777) !== mode) chmodSync(path, mode);
}

// Closes what is in this folder, which is closed already, at every depth; a link is left as it
// is. An entry that cannot be closed, as one of another user or one the bridge removes meanwhile,
// is passed over with what is in it, and the rest are closed: no other account can reach it
// through the closed folder.
function closeInside(folder: string): void {
  for (const name of readdirSync(folder)) {
    const entry = join(folder, name);
    try {
      const stats = lstatSync(entry);
      if (stats.isSymbolicLink()) continue;
      setMode(entry, stats);
      if (stats.isDirectory()) closeInside(entry);
    } catch {
      continue;
    }
  }
}
