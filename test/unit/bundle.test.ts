import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { present, startBeacon } from '../../bridge/src/presence.ts';
import { BRIDGE_KEY, STATE_FORMAT, readBridgeRecord, writeBridgeRecord } from '../../bridge/src/record.ts';
import { startBridge, type RunningBridge } from '../../bridge/src/server.ts';
import { EXTENSION_ID } from '../../shared/extension-id.ts';
import { PROTOCOL } from '../../shared/types.ts';
import { VERSION } from '../../shared/version.ts';

const ROOT = join(import.meta.dirname, '../..');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// The content script as build.mjs bundles it: for the extension (__E2E__ false) or for the
// browser tests (__E2E__ true).
async function contentScript(e2e: boolean): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, 'extension/src/content/main.ts')],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    define: { __E2E__: JSON.stringify(e2e) },
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// The mode the bundle attaches the UI's shadow root with: the expression esbuild left in the
// call, such as `false ? "open" : "closed"`, evaluated.
function rootMode(bundle: string): unknown {
  const calls = [...bundle.matchAll(/attachShadow\(\{\s*mode:\s*([^}]*?)\s*\}\)/g)];
  assert.equal(calls.length, 1, 'one attachShadow call with a mode');
  return new Function(`return (${calls[0][1]});`)();
}

test('the extension build closes the shadow root of the UI, and the test build opens it', async () => {
  assert.equal(rootMode(await contentScript(false)), 'closed');
  assert.equal(rootMode(await contentScript(true)), 'open');
});

// npm prepares a package fetched from git, and so installs its development dependencies on the
// user's machine, when it has one of these scripts or workspaces.
test('the package runs the committed bridge bundle and builds nothing on install', () => {
  assert.deepEqual(packageJson.bin, { clicknote: 'dist/bridge/cli.mjs' });
  for (const name of ['prepare', 'prepack', 'build', 'install', 'preinstall', 'postinstall']) {
    assert.equal(name in packageJson.scripts, false, name);
  }
  assert.equal('workspaces' in packageJson, false, 'workspaces');
});

test('the committed bridge bundle starts with Node and knows its version', () => {
  const bundle = join(ROOT, 'dist/bridge/cli.mjs');
  assert.equal(readFileSync(bundle, 'utf8').startsWith('#!/usr/bin/env node\n'), true);
  const result = spawnSync(process.execPath, [bundle, '--version'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '0.4.0\n');
});

// The ids of the agents this bridge lists, asked as the extension asks.
function listedBy(bridge: RunningBridge): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port: bridge.port, method: 'POST', path: '/bridge',
      headers: { 'content-type': 'application/json', origin: `chrome-extension://${EXTENSION_ID}` } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).body.agents.map((agent: { id: string }) => agent.id));
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ protocol: PROTOCOL, version: 'test', body: { type: 'agents', url: 'http://localhost:5173/' } }));
  });
}

// On Windows a kill ends a process without telling it.
const WITH_SIGNALS = { skip: process.platform === 'win32' && 'Windows ends a process without telling it' };

const BUILT = join(ROOT, 'dist/bridge/cli.mjs');

// The bridge bundle as build.mjs makes it from the source as it is now.
async function bridgeBundle(): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, 'bridge/src/cli.ts')],
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    define: { __E2E__: 'false' },
    platform: 'node',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node' },
    outfile: BUILT,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

// Ends a bridge that a command of the test started after all: one whose record in the test's
// state folder names another process than this one.
function endStrayBridge(): void {
  const stray = readBridgeRecord();
  if (!stray || stray.pid === process.pid) return;
  try {
    process.kill(stray.pid, 'SIGKILL');
  } catch {
    // It has ended already.
  }
}

