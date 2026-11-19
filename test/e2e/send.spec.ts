import { expect, test } from '@playwright/test';
import type { Page, Worker } from '@playwright/test';
import { OLD_BRIDGE } from '../../extension/src/bridge-client.ts';
import { agentLabel, listedAs } from '../../shared/label.ts';
import { WAIT_SENTENCE } from '../../shared/types.ts';
import type { AgentInfo, ErrorKind, PageInfo, SendStatus } from '../../shared/types.ts';
import {
  activate, annotate, answered, cropIds, INSECURE_HOST, launch, letGo, part, pickAt, reactivate, requests,
  standIn, stored, stubBridge,
} from './helpers.ts';
import type { BridgeStub, Session } from './helpers.ts';

// One page for the whole file; each test builds on the state the previous one left.
test.describe.configure({ mode: 'serial' });

let session: Session;
let page: Page;
let sw: Worker;

test.beforeAll(async () => {
  session = await launch();
  ({ page, sw } = session);
});

test.afterAll(async () => {
  await session?.close();
});

const AGENTS: AgentInfo[] = [
  standIn({ id: 't6m', about: 'landing page copy', harness: 'claude-code', waiting: true }),
  standIn({ id: 't7', about: 'checkout form', harness: 'codex' })];

// How the bar names t7 after a send to it, and what it says once t7 has picked a send up.
const T7 = agentLabel(AGENTS[1]);
const PICKED_UP_ONE = `Sent 1 annotation to ${T7}. The agent picked it up.`;

// The status lines that tell the user to say the sentence to an agent.
const NO_AGENT_LISTENING = 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works.';
const BRIDGE_NOT_RUNNING = 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works, without screenshots.';

const FOLDER = '/tmp/clicknote-e2e/sends/2026-11-12T10-00-00';
const LINE = `Browser annotations on the fixture: read ${FOLDER}/annotations.md`;

// The stand-in bridges. Each answers every type of request, as the real bridge does.

// Lists the agents, with `preselect` as the agent bound to the site, queues every send, writes
// every copy, and says that a send was picked up.
function AGENTS_OK({ agents = AGENTS, preselect = null }: { agents?: AgentInfo[]; preselect?: string | null } = {}): BridgeStub {
  return {
    agents: { reply: { ok: true, agents, preselect } },
    send: { reply: { ok: true, folder: FOLDER, line: LINE, agent: 't7' } },
    copy: { reply: { ok: true, folder: FOLDER, line: LINE } },
    state: { reply: stateOf('picked_up') },
  };
}

function stateOf(state: SendStatus): { ok: true; state: SendStatus; line: string } {
  return { ok: true, state, line: LINE };
}

// The site is bound to t7 from here on, as after an earlier send to it.
const BOUND = () => AGENTS_OK({ preselect: 't7' });

function SLOW_OK(delay: number): BridgeStub {
  const stub = BOUND();
  return { ...stub, send: { ...stub.send, delay } };
}

function SEND_FAILS(kind: ErrorKind, message = ''): BridgeStub {
  return { ...BOUND(), send: { reply: { ok: false, kind, message } } };
}

function COPY_OK(line: string): BridgeStub {
  return { ...BOUND(), copy: { reply: { ok: true, folder: FOLDER, line } } };
}

function ALWAYS(reply: unknown): BridgeStub {
  return { agents: { reply }, send: { reply }, copy: { reply }, state: { reply } };
}

// What the page has on the clipboard. Copy writes it after a round trip to the service
// worker, so the tests poll for it.
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

// Holds the service worker's screenshots until the returned function is called, so a test
// can act while the crop of a pick is taken.
async function holdCaptures(): Promise<() => Promise<void>> {
  type Capture = (...args: unknown[]) => Promise<string>;
  interface Hooks { __capture?: Capture; __release?: () => void }
  await sw.evaluate(() => {
    const tabs = chrome.tabs as unknown as { captureVisibleTab: Capture };
    const hooks = self as unknown as Hooks;
    const capture = hooks.__capture ??= tabs.captureVisibleTab;
    const held = new Promise<void>(release => { hooks.__release = release; });
    tabs.captureVisibleTab = async (...args) => {
      await held;
      return capture.apply(chrome.tabs, args);
    };
  });
  return () => sw.evaluate(() => {
    const hooks = self as unknown as Hooks;
    (chrome.tabs as unknown as { captureVisibleTab: Capture }).captureVisibleTab = hooks.__capture!;
    hooks.__release!();
  });
}

test('the dropdown lists the agents and preselects the bound one', async () => {
  await stubBridge(sw, AGENTS_OK({ preselect: 't7' }));
  await activate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue('t7');
  await expect(part(page, 'agent-select').locator('option')).toHaveText(AGENTS.map(listedAs));
  expect(AGENTS.map(listedAs)).toEqual(['● site · landing page copy · claude-code · waiting', '○ site · checkout form · codex']);
  for (const [index, agent] of AGENTS.entries()) {
    await expect(part(page, 'agent-select').locator('option').nth(index)).toHaveAttribute('title', listedAs(agent));
  }
  await expect(part(page, 'agent-select')).toHaveAttribute('title', listedAs(AGENTS[1]));
});

