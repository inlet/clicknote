import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOpen } from '../../bridge/src/commands.ts';
import type { CommandDeps } from '../../bridge/src/commands.ts';
import { writeLink } from '../../bridge/src/links.ts';
import { removeAgent } from '../../bridge/src/registry.ts';
import { startBridge } from '../../bridge/src/server.ts';
import type { RunningBridge } from '../../bridge/src/server.ts';
import { BRIDGE_PORT_E2E } from '../../shared/types.ts';
import {
  activate, annotate, commandDeps, INSECURE_HOST, launch, part, reactivate, register, stopWorker, stubBridge, tabAgent,
} from './helpers.ts';
import type { Session } from './helpers.ts';

// The open command with a running bridge: two agents register through the register command, and
// the open command, run for one of them, writes a link in the temporary state folder and prints
// the open address, and the page goes there as the agent's browser would. On the open address the
// test build of the extension tells its service worker the code, which asks the bridge whose link
// it is, so the tab remembers the agent that opened it, or the agent it last sent to. A tab
// without one gets the agent of the page's site: the bridge binds the site when an open address
// is first asked for, and with a send. With two agents, the bar chooses one only for a tab or a
// site that has one. One story, in order.
test.describe.configure({ mode: 'serial' });

const FILE = pathToFileURL(join(import.meta.dirname, '..', 'fixtures', 'page.html')).href;
const OPEN_ADDRESS = new RegExp(`^http://127\\.0\\.0\\.1:${BRIDGE_PORT_E2E}/open/[0-9a-f]{32}$`);
const EXPIRED = 'This link has expired. Ask your agent to open the page again.';
const FILE_HELP = 'This page cannot open a local file by itself. The Clicknote extension opens it '
  + 'when "Allow access to file URLs" is switched on for it at chrome://extensions. Switch it on, then ask your agent '
  + 'to open the page again.';
const NO_EXTENSION = 'This page cannot open a local file by itself. The Clicknote extension does that, '
  + 'and it is not in this browser. Install it, then ask your agent to open the page '
  + 'again. Or copy the address below into the address bar.';

let saved: string | undefined;   // CLICKNOTE_STATE_DIR before this file set it
let dir: string;
let deps: CommandDeps;
let one: string;                 // the id of the agent `claude-code`, that works on `one`
let two: string;                 // the id of the agent `codex`, that works on `two`
let bridge: RunningBridge | undefined;
const bridgeLog: string[] = [];  // the bridge's log, a line per request
let session: Session | undefined;
let context: BrowserContext;
let page: Page;
let sw: Worker;                  // the service worker as it runs now
let home: string;                // the fixture page, on 127.0.0.1
let away: string;                // the same page under another host, so on another site

test.beforeAll(async () => {
  saved = process.env.CLICKNOTE_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'clicknote-link-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
  deps = commandDeps([], []);
  one = await register(deps, 'claude-code', 'one');
  two = await register(deps, 'codex', 'two');
  bridge = await startBridge({ port: BRIDGE_PORT_E2E, log: line => { bridgeLog.push(line); } });
  session = await launch();
  ({ context, page, sw } = session);
  home = page.url();
  away = `http://${INSECURE_HOST}:${new URL(home).port}/page.html`;
});

