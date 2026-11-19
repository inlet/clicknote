import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRIDGE_PORT } from '../../shared/types.ts';
import { VERSION } from '../../shared/version.ts';
import { type CommandDeps, runOpen, runOpenUnlinked, runRegister, runStop, runWait } from './commands.ts';
import { secureStateDir, StateFolderError } from './guard.ts';
import { createIdle, ensureBridge, keepBridge, type Idle, type Kept } from './life.ts';
import { fileLog } from './log.ts';
import { openAddress, startOpener } from './opener.ts';
import { noteProblem, type BridgeSeen } from './record.ts';
import { type BridgeOptions, logLine, type RunningBridge, startBridge } from './server.ts';

// The oldest Node the program runs on.
export const MIN_NODE = { major: 22, minor: 0 };

// What runCli uses: the folder the command runs in, the bridge's port, the signal that ends a
// wait, how the state folder is made the user's only, how a bridge is started and then kept, how a
// command makes sure a bridge runs, how an open address is opened in the browser (false when it
// could not be), a pause and a clock in milliseconds, and how it prints. `out` prints a line on
// standard output; `write` writes the line of a send on it for a wait, and resolves once it is
// written; `err` prints an error with the program's name before it, and `note` a line on the
// error stream as it is given.
export interface CliDeps {
  cwd: string;
  port: number;
  signal: AbortSignal;                                     // ends a wait
  secure: () => void;                                      // secureStateDir
  start: (options: BridgeOptions) => Promise<RunningBridge>;
  keep: (bridge: RunningBridge, auto: boolean, idle: Idle) => void;
  ensure: () => Promise<BridgeSeen>;
  open: (address: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
  write: (line: string) => Promise<void>;                  // the line of a send, for a wait
  err: (line: string) => void;                             // with the program's name before it
  note: (line: string) => void;
}

const USAGE = [
  'Usage: clicknote [command]',
  '',
  '  (no command)                              run the bridge in the foreground',
  '  register --harness <name> --about <words> register this agent; prints its id',
  '  open <url> [--agent <id>] [--harness <name>] [--about <words>] [--address-only]',
  '                                            link a page to the agent and open it',
  '  wait <agent id> [--about <words>]         wait for annotations and print their lines',
  '  stop                                      stop the bridge',
  '  --version, --help',
];

// A command as the arguments give it. `bridge` runs the bridge: in the foreground, or with `auto`
// as a command started it.
type Command =
  | { name: 'bridge'; auto: boolean }
  | { name: 'version' }
  | { name: 'help' }
  | { name: 'register'; harness: string; about: string }
  | { name: 'open'; url: string; agent?: string; harness?: string; about?: string; addressOnly: boolean }
  | { name: 'wait'; agent: string; about?: string }
  | { name: 'stop' };

// The flags of the commands that take them: true for a flag with a value, false for one without.
const FLAGS = {
  register: { '--harness': true, '--about': true },
  open: { '--agent': true, '--harness': true, '--about': true, '--address-only': false },
  wait: { '--about': true },
} satisfies Record<string, Record<string, boolean>>;

// Whether a Node version, as process.version gives it, can run the program.
export function supportsNode(version: string): boolean {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

// Gives the exit code. With no arguments, or with --auto, it starts the bridge and gives 0 once
// it listens and is kept; the bridge then runs until it is stopped. register, open, wait and stop
// make the state folder the user's only and then run. A state folder Clicknote does not use is
// said through `err` and gives 1, and a folder that cannot be secured for another reason, such as
// one that cannot be made, throws its error on. open instead gives the page as it is, with why it
// was not linked, whatever kept the folder from being secured (see runOpenUnlinked). --version and
// --help print; anything else prints the usage and gives 2.
export async function runCli(args: string[], deps: CliDeps): Promise<number> {
  const command = parseCommand(args);
  if (command === null || command.name === 'help') {
    for (const line of USAGE) deps.out(line);
    return command === null ? 2 : 0;
  }
  if (command.name === 'version') {
    deps.out(VERSION);
    return 0;
  }
  try {
    deps.secure();
  } catch (error) {
    if (command.name === 'open') return runOpenUnlinked(command.url, errorMessage(error), deps);
    if (!(error instanceof StateFolderError)) throw error;
    deps.err(error.message);
    return 1;
  }
  const commandDeps: CommandDeps = {
    cwd: deps.cwd, port: deps.port, ensure: deps.ensure, open: deps.open, out: deps.out, note: deps.note,
  };
  switch (command.name) {
    case 'bridge':
      return runBridge(command.auto, deps);
    case 'register':
      return runRegister({ harness: command.harness, about: command.about }, commandDeps);
    case 'open':
      return runOpen({
        url: command.url, agent: command.agent, harness: command.harness, about: command.about,
        addressOnly: command.addressOnly,
      }, commandDeps);
    case 'wait':
      return runWait({ agent: command.agent, about: command.about },
        { ...commandDeps, signal: deps.signal, write: deps.write });
    case 'stop':
      return runStop({ note: deps.note, sleep: deps.sleep, now: deps.now });
  }
}

// The command the arguments give, or null for anything else: an unknown command or flag, a flag
// given twice or without its value, an argument too many, a missing URL or agent id, and a
// register without its harness or what it works on.
function parseCommand(args: string[]): Command | null {
  const [first, ...rest] = args;
  if (args.length <= 1) {
    if (first === undefined) return { name: 'bridge', auto: false };
    if (first === '--auto') return { name: 'bridge', auto: true };
    if (first === '--version') return { name: 'version' };
    if (first === '--help') return { name: 'help' };
  }
  switch (first) {
    case 'register': {
      const read = readArgs(rest, FLAGS.register);
      const harness = read?.flags.get('--harness');
      const about = read?.flags.get('--about');
      if (read?.positionals.length !== 0 || harness === undefined || about === undefined) return null;
      return { name: 'register', harness, about };
    }
    case 'open': {
      const read = readArgs(rest, FLAGS.open);
      if (read?.positionals.length !== 1) return null;
      const { flags, positionals: [url] } = read;
      return {
        name: 'open', url, agent: flags.get('--agent'), harness: flags.get('--harness'), about: flags.get('--about'),
        addressOnly: flags.has('--address-only'),
      };
    }
    case 'wait': {
      const read = readArgs(rest, FLAGS.wait);
      if (read?.positionals.length !== 1) return null;
      return { name: 'wait', agent: read.positionals[0], about: read.flags.get('--about') };
    }
    case 'stop':
      return rest.length === 0 ? { name: 'stop' } : null;
    default:
      return null;
  }
}

// The flags among the arguments, with their values, and the other arguments in order. An argument
// that starts with `--` is a flag; a flag with a value takes the argument after it, whatever it
// is, and one without gets the empty value. Null for a flag that is not `known`, one given twice,
// and one without its value.
function readArgs(args: string[], known: Record<string, boolean>): { flags: Map<string, string>; positionals: string[] } | null {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (!Object.hasOwn(known, arg) || flags.has(arg)) return null;
    if (!known[arg]) {
      flags.set(arg, '');
      continue;
    }
    if (at + 1 === args.length) return null;
    flags.set(arg, args[++at]);
  }
  return { flags, positionals };
}

// Starts the bridge on the port, with its requests as activity on a new idle clock, and hands it
// to `keep` once it listens, so its record is written only then. In the foreground the log goes to
// standard output and the address it listens on is printed; with `auto` the log goes to the log
// file and nothing is printed. Gives 0 while the bridge goes on running. A port in use gives 1:
// with `auto` the problem is noted for the command that started it, in the foreground it is said;
// the record of a bridge that runs is left as it is. A bridge that cannot be kept is closed, and
// gives 1. With `auto`, which has no terminal, a start that fails is also written in the log, as
// `start failed: port in use` or `start failed: <the error's message>`.
async function runBridge(auto: boolean, deps: CliDeps): Promise<number> {
  const idle = createIdle(deps.now);
  const log = auto ? fileLog() : deps.out;
  const failed = (reason: string): void => {
    if (auto) log(logLine('start', `failed: ${reason}`));
  };
  let bridge: RunningBridge;
  try {
    bridge = await deps.start({ port: deps.port, log, onActivity: () => idle.activity() });
  } catch (error) {
    const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
    failed(inUse ? 'port in use' : errorMessage(error));
    if (!inUse) deps.err(errorMessage(error));
    else if (auto) noteProblem('port_in_use');
    else deps.err(`Port ${deps.port} is in use. Clicknote may be running already: run stop first.`);
    return 1;
  }
  try {
    deps.keep(bridge, auto, idle);
  } catch (error) {
    await bridge.close().catch(() => undefined);
    failed(errorMessage(error));
    deps.err(errorMessage(error));
    return 1;
  }
  if (!auto) deps.out(`clicknote ${VERSION} listening on http://${bridge.address}:${bridge.port}`);
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printError(message: string): void {
  process.stderr.write(`clicknote: ${message}\n`);
}

// Writes the line, with a line break, on the stream. Resolves once the stream's write has called
// back without an error, and rejects with the error it called back with. A failed write is
// followed by the stream's error event, which would end the program when nothing listens for it;
// a listener stays on the stream for that, so the error is given through the promise alone. After
// a write that succeeds, the listener is taken off again.
export function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const passOver = (): void => {};
    stream.on('error', passOver);
    stream.write(`${line}\n`, error => {
      if (error) {
        reject(error);
        return;
      }
      stream.off('error', passOver);
      resolve();
    });
  });
}

