import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  type CliDeps, isEntryWithoutMain, runCli, stopOnSignals, supportsNode, waitSignal, writeLine,
} from '../../bridge/src/cli.ts';
import { StateFolderError } from '../../bridge/src/guard.ts';
import { enqueue } from '../../bridge/src/inbox.ts';
import { IDLE_MS, type Idle, type Kept } from '../../bridge/src/life.ts';
import { startBeacon } from '../../bridge/src/presence.ts';
import { BRIDGE_KEY, STATE_FORMAT, seeBridge, writeBridgeRecord, type BridgeSeen } from '../../bridge/src/record.ts';
import type { BridgeOptions, RunningBridge } from '../../bridge/src/server.ts';
import { VERSION } from '../../shared/version.ts';

const cliPath = join(import.meta.dirname, '../../bridge/src/cli.ts');

let dir = '';
let saved: string | undefined;
let started: BridgeOptions[] = [];                   // the options of each start
let kept: [RunningBridge, boolean, Idle][] = [];     // what each keep was given
let opened: string[] = [];                           // the addresses opened in the browser
let secured = 0;                                     // how often the state folder was secured
let time = 0;                                        // the clock, moved by sleep
let out: string[] = [];
let err: string[] = [];
let notes: string[] = [];
beforeEach(() => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
  started = [];
  kept = [];
  opened = [];
  secured = 0;
  time = 0;
  out = [];
  err = [];
  notes = [];
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
  else process.env.CLICKNOTE_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const running: BridgeSeen = { state: 'running', record: { pid: 1, version: VERSION, format: STATE_FORMAT, port: 47823, auto: true } };

// What runCli needs: a project folder named my-site, the bridge's port, a wait that is never ended,
// a state folder that is only counted, a start that records its options and starts nothing, a keep
// that records what it is given, a bridge that runs, a browser that records what it opens, a clock
// that moves only when it sleeps, and lines printed or written by a wait into `out`, errors into
// `err` and notes into `notes`.
const deps: CliDeps = {
  cwd: '/Users/you/code/my-site',
  port: 47823,
  signal: new AbortController().signal,
  secure: () => { secured++; },
  start: async options => {
    started.push(options);
    return { port: 47823, address: '127.0.0.1', close: async () => {} };
  },
  keep: (bridge, auto, idle) => { kept.push([bridge, auto, idle]); },
  ensure: async () => running,
  open: address => {
    opened.push(address);
    return true;
  },
  sleep: async ms => { time += ms; },
  now: () => time,
  out: line => { out.push(line); },
  write: async line => { out.push(line); },
  err: line => { err.push(line); },
  note: line => { notes.push(line); },
};

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

test('--version prints the version', async () => {
  assert.equal(await runCli(['--version'], deps), 0);
  assert.deepEqual(out, ['0.4.0']);
});

test('--help prints the usage, which names every command', async () => {
  assert.equal(await runCli(['--help'], deps), 0);
  for (const part of ['register --harness <name> --about <words>', 'open <url>', 'wait <agent id>', 'stop', '--address-only']) {
    assert.equal(out.some(line => line.includes(part)), true, part);
  }
});

test('the usage is printed as it is written', async () => {
  assert.equal(await runCli(['--help'], deps), 0);
  assert.deepEqual(out, USAGE);
});

test('with no arguments the bridge starts in the foreground, says where it listens, and is kept', async () => {
  assert.equal(await runCli([], deps), 0);
  assert.equal(started.length, 1);
  assert.equal(typeof started[0].onActivity, 'function');
  assert.deepEqual(out, [`clicknote ${VERSION} listening on http://127.0.0.1:47823`]);
  assert.deepEqual(kept.map(([, auto]) => auto), [false]);
  assert.equal(secured, 1);
});

test('the bridge starts on the port given and logs its requests on standard output', async () => {
  assert.equal(await runCli([], deps), 0);
  assert.equal(started[0].port, 47823);
  started[0].log?.('12:00:00 agents ok');
  assert.equal(out.at(-1), '12:00:00 agents ok');
});

test('a request to the bridge counts as activity on the idle clock it is kept with, which runs on the clock given', async () => {
  assert.equal(await runCli(['--auto'], deps), 0);
  const idle = kept[0][2];
  assert.equal(idle.due(0), false);
  time = IDLE_MS - 1;
  started[0].onActivity?.();
  time = IDLE_MS;
  assert.equal(idle.due(0), false);
  time = 2 * IDLE_MS - 1;
  assert.equal(idle.due(0), true);
});

test('with --auto the bridge prints nothing, logs to its file, and is kept as auto', async () => {
  assert.equal(await runCli(['--auto'], deps), 0);
  assert.deepEqual([out, kept.map(([, auto]) => auto)], [[], [true]]);
  started[0].log?.('12:00:00 agents ok');
  assert.equal(readdirSync(dir).some(name => name.endsWith('.log')), true);
});

test('a taken port: in the foreground it is said, with --auto it is noted, and the record of the bridge that runs stays', async () => {
  const record = { pid: 1, version: VERSION, format: STATE_FORMAT, port: 47823, auto: true };
  writeBridgeRecord(record);
  const taken = { ...deps, start: async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }); } };
  assert.equal(await runCli([], taken), 1);
  assert.deepEqual(err, ['Port 47823 is in use. Clicknote may be running already: run stop first.']);
  assert.equal(await runCli(['--auto'], taken), 1);
  assert.deepEqual(seeBridge(), { state: 'down', problem: 'port_in_use' });
  assert.equal(kept.length, 0);
  const beacon = startBeacon('bridge', BRIDGE_KEY);
  try {
    assert.deepEqual(seeBridge(), { state: 'running', record });
  } finally {
    beacon.stop();
  }
});