// The bridge is closed even when closing the browser fails, so the next file finds the test
// port free. The state folder is set back only once it is closed, so a bridge left listening
// keeps the temporary one and never writes into the real one.
test.afterAll(async () => {
  try {
    await session?.close();
  } finally {
    await bridge?.close();
    if (saved === undefined) delete process.env.CLICKNOTE_STATE_DIR;
    else process.env.CLICKNOTE_STATE_DIR = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// How many `opened` requests the bridge has answered: one for each time the extension asked whose
// link an open page is.
function openedRequests(): number {
  return bridgeLog.filter(line => line.split(' ')[1] === 'opened').length;
}

// What the agent `agent` runs before it opens the page: the open command, which links the page to
// it and prints the open address, on the test port, instead of opening it. Gives what it printed
// and that address.
async function link(url: string, agent: string): Promise<{ out: string[]; address: string }> {
  const out: string[] = [];
  const notes: string[] = [];
  const code = await runOpen({ url, agent, addressOnly: true }, {
    ...deps, out: line => { out.push(line); }, note: line => { notes.push(line); },
  });
  expect(code).toBe(0);
  expect(notes).toEqual([]);
  const address = /^open this address: (.*)$/.exec(out.at(-1) ?? '')?.[1] ?? '';
  expect(address).toMatch(OPEN_ADDRESS);
  return { out, address };
}

// What the agent does to open the page in `page`: it links the page and opens the address the
// command printed, an open address of the test port. Gives what the command printed.
async function open(page: Page, url: string, agent: string): Promise<string[]> {
  const { out, address } = await link(url, agent);
  await page.goto(address);
  return out;
}

// From now on, each document `page` loads sets `clicknoteLinked` on its window when the
// extension's content script there has had the service worker's answer, which it tells with
// clicknote:linked.
async function noteLinked(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('clicknote:linked', () => {
      (window as unknown as { clicknoteLinked: boolean }).clicknoteLinked = true;
    });
  });
}

// Switches "Allow access to file URLs" for the extension at chrome://extensions, from the other
// state to `on`, with developer mode on first: without it, a change of the setting disables an
// extension loaded unpacked. The change reloads the extension, which empties its session storage
// and starts a new service worker; gives that worker.
async function switchFileAccess(on: boolean): Promise<Worker> {
  const settings = await context.newPage();
  try {
    await settings.goto(`chrome://extensions/?id=${new URL(sw.url()).host}`);
    const developerMode = settings.locator('#devMode');
    if (await developerMode.getAttribute('aria-checked') !== 'true') await developerMode.click();
    await expect(developerMode).toHaveAttribute('aria-checked', 'true');
    const fileAccess = settings.locator('#allow-on-file-urls');
    expect(await fileAccess.getAttribute('checked') === null).toBe(on);
    const started = context.waitForEvent('serviceworker');
    await fileAccess.click();
    const worker = await started;
    await expect.poll(() => worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess())).toBe(on);
    return worker;
  } finally {
    await settings.close();
  }
}

test('with two agents and no link, the bar asks to choose', async () => {
  await activate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue('');
  await expect(part(page, 'agent-select').locator('option').first()).toHaveText('Choose an agent…');
});

// The dropdown lists the agents in the order they registered, and two that registered within the
// same millisecond in the order of their ids, so the order of these two is not fixed.
test("a tab opened by an agent's link has that agent chosen among two", async () => {
  const tab = await context.newPage();
  try {
    await open(tab, home, two);
    await expect(tab).toHaveURL(home);
    await activate(sw, tab);
    const options = part(tab, 'agent-select').locator('option');
    await expect(options).toHaveCount(2);
    expect((await options.allTextContents()).sort()).toEqual(['○ site · one · claude-code', '○ site · two · codex']);
    await expect(part(tab, 'agent-select')).toHaveValue(two);
    await expect(part(tab, 'agent-select').locator('option:checked')).toHaveText('○ site · two · codex');
  } finally {
    await tab.close();
  }
});

test('after an agent links the page, the bar has that agent chosen', async () => {
  expect(await open(page, home, two)).toContain('listed as: site · two · codex');
  await expect(page).toHaveURL(home);
  await activate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue(two);
});

test('in a tab opened by hand, a page of another site is not linked', async () => {
  const byHand = await context.newPage();
  try {
    await byHand.goto(away);
    await activate(sw, byHand);
    await expect(part(byHand, 'agent-select')).toHaveValue('');
  } finally {
    await byHand.close();
  }
});

// The bridge binds the site at the first request for a code, so the other agent's link, opened
// in another tab, makes the site say that agent.
test('the tab an agent opened has that agent, on a site the other agent linked last', async () => {
  await open(page, home, two);
  await expect(page).toHaveURL(home);
  const other = await context.newPage();
  try {
    await open(other, home, one);
    await expect(other).toHaveURL(home);
  } finally {
    await other.close();
  }
  await activate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue(two);
});