// The selected agent is read at a glance, so the dropdown gets the full width of the bar.
test('the dropdown has a row of its own above Copy and Send, as wide as their row', async () => {
  const select = (await part(page, 'agent-select').boundingBox())!;
  const actions = (await part(page, 'actions').boundingBox())!;
  const send = (await part(page, 'send').boundingBox())!;
  expect(select.y + select.height).toBeLessThanOrEqual(actions.y);
  expect(select.width).toBeGreaterThanOrEqual(actions.width);
  // Copy and Send stay at the right end of their row, under the right end of the dropdown.
  expect(send.x + send.width).toBeCloseTo(select.x + select.width, 0);
});

// Each part of a label can have 60 characters. The dropdown cuts the end of a label that long,
// and its title has all of it.
test('an agent with three long parts keeps its dot and its start readable', async () => {
  const width = (await part(page, 'bar').boundingBox())!.width;
  const long = standIn({ id: 't8', folder: 'f'.repeat(60), about: 'a'.repeat(60), harness: 'h'.repeat(60) });
  await stubBridge(sw, AGENTS_OK({ agents: [long] }));
  await reactivate(sw, page);
  await expect(part(page, 'agent-select')).toHaveValue('t8');
  const selected = part(page, 'agent-select').locator('option:checked');
  await expect(selected).toHaveText(listedAs(long));
  expect(await selected.textContent()).toMatch(/^○ f{60} · /);
  await expect(part(page, 'agent-select')).toHaveAttribute('title', listedAs(long));
  const bar = (await part(page, 'bar').boundingBox())!;
  const select = (await part(page, 'agent-select').boundingBox())!;
  expect(bar.width).toBe(width);
  expect(select.x).toBeGreaterThanOrEqual(bar.x);
  expect(select.x + select.width).toBeLessThanOrEqual(bar.x + bar.width);
});

test('Send and Copy are off while there is nothing to send', async () => {
  await expect(part(page, 'send')).toBeDisabled();
  await expect(part(page, 'copy')).toBeDisabled();
});

test('the dropdown lists the agents again when it gets focus, and keeps the one the user chose', async () => {
  await stubBridge(sw, AGENTS_OK({ preselect: 't7' }));
  await part(page, 'agent-select').focus();
  await expect.poll(async () => (await requests(sw)).filter(r => r.type === 'agents')).toHaveLength(1);
  await part(page, 'agent-select').selectOption('t6m');
  // The next listing differs, so the dropdown is filled anew and the selection chosen again.
  const t7Waiting = { ...AGENTS[1], waiting: true };
  await stubBridge(sw, AGENTS_OK({ agents: [AGENTS[0], t7Waiting], preselect: 't7' }));
  await reactivate(sw, page);
  await expect(part(page, 'agent-select').locator('option').nth(1)).toHaveText(listedAs(t7Waiting));
  await expect(part(page, 'agent-select')).toHaveValue('t6m');
  await part(page, 'agent-select').selectOption('t7');
});

test('Send delivers every annotation with its crop, then clears', async () => {
  await annotate(page, '#cta', 'Bigger', 'change');
  await annotate(page, '#features h3', 'Why three?', 'question');
  await part(page, 'note').fill('Keep it calm.');
  await page.evaluate(() => document.querySelector('#cta')!.remove());      // gone before Send
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText('Sent 2 annotations to site · checkout form · codex. The agent picked them up.');
  await expect(part(page, 'list-item')).toHaveCount(0);
  await expect(part(page, 'marker')).toHaveCount(0);
  await expect(part(page, 'note')).toHaveValue('');
  const req = (await requests(sw)).find(r => r.type === 'send')!;
  expect(req.agent).toBe('t7');
  expect(req.send.note).toBe('Keep it calm.');
  expect(req.send.annotations.map(a => [a.number, a.intent, a.comment, a.selector]))
    .toEqual([[1, 'change', 'Bigger', '#cta'], [2, 'question', 'Why three?', expect.any(String)]]);
  expect(req.send.page).toMatchObject({ url: page.url(), title: 'Fixture', sourceFile: null });
  expect(req.send.page.viewport.width).toBeGreaterThan(0);
  for (const a of req.send.annotations) expect(req.send.images[a.id]).toMatch(/^iVBOR/);
  // Brings #cta back for the tests below.
  await page.reload();
  await activate(sw, page);
});