// Whether this file is the program on a Node without import.meta.main (before 24.2): there
// `main` is undefined, and the script Node was started with is this file once links are
// resolved. A script that cannot be resolved is not this file.
export function isEntryWithoutMain(main: boolean | undefined, script: string | undefined, self: string,
  realpath: (path: string) => string = realpathSync): boolean {
  if (main !== undefined || script === undefined) return false;
  try {
    return realpath(script) === self;
  } catch {
    return false;
  }
}

// What stopOnSignals and waitSignal use of the process: its signals, with a listener for each
// time (`on`) or for the first time only (`once`), its exit, and the time in milliseconds.
interface SignalProcess {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): void;
  now(): number;
}

// The process the program runs in, with the system's clock.
const THIS_PROCESS: SignalProcess = {
  on: (signal, listener) => process.on(signal, listener),
  once: (signal, listener) => process.once(signal, listener),
  exit: code => process.exit(code),
  now: Date.now,
};

// The signals that stop the bridge: Ctrl+C, a plain kill, and the hang-up of a terminal that
// closes.
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// How long after the first stop signal another one counts as the same stop. One Ctrl+C can reach
// the bridge as two signals a few milliseconds apart: npm passes on the signal it gets, and the
// bridge gets its own as well.
const SAME_STOP_MS = 1_000;