test('the tab keeps its agent after a reload and on another site', async () => {
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue(two);
  await page.goto(away);
  await activate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue(two);
});

test('two tabs on one site have each their own agent', async () => {
  await page.goto(home);
  const second = await context.newPage();
  try {
    await open(second, home, one);
    await expect(second).toHaveURL(home);
    await activate(sw, page);
    await expect(part(page, 'agent-select')).toHaveValue(two);
    await activate(sw, second);
    await expect(part(second, 'agent-select')).toHaveValue(one);
  } finally {
    await second.close();
  }
});

// The agent `one` linked the site last, in the test before.
test("a tab opened by hand has the site's agent", async () => {
  const byHand = await context.newPage();
  try {
    await byHand.goto(home);
    await activate(sw, byHand);
    await expect(part(byHand, 'agent-select')).toHaveValue(one);
  } finally {
    await byHand.close();
  }
});

// A new page has an entry of its own, about:blank, so the page itself adds one: a tab that goes to
// the page through the open address has as many entries as a tab that goes to the page directly.
test("the open address stays out of the tab's history", async () => {
  const direct = await context.newPage();
  const opened = await context.newPage();
  try {
    await direct.goto(home);
    await open(opened, home, one);
    await expect(opened).toHaveURL(home);
    expect(await opened.evaluate(() => history.length)).toBe(await direct.evaluate(() => history.length));
  } finally {
    await direct.close();
    await opened.close();
  }
});

// Chrome stops the service worker after half a minute without events, so this is how a user who
// has not touched the extension for a while meets it. The worker that runs afterwards must have
// started after the page was opened: then none ran when the content script sent its message.
test('the tab gets its agent when the service worker was asleep', async () => {
  const fresh = await context.newPage();
  try {
    await stopWorker(context, fresh);
    const openedAt = Date.now();
    await open(fresh, home, two);
    await expect(fresh).toHaveURL(home);
    expect(await sw.evaluate(() => performance.timeOrigin)).toBeGreaterThanOrEqual(openedAt);
    expect(await tabAgent(sw, fresh)).toBe(two);
  } finally {
    await fresh.close();
  }
});

test("a queued send makes its agent the tab's agent", async () => {
  await reactivate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue(two);
  await annotate(page, '#cta', 'Make the button green.');
  await part(page, 'agent-select').selectOption(one);
  await part(page, 'send').click();
  await expect(part(page, 'status'))
    .toHaveText('Sent 1 annotation to site · one · claude-code. Queued: the agent gets it when it next waits.');
  expect(await tabAgent(sw, page)).toBe(one);
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue(one);
});

// Nothing has bound the other host yet; the send before bound this page's own site to `one`.
test('a tab opened by hand remembers the agent it sent to', async () => {
  const byHand = await context.newPage();
  try {
    await byHand.goto(away);
    await activate(sw, byHand);
    await expect(part(byHand, 'agent-select')).toHaveValue('');
    await annotate(byHand, '#cta', 'Make the button blue.');
    await part(byHand, 'agent-select').selectOption(two);
    await part(byHand, 'send').click();
    await expect(part(byHand, 'status'))
      .toHaveText('Sent 1 annotation to site · two · codex. Queued: the agent gets it when it next waits.');
    await byHand.goto(home);
    await activate(sw, byHand);
    await expect(part(byHand, 'agent-select')).toHaveValue(two);
  } finally {
    await byHand.close();
  }
});

// The agent `two` registers again afterwards, under a new id, for the tests that follow.
test('an agent that is gone is forgotten', async () => {
  const tab = await context.newPage();
  try {
    await open(tab, home, two);
    await expect(tab).toHaveURL(home);
    expect(await tabAgent(sw, tab)).toBe(two);
    removeAgent(two);
    await activate(sw, tab);
    await expect(part(tab, 'agent-select')).toHaveValue(one);          // the only agent
    await expect(part(tab, 'agent-select').locator(`option[value="${two}"]`)).toHaveCount(0);
    expect(await tabAgent(sw, tab)).toBeNull();
  } finally {
    two = await register(deps, 'codex', 'two');
    await tab.close();
  }
});