// The lines of the bridge's log file, each without the time it starts with.
function logged(): string[] {
  const lines = readFileSync(join(dir, 'bridge.log'), 'utf8').trimEnd().split('\n');
  for (const line of lines) assert.match(line, /^\d\d:\d\d:\d\d /);
  return lines.map(line => line.slice('HH:MM:SS '.length));
}

test('with --auto, a start that fails is written in the log', async () => {
  const taken = { ...deps, start: async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }); } };
  const failing = { ...deps, start: async () => { throw new Error('listen EACCES: permission denied'); } };
  const unkept = { ...deps, keep: () => { throw new Error('EACCES: permission denied'); } };
  for (const startDeps of [taken, failing, unkept]) assert.equal(await runCli(['--auto'], startDeps), 1);
  assert.deepEqual(logged(), ['start failed: port in use', 'start failed: listen EACCES: permission denied',
    'start failed: EACCES: permission denied']);
  assert.deepEqual(seeBridge(), { state: 'down', problem: 'port_in_use' });
});

test('in the foreground, a start that fails is said and not logged', async () => {
  const failing = { ...deps, start: async () => { throw new Error('listen EACCES: permission denied'); } };
  assert.equal(await runCli([], failing), 1);
  assert.equal(readdirSync(dir).includes('bridge.log'), false);
});

test('a bridge that fails to start for another reason is said and gives 1', async () => {
  const failing = { ...deps, start: async () => { throw new Error('listen EACCES: permission denied'); } };
  assert.equal(await runCli([], failing), 1);
  assert.deepEqual([err, kept.length], [['listen EACCES: permission denied'], 0]);
});

// A bridge that listens without its record would hold the port with nothing to stop it.
test('a bridge that cannot be kept is closed, said and gives 1', async () => {
  let closed = 0;
  const unkept = {
    ...deps,
    start: async () => ({ port: 47823, address: '127.0.0.1', close: async () => { closed++; } }),
    keep: () => { throw new Error('EACCES: permission denied'); },
  };
  assert.equal(await runCli([], unkept), 1);
  assert.deepEqual([closed, err, out], [1, ['EACCES: permission denied'], []]);
});