// The button says Copied until the status line changes; the next offer has its own label again.
test('the button of an offer reads its own label again when the status changes', async () => {
  await stubBridge(sw, { ...BOUND(), state: { reply: stateOf('queued') } });
  await annotate(page, '#cta', 'Queued');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(`Sent 1 annotation to ${T7}. Queued: the agent gets it when it next waits.`);
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
  await part(page, 'copy-offer').click();
  await expect.poll(clipboard).toBe(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copied');
  await stubBridge(sw, { ...BOUND(), state: { reply: stateOf('agent_gone') } });
  await expect(part(page, 'status')).toHaveText(/^Sent 1 annotation to .*, but that agent is no longer listed /);
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
});

test('Send is disabled while it runs, so a double click sends once', async () => {
  await stubBridge(sw, SLOW_OK(500));
  await annotate(page, '#cta', 'x');
  await part(page, 'send').dblclick();
  await expect(part(page, 'status')).toHaveText('Sending…');
  // Checked at once, not waited for: once the send is over, both are off anyway, as the list is empty.
  expect(await part(page, 'send').isDisabled()).toBe(true);
  expect(await part(page, 'copy').isDisabled()).toBe(true);
  await expect(part(page, 'status')).toHaveText(/^Sent 1 annotation to /);
  expect((await requests(sw)).filter(r => r.type === 'send')).toHaveLength(1);
});

// Whatever changed while the request of a send runs would be cleared unsent.
test('the list cannot change while a send runs', async () => {
  await stubBridge(sw, SLOW_OK(1500));
  await annotate(page, '#cta', 'Sent as it was');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText('Sending…');
  await expect(part(page, 'pick-toggle')).toBeDisabled();
  await expect(part(page, 'note')).not.toBeEditable();
  await pickAt(page, '#features h3');
  await part(page, 'marker').first().click();
  await part(page, 'list-item').first().locator('button').click();
  // Checked at once, not waited for: once the send is over, a popup about the sent
  // annotation would close by itself.
  expect(await part(page, 'popup').isVisible()).toBe(false);
  expect(await part(page, 'status').textContent()).toBe('Sending…');
  await expect(part(page, 'status')).toHaveText(/^Sent 1 annotation to /);
  await expect(part(page, 'list-item')).toHaveCount(0);
  await expect(part(page, 'note')).toBeEditable();
  await expect(part(page, 'pick-toggle')).toBeEnabled();
  await expect(part(page, 'pick-toggle')).toHaveAttribute('aria-pressed', 'true');
  await pickAt(page, '#features h3');
  await expect(part(page, 'popup')).toBeVisible();
  await part(page, 'cancel').click();
});

test('a popup that is open when Send is clicked cannot add until the send is over', async () => {
  await stubBridge(sw, SLOW_OK(1500));
  await annotate(page, '#cta', 'Sent as it was');
  await pickAt(page, '#features h3');
  await part(page, 'comment').fill('Typed before Send');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText('Sending…');
  await expect(part(page, 'add')).toBeDisabled();
  await part(page, 'comment').press('Meta+Enter');
  await expect(part(page, 'status')).toHaveText(/^Sent 1 annotation to /);
  await expect(part(page, 'list-item')).toHaveCount(0);
  // Nothing typed is lost: the popup is still open and can add now. A ⌘↵ that had added
  // the annotation would have closed it.
  await expect(part(page, 'popup')).toBeVisible();
  await expect(part(page, 'comment')).toHaveValue('Typed before Send');
  await expect(part(page, 'add')).toBeEnabled();
  await part(page, 'cancel').click();
});

// After an agent that is gone the agents are listed again; a send that failed keeps no record.
// The dropdown lists the agents just before each Send, so the click on Send, a use of the bar
// within two seconds of that listing, makes no listing of its own.
test('a gone agent and a failed send each say so and keep everything', async () => {
  await stubBridge(sw, BOUND());
  await annotate(page, '#cta', 'x');
  for (const [stub, text, listed] of [
    [SEND_FAILS('agent_gone'), 'That agent is no longer listed. Choose another.', 1],
    [SEND_FAILS('failed', 'The state folder cannot be written.'), 'Sending failed: The state folder cannot be written.', 0],
  ] as [BridgeStub, string, number][]) {
    await stubBridge(sw, stub);
    await part(page, 'agent-select').blur();
    await part(page, 'agent-select').focus();
    await expect.poll(() => answered(sw, 'agents')).toBe(1);
    await part(page, 'agent-select').blur();
    await part(page, 'send').click();
    await expect(part(page, 'status')).toHaveText(text);
    await expect(part(page, 'list-item')).toHaveCount(1);
    await expect.poll(agentsAsked).toBe(1 + listed);
    expect(await stored(sw, 'send')).toBeNull();
  }
});

test('the general comment is kept with the annotations and comes back after a reload', async () => {
  await part(page, 'note').fill('Keep it calm.');
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'note')).toHaveValue('Keep it calm.');
  await expect(part(page, 'list-item')).toHaveCount(1);
});

test('Copy puts the line on the clipboard and clears', async () => {
  await stubBridge(sw, COPY_OK('LINE FROM BRIDGE'));
  await part(page, 'copy').click();
  await expect.poll(clipboard).toBe('LINE FROM BRIDGE');
  await expect(part(page, 'status')).toHaveText('Copied. Paste the line into your agent.');
  await expect(part(page, 'list-item')).toHaveCount(0);
  await expect(part(page, 'note')).toHaveValue('');
  const req = (await requests(sw)).find(r => r.type === 'copy')!;
  expect(req.send.note).toBe('Keep it calm.');
  expect(req.send.annotations).toHaveLength(1);
});

