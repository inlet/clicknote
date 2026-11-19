import { chromium, expect } from '@playwright/test';
import type { BrowserContext, Locator, Page, Worker } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runRegister } from '../../bridge/src/commands.ts';
import type { CommandDeps } from '../../bridge/src/commands.ts';
import { STATE_FORMAT } from '../../bridge/src/record.ts';
import { BRIDGE_PORT_E2E } from '../../shared/types.ts';
import type { ToBackground } from '../../extension/src/messages.ts';
import type { AgentInfo, BridgeRequest, Intent } from '../../shared/types.ts';
import { VERSION } from '../../shared/version.ts';

// Helpers for the browser tests: a Chromium with the e2e build of the extension, the fixture
// pages on a local port, actions on the extension's UI, and the commands an agent runs.

const ROOT = join(import.meta.dirname, '../..');
const EXTENSION = join(ROOT, 'dist', 'extension-e2e');
const FIXTURES = join(ROOT, 'test', 'fixtures');

export interface Session {
  context: BrowserContext;
  page: Page;                 // showing the fixture page.html, or the page asked for
  sw: Worker;                 // the extension's service worker
  close(): Promise<void>;     // closes the browser and the server, removes the profile
}

// Another name for the fixture server. A page on 127.0.0.1 is a secure context; a page on
// plain http under this name is not, like a dev server on a LAN address.
export const INSECURE_HOST = 'fixtures.test';

// A part of the extension's UI by its `data-clicknote` name. Playwright pierces open shadow
// roots.
export const part = (page: Page, name: string): Locator => page.locator(`[data-clicknote="${name}"]`);

// What a script other than the tests can change, such as docs/readme/screenshot.mjs: the
// folder to serve and the page to open in it, and the browser's viewport, scale and colour
// scheme. The tests use the defaults: test/fixtures, page.html and Playwright's own.
export interface LaunchOptions {
  folder?: string;
  page?: string;
  browser?: {
    viewport?: { width: number; height: number };
    deviceScaleFactor?: number;
    colorScheme?: 'light' | 'dark';
  };
}