test('the program runs register, open, wait and stop with what follows them', async () => {
  assert.equal(await runCli(['register', '--harness', 'claude-code', '--about', 'landing page copy'], deps), 0);
  const id = out[0].slice(7);
  assert.equal(out[1], 'listed as: my-site · landing page copy · claude-code');
  out.length = 0;
  assert.equal(await runCli(['open', 'http://localhost:5173/', '--agent', id, '--address-only'], deps), 0);
  assert.match(out[2], /^open this address: http:\/\/127\.0\.0\.1:47823\/open\/[0-9a-f]{32}$/);
  assert.equal(await runCli(['stop'], deps), 0);
  assert.equal(notes.at(-1), 'Clicknote was not running.');
  assert.equal(await runCli(['wait', '000000000000'], deps), 1);
});

test('open takes its flags before or after the URL, and opens the page in the browser without --address-only', async () => {
  assert.equal(await runCli(['open', '--harness', 'codex', '--about', 'the nav', 'http://localhost:5173/'], deps), 0);
  assert.equal(out[1], 'listed as: my-site · the nav · codex');
  assert.equal(opened.length, 1);
  assert.equal(out[2], 'opened: http://localhost:5173/');
});

test('each command secures the state folder first', async () => {
  await runCli(['register', '--harness', 'x', '--about', ''], deps);
  await runCli(['open', 'http://localhost:5173/', '--address-only'], deps);
  await runCli(['wait', '000000000000'], deps);
  await runCli(['stop'], deps);
  assert.equal(secured, 4);
});

test('a command that is not complete prints the usage and gives 2', async () => {
  for (const args of [['open'], ['wait'], ['register', '--harness'], ['open', 'http://x/', '--nope'], ['link', 'http://x/']]) {
    assert.equal(await runCli(args, deps), 2, args.join(' '));
  }
});

test('anything else prints the usage, gives 2, and starts and secures nothing', async () => {
  const cases = [
    ['install'], ['--port', '1'], ['--auto', 'x'], ['--version', 'x'], ['stop', 'now'],
    ['register', '--harness', 'x'], ['register', '--about', 'x'], ['register', '--harness', 'x', '--about', 'y', 'z'],
    ['open', 'http://x/', 'http://y/'], ['open', 'http://x/', '--agent'], ['open', 'http://x/', '--about', 'a', '--about', 'b'],
    ['wait', '000000000000', '000000000001'], ['wait', '000000000000', '--agent', '000000000001'],
  ];
  for (const args of cases) {
    out = [];
    assert.equal(await runCli(args, deps), 2, args.join(' '));
    assert.deepEqual(out, USAGE, args.join(' '));
  }
  assert.deepEqual([started.length, secured, notes], [0, 0, []]);
});

const refused = { ...deps, secure: () => { throw new StateFolderError('The state folder /x is a link. Clicknote does not use it.'); } };

test('a state folder that cannot be used is said and gives 1', async () => {
  assert.equal(await runCli(['register', '--harness', 'x', '--about', ''], refused), 1);
  assert.deepEqual(err, ['The state folder /x is a link. Clicknote does not use it.']);
  for (const args of [[], ['--auto'], ['wait', '000000000000'], ['stop']]) {
    assert.equal(await runCli(args, refused), 1, args.join(' '));
  }
  assert.deepEqual([started.length, out], [0, []]);
});

test('with a state folder that cannot be used, open gives the page as it is, with why it was not linked', async () => {
  assert.equal(await runCli(['open', 'http://localhost:5173/', '--harness', 'x'], refused), 0);
  assert.deepEqual([out, notes, err, opened], [['open this address: http://localhost:5173/'],
    ['Not linked: The state folder /x is a link. Clicknote does not use it.'], [], []]);
});

test('with a state folder that cannot be used, open of a URL that cannot be linked gives 1 with its own message', async () => {
  assert.equal(await runCli(['open', 'localhost:5173'], refused), 1);
  assert.deepEqual([out, err], [[], []]);
  assert.deepEqual(notes, ['Cannot open "localhost:5173": give the full URL, starting with http://, https:// or file://, '
    + 'with a space written as %20.']);
});

// The first run in a sandboxed shell, where the state folder cannot be made.
const unmade = {
  ...deps,
  secure: () => { throw Object.assign(new Error("EACCES: permission denied, mkdir '/x/state'"), { code: 'EACCES' }); },
};