test('with no agent listed the bar shows the sentence to say, and its button copies it', async () => {
  await stubBridge(sw, AGENTS_OK({ agents: [] }));
  await reactivate(sw, page);
  await annotate(page, '#cta', 'x');
  await expect(part(page, 'agent-select').locator('option')).toHaveText(['No agent listening']);
  await expect(part(page, 'send')).toBeDisabled();
  await expect(part(page, 'copy')).toBeEnabled();
  await expect(part(page, 'status')).toHaveText(NO_AGENT_LISTENING);
  await expect(part(page, 'offer')).toHaveText('Wait for my annotations with the clicknote skill.');
  await expect(part(page, 'copy-offer')).toHaveText('Copy sentence');
  await part(page, 'copy-offer').click();
  await expect.poll(clipboard).toBe('Wait for my annotations with the clicknote skill.');
  await expect(part(page, 'copy-offer')).toHaveText('Copied');
});

test('with the bridge down the bar shows the same sentence, and Copy gives the Markdown', async () => {
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));
  await reactivate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect(part(page, 'agent-select').locator('option')).toHaveText(['No agent listening']);
  await expect(part(page, 'send')).toBeDisabled();
  await expect(part(page, 'status')).toHaveText(BRIDGE_NOT_RUNNING);
  await expect(part(page, 'offer')).toHaveText(WAIT_SENTENCE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy sentence');
  await part(page, 'copy').click();
  await expect.poll(clipboard).toMatch(/^# Browser annotations\n/);
  await expect(part(page, 'status')).toHaveText('Copied as Markdown, without screenshots.');
  await expect(part(page, 'status-offer')).toBeHidden();
  await expect(part(page, 'list-item')).toHaveCount(1);
  const markdown = await clipboard();
  expect(markdown).toContain(`- Page: \`Fixture\` (${page.url()})`);
  expect(markdown).toContain('## 1. Change: `button "Get started"');
  expect(markdown).not.toContain('Screenshot:');
});

test('once the bridge runs, the bar finds it when the dropdown gets focus', async () => {
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));
  await reactivate(sw, page);
  await expect(part(page, 'status-offer')).toBeVisible();
  await stubBridge(sw, BOUND());                                 // the bridge has been started
  await part(page, 'agent-select').focus();
  await expect(part(page, 'send')).toBeEnabled();
  await expect(part(page, 'status')).toBeHidden();
  await expect(part(page, 'status-offer')).toBeHidden();
});

// Coming back to the page lists the agents again while Send is off, but only on the events the
// browser makes; page script cannot make the bar call the bridge.
test('focus and visibility events made by page script do not list the agents', async () => {
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));
  await reactivate(sw, page);
  await expect(part(page, 'status-offer')).toBeVisible();
  await stubBridge(sw, BOUND());
  await page.evaluate(() => {
    window.dispatchEvent(new FocusEvent('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // A listing the user causes comes after any the events above would have caused.
  await listAgain();
  await expect(part(page, 'send')).toBeEnabled();
  expect((await requests(sw)).filter(r => r.type === 'agents')).toHaveLength(1);
});

test('when the versions do not fit, the bar says which side to update, and Copy gives Markdown', async () => {
  const message = OLD_BRIDGE;
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'version_mismatch', message }));
  await reactivate(sw, page);
  await expect(part(page, 'send')).toBeDisabled();
  await expect(part(page, 'status')).toHaveText(message);
  await expect(part(page, 'status-offer')).toBeHidden();
  await part(page, 'copy').click();
  await expect(part(page, 'status')).toHaveText('Copied as Markdown, without screenshots.');
  await expect(part(page, 'list-item')).toHaveCount(1);
});

// A bridge of another protocol can take the place of the one that listed the agents. The Send
// then gets the mismatch, and nothing was sent.
test('a send that is answered with a version mismatch says which side to update and keeps the list', async () => {
  const message = OLD_BRIDGE;
  await stubBridge(sw, BOUND());
  await reactivate(sw, page);
  await expect(part(page, 'send')).toBeEnabled();
  await expect(part(page, 'list-item')).toHaveCount(1);
  await stubBridge(sw, SEND_FAILS('version_mismatch', message));
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(message);
  await expect(part(page, 'status-offer')).toBeHidden();
  await expect(part(page, 'send')).toBeDisabled();
  await expect(part(page, 'list-item')).toHaveCount(1);
});

// What page script can do: it moves the focus into a frame of its own and back, and the browser
// makes real focus events for the window, as for a user who comes back to the page.
async function focusInAndOut(times: number): Promise<void> {
  await page.evaluate(async times => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<input>';
    const loaded = new Promise(resolve => frame.addEventListener('load', resolve));
    document.body.append(frame);
    await loaded;
    const button = document.createElement('button');
    document.body.append(button);
    const tick = () => new Promise(resolve => setTimeout(resolve, 20));
    for (let i = 0; i < times; i++) {
      frame.contentDocument!.querySelector('input')!.focus();
      await tick();
      button.focus();
      await tick();
    }
    frame.remove();
    button.remove();
  }, times);
}