// Chromium with the extension loaded, in a new profile, and one page on the fixture page.html
// (or the page asked for). The served pages may use the clipboard, so a test can read what
// Copy put there. The back/forward cache stays on, as in Chrome; Playwright turns it off by
// default.
export async function launch(
  { folder = FIXTURES, page: path = 'page.html', browser = {} }: LaunchOptions = {},
): Promise<Session> {
  const server = await serveFolder(folder);
  const profile = await mkdtemp(join(tmpdir(), 'clicknote-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`,
      `--host-resolver-rules=MAP ${INSECURE_HOST} 127.0.0.1`],
    ...browser,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: originOf(server) });
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${originOf(server)}/${path}`);
  return {
    context,
    page,
    sw,
    async close() {
      await context.close();
      await new Promise(done => server.close(done));
      await rm(profile, { recursive: true, force: true });
    },
  };
}

// What a click on the toolbar button does, for the tab that shows `page`.
export async function activate(sw: Worker, page: Page): Promise<void> {
  await page.bringToFront();
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error('No active tab to activate.');
    const hooks = self as unknown as { __clicknoteActivate(tabId: number): Promise<void> };
    await hooks.__clicknoteActivate(tab.id);
  });
}

// Turns the UI off and on again, which lists the agents anew.
export async function reactivate(sw: Worker, page: Page): Promise<void> {
  if (await part(page, 'bar').isVisible()) {
    await activate(sw, page);
    await expect(part(page, 'bar')).toBeHidden();
  }
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeVisible();
}

// What a user does who goes to another window and comes back: the page's window
// loses the focus and gets it back, with the events the browser makes for that. Playwright makes
// every page act as focused, which leaves those events out, so that is off meanwhile. A page
// here stays visible whichever page is in front, so no visibilitychange comes.
export async function comeBack(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const elsewhere = await context.newPage();
  await elsewhere.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  await elsewhere.close();
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.detach();
}

// The stand-in bridge's answer to each type of request: the reply, given after `delay`
// milliseconds. With `replies`, each call takes the next one, and the last one repeats. With
// `timeout`, no reply comes: after its delay the stand-in throws the TimeoutError that `fetch`
// throws for a bridge that does not answer in time. With `hold`, the answer of every call from
// the one with that number on, counted from 0, is held back until the test lets the answers of
// that type go (letGo); from then on they come at once. A call is in the record of the requests
// (requests) as soon as it reaches the stand-in, also while its answer is held.
// Plain data, because a function cannot be passed into the service worker; the function is
// built there. The service worker checks each reply as a real one.
export interface StubReply { reply?: unknown; replies?: unknown[]; delay?: number; timeout?: boolean; hold?: number }

// The stand-in answers `agents`, `send`, `copy` and `state`. A stub may leave out `opened`, which
// the extension asks only for a tab on an open address.
export type BridgeStub = Record<Exclude<BridgeRequest['type'], 'opened'>, StubReply> & { opened?: StubReply };

// A gate that holds back the stand-in's answers of one type of request. One that is closed stays
// in place when another stub is put in place, so letGo also lets go the answers that an earlier
// stub holds; a stub that holds answers puts a new one in place of one that is open.
interface Gate { open: boolean; opened: Promise<void>; letGo(): void }
type Gates = Partial<Record<BridgeRequest['type'], Gate>>;

// An agent as a stand-in bridge lists it: of the folder `site`, without a number and not waiting,
// unless `fields` says otherwise.
export function standIn(fields: Pick<AgentInfo, 'id' | 'about' | 'harness'> & Partial<AgentInfo>): AgentInfo {
  return { folder: 'site', number: null, waiting: false, ...fields };
}

// Puts the stand-in bridge in place and empties the record of the requests it received.
export async function stubBridge(sw: Worker, stub: BridgeStub): Promise<void> {
  await sw.evaluate(stub => {
    type Type = keyof typeof stub;
    const hooks = self as unknown as {
      __clicknoteBridge?: (request: { type: Type }) => Promise<unknown>;
      __clicknoteRequests?: unknown[];
      __clicknoteAnswered?: unknown[];
      __clicknoteGates?: Gates;
    };
    const gates = hooks.__clicknoteGates ??= {};
    for (const type of Object.keys(stub) as Type[]) {
      if (stub[type]?.hold === undefined || (gates[type] && !gates[type].open)) continue;
      let letGo = () => {};
      const opened = new Promise<void>(done => { letGo = done; });
      const gate: Gate = { open: false, opened, letGo: () => { gate.open = true; letGo(); } };
      gates[type] = gate;
    }
    const calls = new Map<Type, number>();       // how many replies each type has given
    hooks.__clicknoteRequests = [];
    hooks.__clicknoteAnswered = [];
    hooks.__clicknoteBridge = async request => {
      const { type } = request;
      const { reply, replies, delay = 0, timeout = false, hold } = stub[type]!;
      const call = calls.get(type) ?? 0;
      calls.set(type, call + 1);
      const gate = gates[type];
      if (hold !== undefined && call >= hold && gate) await gate.opened;
      if (delay > 0) await new Promise(done => setTimeout(done, delay));
      if (timeout) throw new DOMException('The operation timed out.', 'TimeoutError');
      return replies ? replies[Math.min(call, replies.length - 1)] : reply;
    };
  }, stub);
}

// Lets go the answers of this type of request that the stand-in holds back, and those it would
// hold from now on, until a stub that holds them is put in place.
export async function letGo(sw: Worker, type: BridgeRequest['type']): Promise<void> {
  await sw.evaluate(type => {
    const gate = (self as unknown as { __clicknoteGates?: Gates }).__clicknoteGates?.[type];
    if (!gate) throw new Error(`No stub holds the answers to ${type}.`);
    gate.letGo();
  }, type);
}

// The requests the stand-in bridge received since it was put in place.
export async function requests(sw: Worker): Promise<BridgeRequest[]> {
  return sw.evaluate(() => (self as unknown as { __clicknoteRequests?: BridgeRequest[] }).__clicknoteRequests ?? []);
}

// How many messages of this type from a page the service worker has answered since the stand-in
// bridge was put in place. Once a message is answered, the service worker has done all it does
// for it.
export async function answered(sw: Worker, type: ToBackground['type']): Promise<number> {
  return sw.evaluate(type => ((self as unknown as { __clicknoteAnswered?: string[] }).__clicknoteAnswered ?? [])
    .filter(answered => answered === type).length, type);
}

// What the service worker has stored for the active tab: its draft, or the record of its send.
export async function stored<T>(sw: Worker, what: 'draft' | 'send'): Promise<T | null> {
  return sw.evaluate(async what => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const key = `${what}:${tab.id}`;
    return (await chrome.storage.session.get(key))[key] ?? null;
  }, what) as Promise<T | null>;
}

// The agent the service worker has stored for the tab that shows `page`, or null.
export async function tabAgent(sw: Worker, page: Page): Promise<string | null> {
  await page.bringToFront();
  return sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const key = `agent:${tab.id}`;
    return (await chrome.storage.session.get(key))[key] ?? null;
  }) as Promise<string | null>;
}

// Stops the extension's service worker, as Chrome does after a while without events, over the
// DevTools protocol on a session of `page`. Returns once the browser reports it stopped. The next
// event starts it again. Playwright keeps the same Worker for it meanwhile, which gets no answer
// to an evaluate while it is stopped; its `performance.timeOrigin` tells when it last started.
export async function stopWorker(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const statuses = new Map<string, string>();    // the running status of each version of the worker
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      for (const { versionId, scriptURL, runningStatus } of versions) {
        if (scriptURL.startsWith('chrome-extension://')) statuses.set(versionId, runningStatus);
      }
    });
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await expect.poll(() => statuses.size > 0 && [...statuses.values()].every(status => status === 'stopped')).toBe(true);
  } finally {
    await cdp.detach();
  }
}

// Changes the comment of the first annotation in the stored draft of the active tab, which
// nothing a user does can while a send of that draft is under way.
export async function changeStoredComment(sw: Worker, comment: string): Promise<void> {
  await sw.evaluate(async comment => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const key = `draft:${tab.id}`;
    const draft = (await chrome.storage.session.get<Record<string, { annotations: { comment: string }[] }>>(key))[key];
    draft.annotations[0].comment = comment;
    await chrome.storage.session.set({ [key]: draft });
  }, comment);
}

// The ids of the crops the service worker holds, sorted.
export function cropIds(sw: Worker): Promise<string[]> {
  return sw.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('clicknote', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('crops');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const keys = database.transaction('crops').objectStore('crops').getAllKeys();
      keys.onerror = () => reject(keys.error);
      keys.onsuccess = () => {
        database.close();
        resolve((keys.result as string[]).sort());
      };
    };
  }));
}

// In pick mode a shield covers the page, so Playwright's own click and hover on a page
// element would wait for that element to receive the event. These act at the centre of the
// element instead, where the shield passes the element to the picker.
export async function hoverAt(page: Page, selector: string): Promise<void> {
  const { x, y } = await centreOf(page, selector);
  await page.mouse.move(x, y);
}

export async function pickAt(page: Page, selector: string): Promise<void> {
  const { x, y } = await centreOf(page, selector);
  await page.mouse.click(x, y);
}

// Picks the element, sets the intent, writes the comment and adds it with ⌘↵ (Ctrl+↵ off
// macOS). Turns pick mode on first when it is off, and returns once the annotation is in the
// list.
export async function annotate(page: Page, selector: string, comment: string, intent: Intent = 'change'): Promise<void> {
  const toggle = part(page, 'pick-toggle');
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  const count = Number(await part(page, 'count').textContent());
  await pickAt(page, selector);
  await part(page, `intent-${intent}`).click();
  await part(page, 'comment').fill(comment);
  await part(page, 'comment').press('ControlOrMeta+Enter');
  await expect(part(page, 'count')).toHaveText(String(count + 1));
  await expect(part(page, 'popup')).toBeHidden();
}

// Of the first match, as `page.click(selector)` takes it.
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`${selector} is not visible.`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// What the commands an agent runs use in the tests that start a real bridge: the project folder
// /x/site, so the bar lists each agent as one of `site`; a bridge of this version on the test
// port, which the test starts itself; no browser to open an address in; and `out` and `notes`
// for the lines they write on standard output and on the error stream.
export function commandDeps(out: string[], notes: string[]): CommandDeps {
  const record = { pid: process.pid, version: VERSION, format: STATE_FORMAT, port: BRIDGE_PORT_E2E, auto: false };
  return {
    cwd: '/x/site',
    port: BRIDGE_PORT_E2E,
    ensure: async () => ({ state: 'running', record }),
    open: () => false,
    out: line => { out.push(line); },
    note: line => { notes.push(line); },
  };
}

// Registers an agent through the register command, with `deps`, and gives its id.
export async function register(deps: CommandDeps, harness: string, about: string): Promise<string> {
  const printed: string[] = [];
  expect(await runRegister({ harness, about }, { ...deps, out: line => { printed.push(line); } })).toBe(0);
  const id = /^agent: ([0-9a-f]{12})$/.exec(printed[0] ?? '')?.[1];
  if (id === undefined) throw new Error(`The register command printed no agent: ${JSON.stringify(printed)}`);
  return id;
}

// Serves a folder, test/fixtures for the tests, on a free port of 127.0.0.1.
async function serveFolder(folder: string): Promise<Server> {
  const root = resolve(folder);
  const server = createServer(async (request, response) => {
    const path = resolve(root, `.${new URL(request.url ?? '/', 'http://localhost').pathname}`);
    try {
      if (!path.startsWith(root + sep)) throw new Error('outside the folder');
      const body = await readFile(path);
      response.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening));
  return server;
}

function originOf(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