test("open gives the page's address when the state folder cannot be made", async () => {
  assert.equal(await runCli(['open', 'https://example.com/', '--harness', 'codex', '--about', 'x'], unmade), 0);
  assert.deepEqual([out, notes, err, opened], [['open this address: https://example.com/'],
    ["Not linked: EACCES: permission denied, mkdir '/x/state'"], [], []]);
});

test('open with a URL that cannot be linked gives 1 also when the state folder cannot be made', async () => {
  assert.equal(await runCli(['open', 'localhost:5173', '--harness', 'codex', '--about', 'x'], unmade), 1);
  assert.deepEqual([out, err, opened], [[], [], []]);
  assert.deepEqual(notes, ['Cannot open "localhost:5173": give the full URL, starting with http://, https:// or file://, '
    + 'with a space written as %20.']);
});

test('a line is written on a stream that takes it, and the stream keeps no listener of the write', async () => {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk: Buffer, _encoding, done) { chunks.push(chunk.toString('utf8')); done(); } });
  await writeLine(stream, 'Browser annotations (1) on x');
  assert.deepEqual(chunks, ['Browser annotations (1) on x\n']);
  assert.equal(stream.listenerCount('error'), 0);
});

// The error event of the stream follows the failed write; nothing listening for it would end the
// program.
test('a line on a stream whose write fails rejects with the error, and the error event ends nothing', async () => {
  const stream = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } });
  await assert.rejects(writeLine(stream, 'x'), { code: 'EPIPE' });
  await new Promise(done => setImmediate(done));
  assert.equal(stream.destroyed, true);
});

test('the wait writes the lines of its sends through the writer', async () => {
  const written: string[] = [];
  const writing = { ...deps, write: async (line: string) => { written.push(line); } };
  assert.equal(await runCli(['register', '--harness', 'x', '--about', ''], writing), 0);
  const id = out[0].slice('agent: '.length);
  enqueue(id, { send: '00000000000000a1', folder: '/x', line: 'the line of the send' });
  assert.equal(await runCli(['wait', id], writing), 0);
  assert.deepEqual(written, ['the line of the send']);
});

test('supportsNode accepts 22 and later only', () => {
  assert.equal(supportsNode('v21.9.0'), false);
  assert.equal(supportsNode('v22.0.0'), true);
  assert.equal(supportsNode('v26.10.0'), true);
});

// Starts Node as a program with the temporary state folder, so a child that started the bridge by
// mistake could never reach the real state folder.
function runProgram(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, CLICKNOTE_STATE_DIR: dir };
  return spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 10_000 });
}

test('the program prints its version', () => {
  const result = runProgram([cliPath, '--version']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0.4.0\n');
});

// The program itself, run as a process: the usage goes to standard output, nothing to the error
// stream, and the state folder is not made.
test('the program prints the usage for an unknown command, gives 2, and makes no state folder', () => {
  const state = join(dir, 'state');
  const result = spawnSync(process.execPath, [cliPath, 'frobnicate'],
    { encoding: 'utf8', env: { ...process.env, CLICKNOTE_STATE_DIR: state }, timeout: 10_000 });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, `${USAGE.join('\n')}\n`);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(state), false);
});

