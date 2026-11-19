import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

const STATE_NAME = 'clicknote';

// The folder for the bridge's files, for this platform, environment and home folder:
// - every system: CLICKNOTE_STATE_DIR when it is set;
// - win32: %LOCALAPPDATA%\clicknote, else <home>\AppData\Local\clicknote;
// - any other: <home>/.local/state/clicknote.
// CLICKNOTE_STATE_DIR is used as it is given when it is not empty. A LOCALAPPDATA that is empty
// or not an absolute path is not used. XDG_STATE_HOME is not used: a process started with a
// reduced environment would look in another folder than the rest. The path rules are those of
// the platform given, so the answer is the same on every system.
export function stateDirFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.CLICKNOTE_STATE_DIR) return env.CLICKNOTE_STATE_DIR;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const base = local && win32.isAbsolute(local) ? local : win32.join(home, 'AppData', 'Local');
    return win32.join(base, STATE_NAME);
  }
  return posix.join(home, '.local', 'state', STATE_NAME);
}

// The folder for the bridge's files on this system.
export function stateDir(): string {
  return stateDirFor(process.platform, process.env, homedir());
}