// The built file runs `register` and then `wait` as a process of its own, in a temporary state
// folder where a bridge runs in this process on a free port, with its record and its beacon. A
// command makes sure a bridge runs, and would start one on the user's port 47823 when none ran for
// its state folder; these find this one and start none. That holds only for a built file that
// reads the state folder as the source does, so nothing is started when the built file is not
// what the source builds. The wait gets the signal once its beacon is there. Afterwards the wait
// is ended when it still runs, a bridge that a command started after all is ended, and the folder
// removed, also when the test failed.
for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
  test(`the built file's wait, stopped by a signal, takes its agent off the list: ${signal}`, WITH_SIGNALS, async () => {
    const saved = process.env.CLICKNOTE_STATE_DIR;
    let dir: string | undefined;
    let bridge: RunningBridge | undefined;
    let beacon: { stop(): void } | undefined;
    let ended: Promise<number | null> = Promise.resolve(null);
    let end = (): void => {};
    let timer: NodeJS.Timeout | undefined;
    try {
      assert.ok(readFileSync(BUILT, 'utf8') === await bridgeBundle(),
        'dist/bridge/cli.mjs is not what the source builds: run npm run bundle. Nothing was started.');
      dir = mkdtempSync(join(tmpdir(), 'clicknote-'));
      process.env.CLICKNOTE_STATE_DIR = dir;
      const env = { ...process.env, CLICKNOTE_STATE_DIR: dir };
      bridge = await startBridge({ port: 0 });
      const record = { pid: process.pid, version: VERSION, format: STATE_FORMAT, port: bridge.port, auto: false };
      writeBridgeRecord(record);
      beacon = startBeacon('bridge', BRIDGE_KEY);
      const registered = spawnSync(process.execPath, [BUILT, 'register', '--harness', 'test', '--about', ''],
        { encoding: 'utf8', env, timeout: 10_000 });
      assert.equal(registered.status, 0, registered.stderr);
      const id = /^agent: ([0-9a-f]{12})$/m.exec(registered.stdout)?.[1] ?? '';
      assert.deepEqual(await listedBy(bridge), [id]);
      const wait = spawn(process.execPath, [BUILT, 'wait', id], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let exited = false;
      ended = new Promise(resolve => wait.on('close', code => {
        exited = true;
        resolve(code);
      }));
      end = () => {
        if (!exited) wait.kill('SIGKILL');
      };
      timer = setTimeout(end, 10_000);
      let out = '';
      let errors = '';
      wait.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
      wait.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
      while (!present('wait', id) && !exited) await sleep(20);
      assert.equal(exited, false, errors);
      wait.kill(signal);
      assert.equal(await ended, 1, errors);
      assert.deepEqual([out, errors], ['', 'Stopped waiting. You are off the list in the bar until you wait again.\n']);
      assert.deepEqual(await listedBy(bridge), []);
      // The commands found the bridge of the test, and started none of their own.
      assert.deepEqual(readBridgeRecord(), record);
    } finally {
      clearTimeout(timer);
      end();
      await ended;
      if (dir) endStrayBridge();
      beacon?.stop();
      await bridge?.close();
      if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
      else process.env.CLICKNOTE_STATE_DIR = saved;
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
}

// URL.parse came with Node 22.1, and the bridge runs on 22.0.
test('the committed bridge bundle does not call URL.parse', () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'dist/bridge/cli.mjs'), 'utf8'), /\bURL\.parse\b/);
});

// Chrome has URL.parse only from version 126 on.
test('the committed extension does not call URL.parse', () => {
  for (const script of ['background.js', 'content.js', 'opened.js']) {
    assert.doesNotMatch(readFileSync(join(ROOT, 'dist/extension', script), 'utf8'), /\bURL\.parse\b/, script);
  }
});

test('the committed extension is the built one', () => {
  const built = JSON.parse(readFileSync(join(ROOT, 'dist/extension/manifest.json'), 'utf8'));
  assert.equal(built.version, '0.4.0');
  assert.deepEqual(built.host_permissions, ['http://127.0.0.1/*']);
});

test('the committed extension carries the content script of the open page, for the bridge\'s port', () => {
  const built = JSON.parse(readFileSync(join(ROOT, 'dist/extension/manifest.json'), 'utf8'));
  assert.deepEqual(built.content_scripts,
    [{ matches: ['http://127.0.0.1:47823/open/*'], js: ['opened.js'], run_at: 'document_start' }]);
  assert.equal(existsSync(join(ROOT, 'dist/extension/opened.js')), true);
});

test('the committed extension carries the icons its manifest names', () => {
  const built = JSON.parse(readFileSync(join(ROOT, 'dist/extension/manifest.json'), 'utf8'));
  for (const path of new Set<string>([...Object.values(built.icons), ...Object.values(built.action.default_icon)] as string[])) {
    assert.deepEqual(readFileSync(join(ROOT, 'dist/extension', path)), readFileSync(join(ROOT, 'extension', path)), path);
  }
});