// So a page that makes those events in a loop cannot make the bar call the bridge in a loop. The
// dropdown listed the agents in the test before, so the test first lets two seconds pass.
test('coming back to the page lists the agents at most once in two seconds', async () => {
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));
  await reactivate(sw, page);
  await expect(part(page, 'status-offer')).toBeVisible();
  await page.waitForTimeout(2000);
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));   // empties the record
  await focusInAndOut(5);
  // Copy's request comes after every listing that the focus events caused.
  await part(page, 'copy').click();
  await expect(part(page, 'status')).toHaveText('Copied as Markdown, without screenshots.');
  const asked = await requests(sw);
  const beforeCopy = asked.slice(0, asked.findIndex(request => request.type === 'copy'));
  expect(beforeCopy.filter(request => request.type === 'agents')).toHaveLength(1);
  await expect(part(page, 'list-item')).toHaveCount(1);
});

test('a longer message keeps the header of a bar at the top inside the window', async () => {
  const top = async () => (await part(page, 'bar').boundingBox())!.y;
  const handle = (await part(page, 'count').boundingBox())!;      // in the header, not a button
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, 0, { steps: 4 });
  await page.mouse.up();
  expect(await top()).toBeLessThan(1);                            // dragged to the top edge
  // Longer than the message the test above left; only the bar changes, not the page.
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));
  await part(page, 'agent-select').focus();
  await expect(part(page, 'status')).toHaveText(BRIDGE_NOT_RUNNING);
  await expect.poll(top).toBeGreaterThanOrEqual(0);
});

// A regression test: the service worker once sent the tab's draft whatever page it was made on.
test('a send from another page in the tab does not deliver the annotations of the first', async () => {
  await stubBridge(sw, BOUND());
  await expect(part(page, 'list-item')).toHaveCount(1);       // left on page.html by the tests above
  const first = page.url();
  const other = new URL('other.html', first).href;
  await page.goto(other);
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(0);
  await expect(part(page, 'send')).toBeDisabled();
  // The bar offers no Send here, so the tab asks the service worker itself, as Send would.
  const info: PageInfo = { url: other, title: 'Other', viewport: { width: 1280, height: 720 }, devicePixelRatio: 1, sourceFile: null };
  const reply = await sw.evaluate(async info => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: (page: PageInfo) => chrome.runtime.sendMessage({ type: 'send', agent: 't7', page }),
      args: [info],
    });
    return result?.result;
  }, info);
  expect(reply).toEqual({ ok: false, kind: 'failed', message: 'There are no annotations to send.' });
  expect((await requests(sw)).filter(r => r.type === 'send')).toHaveLength(0);
  // Back on their own page, the annotations are still there.
  await page.goto(first);
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(1);
});

test('Copy works on a page that is not a secure context', async () => {
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));
  const secure = page.url();
  await page.goto(secure.replace('127.0.0.1', INSECURE_HOST));
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await activate(sw, page);
  await annotate(page, '#cta', 'On a plain http page');
  await part(page, 'copy').click();
  await expect(part(page, 'status')).toHaveText('Copied as Markdown, without screenshots.');
  // That page cannot read the clipboard either; the one on 127.0.0.1 can.
  await page.goto(secure);
  expect(await clipboard()).toContain('On a plain http page');
});

// A single-page app changes the URL without a reload; the bar still shows the annotations.
test('Send after a client-side URL change delivers the annotations under the new URL', async () => {
  await stubBridge(sw, BOUND());
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(0);       // the tab's draft is of the plain http page
  await annotate(page, '#cta', 'Made before pushState');
  await page.evaluate(() => history.pushState(null, '', '?view=list'));
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(PICKED_UP_ONE);
  const req = (await requests(sw)).find(r => r.type === 'send')!;
  expect(req.send.page.url).toBe(page.url());
  expect(page.url()).toMatch(/\/page\.html\?view=list$/);
  expect(req.send.annotations.map(a => a.comment)).toEqual(['Made before pushState']);
});

test('annotations follow a client-side URL change, and come back after a reload there', async () => {
  await annotate(page, '#cta', 'Follows the URL');
  await page.evaluate(() => history.pushState(null, '', '?view=grid'));
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect(part(page, 'list-item')).toContainText('Follows the URL');
});

