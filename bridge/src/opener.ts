import { type ChildProcess, spawn } from 'node:child_process';
import { BRIDGE_HOST, BRIDGE_PORT, BRIDGE_PORT_E2E } from '../../shared/types.ts';
import { LINK_CODE } from './links.ts';

// Opens the bridge's own open address in the user's default browser, and nothing else: whatever
// is asked of it, it hands the system's opener only an address of that one form. It starts no
// shell.

// The beginnings of an open address, on the bridge's port and on the port of the test build.
const OPEN_PREFIXES = [BRIDGE_PORT, BRIDGE_PORT_E2E].map(port => `http://${BRIDGE_HOST}:${port}/open/`);

// Whether this is exactly an open address: one of those beginnings and a link's code, with
// nothing before it and nothing after it.
export function isOpenAddress(address: string): boolean {
  return OPEN_PREFIXES.some(prefix => address.startsWith(prefix) && LINK_CODE.test(address.slice(prefix.length)));
}

// The program that opens an address in the default browser on this system, and the arguments that
// go before the address. None of them is a shell.
export function openerFor(platform: NodeJS.Platform): { file: string; args: string[] } {
  if (platform === 'darwin') return { file: 'open', args: [] };
  if (platform === 'win32') return { file: 'rundll32', args: ['url.dll,FileProtocolHandler'] };
  return { file: 'xdg-open', args: [] };
}

// Opens an open address with the system's opener, started by `start` with its arguments and then
// the address; `start` gives whether the opener was started. Gives true when it was; false, and
// starts nothing, for any other address; false when the opener cannot be started, whether `start`
// says so or throws.
export function openAddress(address: string,
  deps: { platform: NodeJS.Platform; start: (file: string, args: string[]) => boolean }): boolean {
  if (!isOpenAddress(address)) return false;
  const opener = openerFor(deps.platform);
  try {
    return deps.start(opener.file, [...opener.args, address]);
  } catch {
    return false;
  }
}

// Starts the program with these arguments apart from this process, without its streams and
// without waiting for it, and gives whether it was started. It runs with the file mask `mask`,
// the one the command was started with, not the user-only mask the command sets for the state
// folder: a browser the opener starts would otherwise make every download readable by the user
// alone. This process keeps its own mask. A program that cannot be started, as one that does not
// exist, has no process id right after the start, and reports that as an event afterwards, which
// is let go here: nothing listening for it would end this process.
export function startOpener(file: string, args: string[], mask: number): boolean {
  const own = process.umask(mask);
  let child: ChildProcess;
  try {
    child = spawn(file, args, { detached: true, stdio: 'ignore' });
  } finally {
    process.umask(own);
  }
  child.on('error', () => {});
  child.unref();
  return child.pid !== undefined;
}