test('the program says an error with its name before it', () => {
  const result = spawnSync(process.execPath, [cliPath, 'stop'],
    { encoding: 'utf8', env: { ...process.env, CLICKNOTE_STATE_DIR: 'relative/state' }, timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^clicknote: /);
  assert.equal(result.stdout, '');
});

test('isEntryWithoutMain is true only for this file as the program on a Node without import.meta.main', () => {
  const real = '/repo/dist/bridge/cli.mjs';
  const files = new Map([[real, real], ['/bin/link-to-cli', real], ['/repo/test/x.test.ts', '/repo/test/x.test.ts']]);
  const realpath = (path: string) => {
    const resolved = files.get(path);
    if (resolved === undefined) throw new Error(`ENOENT: ${path}`);
    return resolved;
  };
  assert.equal(isEntryWithoutMain(undefined, real, real, realpath), true);
  assert.equal(isEntryWithoutMain(undefined, '/bin/link-to-cli', real, realpath), true);
  assert.equal(isEntryWithoutMain(true, real, real, realpath), false);
  assert.equal(isEntryWithoutMain(false, real, real, realpath), false);
  assert.equal(isEntryWithoutMain(undefined, '/repo/test/x.test.ts', real, realpath), false);
  assert.equal(isEntryWithoutMain(undefined, '/missing', real, realpath), false);
  assert.equal(isEntryWithoutMain(undefined, undefined, real, realpath), false);
});

test('isEntryWithoutMain resolves links on disk by default',
  { skip: process.platform === 'win32' && 'making a link on Windows needs a privilege the tests may not have' }, () => {
  const link = join(dir, 'cli-link.ts');
  symlinkSync(cliPath, link);
  assert.equal(isEntryWithoutMain(undefined, link, realpathSync(cliPath)), true);
  assert.equal(isEntryWithoutMain(undefined, join(dir, 'missing.ts'), realpathSync(cliPath)), false);
});

// Started by an import, the bridge would print its listening line and keep running until the
// timeout.
test('importing the CLI runs nothing', () => {
  const importIt = `import ${JSON.stringify(pathToFileURL(cliPath).href)};`;
  const result = runProgram(['--input-type=module', '-e', importIt]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

// A stand-in for what stopOnSignals and waitSignal use of the process, with a clock the test sets.
// A signal at a time goes to its listeners, and a listener added with `once` is taken off as it is
// called; with none, Node's default would end the program, which is recorded.
function signalProcess(calls: string[]) {
  const listeners = new Map<string, { listener: () => void; once: boolean }[]>();
  let clock = 0;
  const add = (signal: string, listener: () => void, once: boolean) => {
    listeners.set(signal, [...(listeners.get(signal) ?? []), { listener, once }]);
  };
  return {
    on: (signal: string, listener: () => void) => add(signal, listener, false),
    once: (signal: string, listener: () => void) => add(signal, listener, true),
    exit: (code: number) => { calls.push(`exit(${code})`); },
    now: () => clock,
    signal: (signal: string, at: number) => {
      clock = at;
      const listening = listeners.get(signal) ?? [];
      if (listening.length === 0) calls.push('ended by the signal');
      listeners.set(signal, listening.filter(({ once }) => !once));
      for (const { listener } of listening) listener();
    },
  };
}

// A stand-in for a kept bridge that records its end, which never finishes, so later signals come
// while the bridge is stopping.
function heldKept(calls: string[]): Kept {
  return {
    end: code => {
      calls.push(`end(${code})`);
      return new Promise(() => {});
    },
  };
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// One Ctrl+C can come as two signals a few milliseconds apart: npm passes on the signal it gets,
// and the bridge gets its own as well.
test('a stop signal ends the kept bridge with 0, and its repeat changes nothing', () => {
  for (const signal of STOP_SIGNALS) {
    const calls: string[] = [];
    const program = signalProcess(calls);
    stopOnSignals(heldKept(calls), program);
    program.signal(signal, 0);
    assert.deepEqual(calls, ['end(0)'], signal);
    program.signal(signal, 4);
    assert.deepEqual(calls, ['end(0)'], `${signal}: the repeat`);
  }
});

test('a stop signal a second after the first ends the program at once, with 1', () => {
  for (const signal of STOP_SIGNALS) {
    const calls: string[] = [];
    const program = signalProcess(calls);
    stopOnSignals(heldKept(calls), program);
    program.signal(signal, 0);
    program.signal(signal, 1000);
    assert.deepEqual(calls, ['end(0)', 'exit(1)'], signal);
  }
});

test('another stop signal within the second is ignored too', () => {
  const calls: string[] = [];
  const program = signalProcess(calls);
  stopOnSignals(heldKept(calls), program);
  program.signal('SIGHUP', 0);
  program.signal('SIGTERM', 4);
  assert.deepEqual(calls, ['end(0)']);
});

// A terminal that closes sends its programs a hang-up.
test('a hang-up ends a wait', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const calls: string[] = [];
    const program = signalProcess(calls);
    const ended = waitSignal(['wait', '000000000000'], program);
    assert.equal(ended.aborted, false, signal);
    program.signal(signal, 0);
    assert.deepEqual([ended.aborted, calls], [true, []], signal);
  }
});