// Page script reaches the UI here only because the test build leaves its shadow root open;
// the extension's own build closes it. Either way, the events it makes do nothing. Each
// effect shows at once, so it is checked inside the page, right after the event.
test('clicks and keys made by page script do not send, copy, pick, add or delete', async () => {
  await stubBridge(sw, BOUND());
  await expect(part(page, 'send')).toBeEnabled();
  const sendOrCopy = await page.evaluate(() => {
    const root = document.querySelector('clicknote-ui')!.shadowRoot!;
    const part = (name: string) => root.querySelector<HTMLButtonElement>(`[data-clicknote="${name}"]`)!;
    part('send').click();
    part('copy').click();
    return { sendOff: part('send').disabled, copyOff: part('copy').disabled, status: part('status').textContent };
  });
  expect(sendOrCopy).toEqual({ sendOff: false, copyOff: false, status: '' });
  // A pick made by page script on #cta would hold the popup, so the user's pick would not open it.
  const cta = (await page.locator('#cta').boundingBox())!;
  await page.evaluate(({ x, y }) => {
    const shield = document.querySelector('clicknote-ui')!.shadowRoot!.querySelector('.shield')!;
    shield.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }));
  }, { x: cta.x + cta.width / 2, y: cta.y + cta.height / 2 });
  await pickAt(page, '#features h3');
  await expect(part(page, 'popup-label')).toHaveText(/^h3 "Fast" /);
  await part(page, 'comment').fill('Typed by the user');
  const addOrSave = await page.evaluate(() => {
    const root = document.querySelector('clicknote-ui')!.shadowRoot!;
    const part = (name: string) => root.querySelector<HTMLElement>(`[data-clicknote="${name}"]`)!;
    part('add').click();
    const afterClick = (part('add') as HTMLButtonElement).disabled;
    part('comment').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, composed: true }));
    return { addOffAfterClick: afterClick, addOffAfterKey: (part('add') as HTMLButtonElement).disabled };
  });
  expect(addOrSave).toEqual({ addOffAfterClick: false, addOffAfterKey: false });
  await part(page, 'cancel').click();
  await part(page, 'list-item').first().locator('button').click();
  const popupHidden = await page.evaluate(() => {
    const root = document.querySelector('clicknote-ui')!.shadowRoot!;
    root.querySelector<HTMLElement>('[data-clicknote="delete"]')!.click();
    return root.querySelector<HTMLElement>('[data-clicknote="popup"]')!.hidden;
  });
  expect(popupHidden).toBe(false);
  await part(page, 'cancel').click();
  await expect(part(page, 'list-item')).toHaveCount(1);
  // The user's own click on the row is a use of the bar, which lists the agents; nothing else
  // reached the bridge.
  const reached = await requests(sw);
  expect(reached.filter(request => request.type !== 'agents')).toEqual([]);
  expect(reached.length).toBeLessThanOrEqual(1);
});

// A reload starts a new page session, in which the user has not chosen an agent yet. The sends
// above were delivered to t7, which made it the tab's agent; here the tab has none, as a tab that
// has sent nothing.
test('with several agents and none bound or chosen, Send waits until the user chooses one', async () => {
  await stubBridge(sw, AGENTS_OK());
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.remove(`agent:${tab.id}`);
  });
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(1);
  const options = part(page, 'agent-select').locator('option');
  await expect(options).toHaveText(['Choose an agent…', ...AGENTS.map(listedAs)]);
  await expect(options.first()).toBeDisabled();
  await expect(part(page, 'agent-select')).toHaveValue('');
  await expect(part(page, 'send')).toBeDisabled();
  await expect(part(page, 'copy')).toBeEnabled();
  await part(page, 'agent-select').selectOption('t7');
  await expect(part(page, 'send')).toBeEnabled();
});

test('with one agent and none bound or chosen, that agent is selected', async () => {
  await stubBridge(sw, AGENTS_OK({ agents: [AGENTS[0]] }));
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'agent-select').locator('option')).toHaveText([listedAs(AGENTS[0])]);
  await expect(part(page, 'agent-select')).toHaveValue('t6m');
  await expect(part(page, 'send')).toBeEnabled();
});

// The account menu in page.html closes when focus lands anywhere outside it.
test('a page menu stays open while the user picks in it, and its item is sent as it was picked', async () => {
  await stubBridge(sw, BOUND());
  await reactivate(sw, page);
  await part(page, 'pick-toggle').click();                       // off, so the page gets the click
  await page.click('#account-button');
  await expect(page.locator('#account-menu')).toBeVisible();
  await part(page, 'pick-toggle').click();
  await expect(part(page, 'pick-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#account-menu')).toBeVisible();
  const item = (await page.locator('#account-menu li').first().boundingBox())!;
  const label = `li "Your account" ${Math.round(item.width)}x${Math.round(item.height)}`;
  await pickAt(page, '#account-menu li');
  await expect(part(page, 'popup-label')).toHaveText(label);
  await expect(page.locator('#account-menu')).toBeVisible();   // the popup's focus did not reach the page
  await part(page, 'comment').fill('Picked in the menu');
  // The menu closes before Add, as one that closes when focus leaves it would.
  await page.evaluate(() => { document.querySelector<HTMLElement>('#account-menu')!.hidden = true; });
  await part(page, 'comment').press('Meta+Enter');
  await expect(part(page, 'count')).toHaveText('2');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(`Sent 2 annotations to ${T7}. The agent picked them up.`);
  const sent = (await requests(sw)).find(r => r.type === 'send')!.send;
  const picked = sent.annotations[1];
  expect(picked.label).toBe(label);
  expect(picked.selector).toBe('#account-menu > li:nth-of-type(1)');
  expect(picked.rect).toMatchObject({ width: item.width, height: item.height });
  // The crop was taken at the pick, while the menu was open.
  expect(sent.images[picked.id]).toMatch(/^iVBOR/);
});