// The service worker has answered the open page when clicknote:linked comes, so by then it would
// have stored an agent.
test('an old or unknown code shows the expired page and gives the tab no agent', async () => {
  const old = writeLink({ url: home, agent: two, label: 'site · two · codex' }, Date.now() - 3_600_001);
  const tab = await context.newPage();
  try {
    await noteLinked(tab);
    for (const code of [old, '0123456789abcdef0123456789abcdef']) {
      await tab.goto(`http://127.0.0.1:${BRIDGE_PORT_E2E}/open/${code}`);
      await expect(tab.locator('body')).toHaveText(EXPIRED);
      await expect.poll(() => tab.evaluate(() => (window as unknown as { clicknoteLinked?: boolean }).clicknoteLinked)).toBe(true);
      expect(await tabAgent(sw, tab)).toBeNull();
    }
  } finally {
    await tab.close();
  }
});

// The content script runs at the start of the document, so by the time the page has loaded it
// would have marked it.
test('an open address on another port tells the extension nothing', async () => {
  const { address } = await link(home, two);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Another server</title><p>Not the bridge.</p>');
  });
  await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening));
  const tab = await context.newPage();
  try {
    const { port } = server.address() as AddressInfo;
    await tab.goto(`http://127.0.0.1:${port}${new URL(address).pathname}`);
    await expect(tab.locator('p')).toHaveText('Not the bridge.');
    expect(await tab.evaluate(() => document.documentElement.hasAttribute('data-clicknote'))).toBe(false);
    expect(await tabAgent(sw, tab)).toBeNull();
  } finally {
    await tab.close();
    await new Promise(done => { server.close(done); server.closeAllConnections(); });
  }
});

test('a local file opens in the tab the agent opened', async () => {
  const tab = await context.newPage();
  try {
    await open(tab, FILE, one);
    await expect(tab).toHaveURL(FILE);
    await activate(sw, tab);
    await expect(part(tab, 'agent-select')).toHaveValue(one);
  } finally {
    await tab.close();
  }
});

// Keyboard Back does nothing in a headless browser, and the browser's own Back skips the open page
// unless the user clicked on it, so the test goes back to the entry itself. The browser brings the
// open page back from its back/forward cache, where no script runs again and only pageshow tells.
// The bridge answers the extension before it sends the tab to the file, so the first `opened`
// request is in the log by the time the tab shows the file.
test('Back to the open page shows where the tab came from and passes nothing on', async () => {
  const { address } = await link(FILE, one);
  const tab = await context.newPage();
  try {
    await tab.goto(address);
    await expect(tab).toHaveURL(FILE);
    const asked = openedRequests();
    await tab.goBack({ waitUntil: 'commit' });
    await expect(tab.locator('#opened')).toBeVisible();
    await expect(tab.locator('#opened'))
      .toHaveText(`This tab was opened for site · one · claude-code. The page is ${FILE}.`);
    await expect(tab).toHaveURL(address);
    expect(openedRequests()).toBe(asked);
  } finally {
    await tab.close();
  }
});

// The open page is sent with no-store, and the browser keeps such a page in its back/forward cache
// only while the cookies of its site stay as they were. A cookie set while the tab shows the file
// makes Back load the open page again, as a load from Back: its script runs, and so does the
// extension's content script, and neither may pass the tab on.
test('Back to an open page that loads again passes nothing on', async () => {
  const { address } = await link(FILE, one);
  const tab = await context.newPage();
  try {
    await tab.goto(address);
    await expect(tab).toHaveURL(FILE);
    const asked = openedRequests();
    await context.addCookies([{ name: 'evict', value: '1', url: address }]);
    await tab.goBack({ waitUntil: 'commit' });
    await expect(tab.locator('#opened')).toBeVisible();
    expect(await tab.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type))
      .toBe('back_forward');
    await expect(tab).toHaveURL(address);
    expect(openedRequests()).toBe(asked);
  } finally {
    await tab.close();
    await context.clearCookies({ name: 'evict' });
  }
});

