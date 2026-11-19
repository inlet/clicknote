import { resolve } from 'node:path';
import { VERSION } from '../../shared/version.ts';
import { stateDir } from './paths.ts';
import { startBeacon } from './presence.ts';
import {
  BRIDGE_KEY, STATE_FORMAT, clearOwnRecord, clearProblem, clearStop, readBridgeRecord, seeBridge, stopRequested,
  writeBridgeRecord, type BridgeRecord, type BridgeSeen,
} from './record.ts';
import { listAgents } from './registry.ts';
import type { RunningBridge } from './server.ts';

// The life of the bridge: a command starts one when none runs, and the bridge says that it runs,
// stops when it is asked to, and, when a command started it, stops by itself once it is idle.

// How long a bridge that a command started stays without agents and without requests before it
// stops.
export const IDLE_MS = 600_000;
// How often the bridge looks for a stop request, at its idle clock and at its record. Well within
// the five seconds that stop waits for the bridge to be gone.
export const TICK_MS = 1_000;
// How long a command waits for the bridge it started to run.
export const START_WAIT_MS = 5_000;
// How often a command looks whether the bridge it started runs.
const START_LOOK_MS = 100;

// The idle clock of a bridge: `activity` is a request from the extension, `due` asks, with the
// number of agents listed, whether the bridge has been idle for long enough.
export interface Idle { activity(): void; due(agents: number): boolean }

// An idle clock on the time `now` gives. `due(agents)` is true when there are no agents and
// `idleMs` have passed since the later of the last activity and the first `due(0)` since the
// start or since a `due` with agents; a `due` with agents is false and starts that over.
export function createIdle(now: () => number, idleMs: number = IDLE_MS): Idle {
  let active = -Infinity;
  let emptySince: number | null = null;
  return {
    activity() {
      active = now();
    },
    due(agents) {
      if (agents > 0) {
        emptySince = null;
        return false;
      }
      const at = now();
      emptySince ??= at;
      return at - Math.max(active, emptySince) >= idleMs;
    },
  };
}

// What starting a bridge uses: how a program is started, Node, this program's file, the
// environment to start it with, and a pause and a clock in milliseconds.
export interface StartDeps {
  spawn: (file: string, args: string[], options: {
    detached: true; stdio: 'ignore'; windowsHide: true; cwd: string; env: NodeJS.ProcessEnv;
  }) => { unref(): void };
  execPath: string;        // Node
  self: string;            // this program's file
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

// Makes sure a bridge runs, and gives the bridge as it is then. A bridge that runs, of this
// version or another, is given as it is. When none lives, it forgets a problem noted before,
// starts this program with --auto on its own, apart from the command, in the state folder and with
// it in its environment, and looks every START_LOOK_MS: it gives the first look that finds a
// bridge, or the last one, down with the problem the start noted, after START_WAIT_MS. The bridge
// runs in the state folder so that it does not hold on to the folder the command runs in. It gets
// the folder's full path, resolved against the command's folder: a relative path would name
// another folder from the bridge's.
export async function ensureBridge(deps: StartDeps): Promise<BridgeSeen> {
  const seen = seeBridge();
  if (seen.state !== 'down') return seen;
  clearProblem();
  const dir = resolve(stateDir());
  const env = { ...deps.env, CLICKNOTE_STATE_DIR: dir };
  deps.spawn(deps.execPath, [deps.self, '--auto'], { detached: true, stdio: 'ignore', windowsHide: true, cwd: dir, env }).unref();
  const until = deps.now() + START_WAIT_MS;
  for (;;) {
    await deps.sleep(START_LOOK_MS);
    const look = seeBridge();
    if (look.state !== 'down' || deps.now() >= until) return look;
  }
}

// What keeping a bridge uses: the bridge that listens, whether a command started it, its idle
// clock, the id of its process, a timer that calls `tick` every `ms`, and the end of the program.
export interface KeepDeps {
  bridge: RunningBridge; auto: boolean; idle: Idle; pid: number;
  every: (ms: number, tick: () => void) => { stop(): void };
  exit: (code: number) => void;
}

// A kept bridge, which `end` stops.
export interface Kept { end(code: number): Promise<void> }

// Keeps a bridge that listens: clears a stop request that was left, writes the bridge's record,
// starts its beacon, and looks every TICK_MS. It ends the bridge with 0 when a stop is requested,
// and, for a bridge a command started, when its idle clock is due with the agents listed. A look
// that does not end it writes the record again when the record is missing or names another
// process: a bridge that listens holds the port, so such a record is out of date.
//
// `end` works once, and a later call gives the same promise. It stops the looks, clears the stop
// request, starts closing the bridge, stops the beacon, removes the record only when it still
// names this process, waits for the close to finish, also when it fails, and exits with the code.
// The port is free from the start of the close, and the close can take seconds while a request is
// under way, so another bridge may start and write its record in that time: once the record is
// handled, the bridge removes nothing more.
export function keepBridge(deps: KeepDeps): Kept {
  clearStop();
  const record: BridgeRecord = {
    pid: deps.pid, version: VERSION, format: STATE_FORMAT, port: deps.bridge.port, auto: deps.auto,
  };
  writeBridgeRecord(record);
  const beacon = startBeacon('bridge', BRIDGE_KEY, deps.pid);
  let ending: Promise<void> | undefined;
  const end = (code: number): Promise<void> => {
    ending ??= (async () => {
      ticking.stop();
      quietly(clearStop);
      const closed = startClose(deps.bridge);
      beacon.stop();
      quietly(() => clearOwnRecord(deps.pid));
      await closed;
      deps.exit(code);
    })();
    return ending;
  };
  const ticking = deps.every(TICK_MS, () => {
    if (stopRequested() || (deps.auto && deps.idle.due(listAgents().length))) {
      void end(0);
      return;
    }
    if (readBridgeRecord()?.pid !== deps.pid) quietly(() => writeBridgeRecord(record));
  });
  return { end };
}

// Starts closing the bridge, and gives a promise that resolves once the close has finished, also
// when it fails: a bridge that fails to close is ended all the same.
function startClose(bridge: RunningBridge): Promise<void> {
  try {
    return bridge.close().catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

// Writes or removes a file of the bridge's, and goes on when that fails: a record left behind no
// longer counts once the beacon is gone, a record that cannot be written is written at the next
// look, and the next bridge clears a stop request at its start.
function quietly(change: () => void): void {
  try {
    change();
  } catch {
    // The file stays as it is; the bridge goes on, or still ends.
  }
}