test('a pick takes its crop at once, and a pick that is not added leaves no crop behind', async () => {
  await stubBridge(sw, BOUND());
  const tentative = async () => {
    await pickAt(page, '#cta');
    await expect(part(page, 'popup-label')).toHaveText(/^button "Get started" /);
  };
  // Crops of drafts that a later page in the tab replaced are still there from the tests above.
  const base = await cropIds(sw);
  await tentative();
  await expect.poll(() => cropIds(sw)).toHaveLength(base.length + 1);
  await part(page, 'cancel').click();
  await expect.poll(() => cropIds(sw)).toEqual(base);
  await tentative();
  await expect.poll(() => cropIds(sw)).toHaveLength(base.length + 1);
  await page.keyboard.press('Escape');
  await expect(part(page, 'popup')).toBeHidden();
  await expect.poll(() => cropIds(sw)).toEqual(base);
  // Opening an annotation replaces the popup of a pick; editing it keeps its own crop.
  await annotate(page, '#features h3', 'Kept');
  const kept = await cropIds(sw);
  expect(kept).toHaveLength(base.length + 1);
  await tentative();
  await expect.poll(() => cropIds(sw)).toHaveLength(kept.length + 1);
  await part(page, 'list-item').first().locator('button').click();
  await expect(part(page, 'comment')).toHaveValue('Kept');
  await expect.poll(() => cropIds(sw)).toEqual(kept);
  await part(page, 'comment').fill('Kept, edited');
  await part(page, 'comment').press('Meta+Enter');
  await expect(part(page, 'popup')).toBeHidden();
  expect(await cropIds(sw)).toEqual(kept);
  // Turning the UI off, and a reload.
  await tentative();
  await expect.poll(() => cropIds(sw)).toHaveLength(kept.length + 1);
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeHidden();
  await expect.poll(() => cropIds(sw)).toEqual(kept);
  await activate(sw, page);
  await tentative();
  await expect.poll(() => cropIds(sw)).toHaveLength(kept.length + 1);
  await page.reload();
  await expect.poll(() => cropIds(sw)).toEqual(kept);
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveText([/^1Kept, edited/]);
});

test('a second click while the crop is taken does not reach the page', async () => {
  const link = (await page.locator('#link').boundingBox())!;
  await page.mouse.dblclick(link.x + link.width / 2, link.y + link.height / 2);
  await expect(part(page, 'popup-label')).toHaveText(/^a "Other" /);
  expect(page.url()).toMatch(/\/page\.html\?view=grid$/);
  await part(page, 'cancel').click();
});

// The keys the page's own listeners have seen since `watchKeys`, as `<type> <key>`.
const keysSeen = () => page.evaluate(() => (window as unknown as { keysSeen: string[] }).keysSeen);

async function watchKeys(): Promise<void> {
  await page.evaluate(() => {
    const seen = window as unknown as { keysSeen?: string[] };
    if (!seen.keysSeen) {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        document.addEventListener(type, event => { seen.keysSeen!.push(`${type} ${(event as KeyboardEvent).key}`); });
      }
    }
    seen.keysSeen = [];
  });
}

const host = () => page.locator('clicknote-ui');

test('keys pressed while the crop is taken do not reach the page', async () => {
  await watchKeys();
  await page.locator('#cta').focus();       // the focus is in the page, where a pick leaves it
  const release = await holdCaptures();
  await pickAt(page, '#cta');
  await page.keyboard.press('k');
  await release();
  await expect(part(page, 'popup-label')).toHaveText(/^button "Get started" /);
  await expect(part(page, 'comment')).toHaveValue('');
  expect(await keysSeen()).toEqual([]);
  await part(page, 'cancel').click();
});