// Stops the kept bridge on the first stop signal: its end closes it and ends the program with 0. A
// stop signal within SAME_STOP_MS of the first changes nothing; a later one ends the program at
// once, with 1.
export function stopOnSignals(kept: Kept, program: SignalProcess = THIS_PROCESS): void {
  let firstAt: number | undefined;
  const stop = () => {
    const now = program.now();
    if (firstAt === undefined) {
      firstAt = now;
      void kept.end(0);
    } else if (now - firstAt >= SAME_STOP_MS) {
      program.exit(1);
    }
  };
  for (const signal of STOP_SIGNALS) program.on(signal, stop);
}

// The signals that end a wait: Ctrl+C, a plain kill, and the hang-up of a terminal that closes. A
// wait they end takes its agent off the list (see runWait).
const WAIT_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// The signal that ends a wait, which fires on the first of WAIT_SIGNALS. Only a wait listens for
// them: a listener takes the place of Node's own handling, which ends the other commands, and the
// bridge has stopOnSignals. Each listener is there for the first time only, so a second signal of
// the same kind ends the wait as Node's own handling does.
export function waitSignal(args: string[], program: Pick<SignalProcess, 'once'> = THIS_PROCESS): AbortSignal {
  const controller = new AbortController();
  if (args[0] === 'wait') {
    for (const signal of WAIT_SIGNALS) program.once(signal, () => controller.abort());
  }
  return controller.signal;
}

// Starts a program apart from this one. A program that cannot be started reports that as an
// event, which would end this program when nothing listens for it; here it is let go.
function startApart(file: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(file, args, options);
  child.on('error', () => {});
  return child;
}

async function main(args: string[]): Promise<void> {
  const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
  // The file mask the program was started with, for the browser the opener starts. The mask is
  // made user-only here already, as securing the state folder makes it for every command.
  const startMask = process.umask(0o077);
  process.exitCode = await runCli(args, {
    cwd: process.cwd(),
    port: BRIDGE_PORT,
    signal: waitSignal(args),
    secure: () => { secureStateDir(); },
    start: startBridge,
    keep: (bridge, auto, idle) => {
      stopOnSignals(keepBridge({
        bridge, auto, idle, pid: process.pid,
        every: (ms, tick) => {
          const timer = setInterval(tick, ms);
          return { stop: () => clearInterval(timer) };
        },
        exit: code => process.exit(code),
      }));
    },
    ensure: () => ensureBridge({
      spawn: startApart,
      execPath: process.execPath,
      self: fileURLToPath(import.meta.url),
      env: process.env,
      sleep,
      now: Date.now,
    }),
    open: address => openAddress(address, {
      platform: process.platform,
      start: (file, args) => startOpener(file, args, startMask),
    }),
    sleep,
    now: Date.now,
    out: line => process.stdout.write(`${line}\n`),
    write: line => writeLine(process.stdout, line),
    err: printError,
    note: line => process.stderr.write(`${line}\n`),
  });
}

// Runs only as the program, not when a test imports this file. The Node version is checked first.
if (import.meta.main || isEntryWithoutMain(import.meta.main, process.argv[1], fileURLToPath(import.meta.url))) {
  if (supportsNode(process.version)) {
    main(process.argv.slice(2)).catch((error: unknown) => {
      printError(errorMessage(error));
      process.exitCode = 1;
    });
  } else {
    printError(`needs Node ${MIN_NODE.major} or later, and this is Node ${process.version.replace(/^v/, '')}`);
    process.exitCode = 1;
  }
}