// A stand-in holds the bridge's answer back for a second, and meanwhile the tab moves on. It moves
// within the open page, so the page is still there to show what happened: its help, 2 seconds after
// it loaded, which a tab sent to the file at 1 second would never show.
test('a tab that has moved on before the answer comes is not sent to the file', async () => {
  const { address } = await link(FILE, one);
  const unused = { reply: { ok: false, kind: 'failed', message: 'Not asked in this test.' } };
  const tab = await context.newPage();
  try {
    await stubBridge(sw, {
      agents: unused, send: unused, copy: unused, state: unused,
      opened: { reply: { ok: true, url: FILE, agent: one }, delay: 1000 },
    });
    await noteLinked(tab);
    await tab.goto(address);
    await tab.evaluate(() => history.pushState(null, '', '/moved-on'));
    await expect.poll(() => tab.evaluate(() => (window as unknown as { clicknoteLinked?: boolean }).clicknoteLinked)).toBe(true);
    await expect(tab.locator('#file-help')).toBeVisible();
    await expect(tab).toHaveURL(`http://127.0.0.1:${BRIDGE_PORT_E2E}/moved-on`);
    expect(await tabAgent(sw, tab)).toBe(one);
  } finally {
    await sw.evaluate(() => { delete (self as unknown as { __clicknoteBridge?: unknown }).__clicknoteBridge; });
    await tab.close();
  }
});

// The open page shows its help 2 seconds after it loaded, unless the extension sent the tab on;
// by then the service worker has had the link, and has not sent the tab on.
test('without access to file URLs the open page says what to do', async () => {
  sw = await switchFileAccess(false);
  const tab = await context.newPage();
  try {
    await open(tab, FILE, one);
    await expect(tab.locator('#file-help')).toBeVisible();
    await expect(tab.locator('#file-help p').first()).toHaveText(FILE_HELP);
    await expect(tab).toHaveURL(OPEN_ADDRESS);
    expect(await tabAgent(sw, tab)).toBe(one);
  } finally {
    await tab.close();
    sw = await switchFileAccess(true);
  }
});

// A browser without the extension: a plain Chromium of its own, on the same bridge. No content
// script marks the open page, so the page's own script does not wait. The time the tab spends on
// the open page is taken with the browser's own clock, over the DevTools protocol: from the
// response that brings the open page to the request for the page it passes the tab on to. This
// process serves both pages, and neither serving falls inside that time. A page that waited would
// take 2 seconds at the least; one that does not, a few milliseconds.
test('without the extension a web page is passed on at once', async () => {
  const { address } = await link(home, two);
  const browser = await chromium.launch();
  try {
    const plain = await browser.newPage();
    const cdp = await plain.context().newCDPSession(plain);
    let arrived: number | undefined;         // in seconds of the browser's clock
    let passedOn: number | undefined;
    cdp.on('Network.responseReceived', ({ type, response, timestamp }) => {
      if (type === 'Document' && response.url === address) arrived = timestamp;
    });
    cdp.on('Network.requestWillBeSent', ({ type, request, timestamp }) => {
      if (type === 'Document' && request.url === home) passedOn = timestamp;
    });
    await cdp.send('Network.enable');
    await plain.goto(address, { waitUntil: 'commit' });
    await expect(plain).toHaveURL(home);
    await expect.poll(() => arrived !== undefined && passedOn !== undefined).toBe(true);
    expect((passedOn! - arrived!) * 1000).toBeLessThan(1000);
  } finally {
    await browser.close();
  }
});

// The page's script runs before the page has loaded, so by then it has shown the text.
test('without the extension a local file shows what is missing', async () => {
  const { address } = await link(FILE, one);
  const browser = await chromium.launch();
  try {
    const plain = await browser.newPage();
    await plain.goto(address);
    expect(await plain.locator('#no-extension').isVisible()).toBe(true);
    await expect(plain.locator('#no-extension p')).toHaveText([NO_EXTENSION, FILE]);
    await expect(plain.locator('#file-help')).toBeHidden();
    await expect(plain).toHaveURL(address);
  } finally {
    await browser.close();
  }
});