test('Esc while the crop is taken cancels the pick and stays in pick mode', async () => {
  await watchKeys();
  const base = await cropIds(sw);
  await page.locator('#cta').focus();
  const release = await holdCaptures();
  await pickAt(page, '#cta');
  await page.keyboard.press('Escape');
  await release();
  // The UI shows again once the crop is taken, and a popup would open at the same moment.
  await expect(host()).not.toHaveAttribute('data-capturing');
  expect(await part(page, 'popup').isVisible()).toBe(false);
  await expect(part(page, 'pick-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => cropIds(sw)).toEqual(base);
  expect(await keysSeen()).toEqual([]);
  await pickAt(page, '#features h3');
  await expect(part(page, 'popup-label')).toHaveText(/^h3 "Fast" /);
  await part(page, 'cancel').click();
});

test('turning the UI off while the crop is taken leaves no outline for when it comes back', async () => {
  const release = await holdCaptures();
  await pickAt(page, '#cta');
  await activate(sw, page);                 // off, while the crop is taken
  await expect(part(page, 'bar')).toBeHidden();
  await release();
  await expect(host()).not.toHaveAttribute('data-capturing');
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeVisible();
  await expect(part(page, 'popup')).toBeHidden();
  await expect(part(page, 'highlight')).toBeHidden();
});

test('a pick whose popup is open keeps its crop when the page comes back from the back/forward cache', async () => {
  const base = await cropIds(sw);
  await pickAt(page, '#cta');
  await expect(part(page, 'popup-label')).toHaveText(/^button "Get started" /);
  await expect.poll(() => cropIds(sw)).toHaveLength(base.length + 1);
  const [crop] = (await cropIds(sw)).filter(id => !base.includes(id));
  await page.evaluate(() => {
    addEventListener('pageshow', event => { (window as unknown as { restored: boolean }).restored = event.persisted; });
  });
  await page.goto(new URL('other.html', page.url()).href);
  await page.goBack({ waitUntil: 'commit' });              // a page from the cache fires no load
  await expect.poll(() => page.evaluate(() => (window as unknown as { restored?: boolean }).restored)).toBe(true);
  await expect(part(page, 'popup')).toBeVisible();
  await part(page, 'comment').fill('Picked before the back/forward cache');
  await part(page, 'comment').press('Meta+Enter');
  await expect(part(page, 'list-item')).toHaveCount(2);
  expect(await cropIds(sw)).toContain(crop);
  // Deleted again, with its crop, for the tests below.
  await part(page, 'list-item').nth(1).locator('button').click();
  await part(page, 'delete').click();
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect.poll(() => cropIds(sw)).toEqual(base);
});

// Focus on the dropdown lists the agents; it has to leave first to come back. That focus is a use
// of the bar too, which makes no listing of its own.
async function listAgain(): Promise<void> {
  await part(page, 'agent-select').blur();
  await part(page, 'agent-select').focus();
}

const NO_AGENTS_LISTED = { reply: { ok: true, agents: [], preselect: null } };

// What the listing after a send finds in the two tests below: no longer the two agents
// listed before it, nor the none listed while it ran.
const ONE_AGENT_LISTED = { reply: { ok: true, agents: [AGENTS[0]], preselect: null } };

const agentOptions = () => part(page, 'agent-select').locator('option');
const agentsAsked = async () => (await requests(sw)).filter(r => r.type === 'agents').length;

test('a listing that ends during a send changes nothing, and the agents are listed again after it', async () => {
  await stubBridge(sw, SLOW_OK(1500));
  await expect(part(page, 'send')).toBeEnabled();
  const before = await agentOptions().allTextContents();
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText('Sending…');
  await stubBridge(sw, { ...SLOW_OK(1500), agents: NO_AGENTS_LISTED });   // the send under way keeps its stand-in
  await listAgain();
  await expect.poll(agentsAsked).toBe(1);
  await stubBridge(sw, { ...BOUND(), agents: ONE_AGENT_LISTED });
  // Checked at once, not waited for: the send runs on for a while, and the listing has
  // been answered.
  expect(await agentOptions().allTextContents()).toEqual(before);
  expect(await part(page, 'status').textContent()).toBe('Sending…');
  await expect(part(page, 'status')).toHaveText(PICKED_UP_ONE);
  await expect(agentOptions()).toHaveText([listedAs(AGENTS[0])]);
  expect(await part(page, 'status').textContent()).toBe(PICKED_UP_ONE);
});

// The listing is held back until the send has ended, and the answer about the send's state until
// the listing has been answered: the listing would say that no agent is listening.
test('a listing that was running when a send ended does not replace its outcome', async () => {
  await stubBridge(sw, BOUND());
  await reactivate(sw, page);
  await annotate(page, '#cta', 'Once more');
  await stubBridge(sw, {
    ...SLOW_OK(300), agents: { ...NO_AGENTS_LISTED, hold: 0 }, state: { reply: stateOf('picked_up'), hold: 0 },
  });
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText('Sending…');
  await listAgain();                                        // answers after the send has ended
  await expect.poll(agentsAsked).toBeGreaterThanOrEqual(1);
  // The bar asks for the state once the send has ended.
  await expect.poll(async () => (await requests(sw)).filter(r => r.type === 'state').length).toBe(1);
  const running = await agentsAsked();
  await letGo(sw, 'agents');
  // The answer is not used: the agents are listed once more, and nothing is said.
  await expect.poll(() => answered(sw, 'agents')).toBe(running + 1);
  expect(await part(page, 'status').textContent()).toBe('Sending…');
  await stubBridge(sw, { ...BOUND(), agents: ONE_AGENT_LISTED });
  await letGo(sw, 'state');
  await expect(part(page, 'status')).toHaveText(PICKED_UP_ONE);
  await expect(agentOptions()).toHaveText([listedAs(AGENTS[0])]);
  expect(await part(page, 'status').textContent()).toBe(PICKED_UP_ONE);
});

// Last in this file: it leaves an annotation behind that cannot be rendered as Markdown.
test('an error inside a copy ends it with a message instead of leaving "Copying…"', async () => {
  // A draft whose annotation lacks its styles.
  await sw.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const broken = {
      id: 'b0000001', number: 1, intent: 'change', comment: 'Broken', label: 'button 1x1', selector: '#cta',
      domPath: 'body', text: '', html: '<button></button>', rect: { x: 0, y: 0, width: 1, height: 1 }, screenshot: null,
    };
    await chrome.storage.session.set({ [`draft:${tab.id}`]: { url, note: '', annotations: [broken] } });
  }, page.url());
  await stubBridge(sw, ALWAYS({ ok: false, kind: 'bridge_down', message: '' }));
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(1);
  await part(page, 'copy').click();
  await expect(part(page, 'status')).toHaveText(/^Copying failed: \S/);
  await expect(part(page, 'copy')).toBeEnabled();
  await expect(part(page, 'list-item')).toHaveCount(1);
});
