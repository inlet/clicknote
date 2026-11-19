import { expect, test } from '@playwright/test';
import type { Page, Worker } from '@playwright/test';
import { agentLabel, listedAs } from '../../shared/label.ts';
import { WAIT_SENTENCE } from '../../shared/types.ts';
import type { AgentInfo, BridgeRequest, SendStatus } from '../../shared/types.ts';
import {
  activate, annotate, answered, changeStoredComment, comeBack, cropIds, launch, letGo, part, reactivate, requests, standIn,
  stored, stubBridge,
} from './helpers.ts';
import type { BridgeStub, Session, StubReply } from './helpers.ts';

// A send the bar follows: what it says while the send is queued, once it is picked up or its
// agent is gone, on a page that loads meanwhile, and when the bridge does not answer. One browser
// for the file; every test starts on the fixture page with an empty list, no record of a send,
// and a bridge that queues a send and says that the agent picked it up.
test.describe.configure({ mode: 'serial' });

let session: Session;
let page: Page;
let sw: Worker;
let home: string;

test.beforeAll(async () => {
  session = await launch();
  ({ page, sw } = session);
  home = page.url();
});

test.afterAll(async () => {
  await session?.close();
});

const AGENT = standIn({ id: 't7', about: 'checkout form', harness: 'codex' });
const LABEL = agentLabel(AGENT);
const LINE = 'Browser annotations (1) on the fixture: read /tmp/clicknote-e2e/sends/x/annotations.md';
const SENT = { ok: true, folder: '/tmp/clicknote-e2e/sends/x', line: LINE, agent: 't7' };
const DOWN = { ok: false, kind: 'bridge_down', message: '' };

const QUEUED = `Sent 1 annotation to ${LABEL}. Queued: the agent gets it when it next waits.`;
const PICKED_UP = `Sent 1 annotation to ${LABEL}. The agent picked it up.`;
const GONE = `Sent 1 annotation to ${LABEL}, but that agent is no longer listed and did not pick it up. `
  + 'Copy the line and paste it into another agent. If that agent comes back and waits again, it still gets it.';
const NO_ANSWER = 'Clicknote did not answer this send. Say this to your coding agent; this line then says whether the send arrived.';
const NOT_ARRIVED = 'This send did not arrive. Send again.';
const COPIED = 'Copied. Paste the line into your agent.';
const NOT_LISTENING = 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works, without screenshots.';
const NO_AGENTS = 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works.';
const STAYS = 'The list has changed since, so it stays.';

// The bridge's answer to a request for a send's state.
function state(status: SendStatus, line: string | null = LINE): { ok: true; state: SendStatus; line: string | null } {
  return { ok: true, state: status, line };
}

// A stand-in bridge that lists one agent, bound to the site, and answers a send, and a request for
// its state, as given.
function bridge(send: StubReply, asked: StubReply): BridgeStub {
  return { agents: { reply: { ok: true, agents: [AGENT], preselect: 't7' } }, send, copy: { reply: SENT }, state: asked };
}

// A bridge that does not run.
const NO_BRIDGE: BridgeStub = { agents: { reply: DOWN }, send: { reply: DOWN }, copy: { reply: DOWN }, state: { reply: DOWN } };

// The record of the tab's send, as far as these tests read it.
interface StoredSend { id: string; startedAt: number; line: string | null; kept: boolean; status: SendStatus | null }

type Request<T extends BridgeRequest['type']> = Extract<BridgeRequest, { type: T }>;
const sends = async () => (await requests(sw)).filter((request): request is Request<'send'> => request.type === 'send');
const asked = async () => (await requests(sw)).filter((request): request is Request<'state'> => request.type === 'state');
const agentsAsked = async () => (await requests(sw)).filter(request => request.type === 'agents').length;
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

// Makes the tab's send one that was started `ms` milliseconds ago. Playwright's clock moves the
// page's own timers, not those of the extension, which run in worlds of their own; so a test makes
// the send older instead.
async function startedAgo(ms: number): Promise<void> {
  await sw.evaluate(async ms => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const key = `send:${tab.id}`;
    const record = (await chrome.storage.session.get<{ [key: string]: object }>(key))[key];
    await chrome.storage.session.set({ [key]: { ...record, startedAt: Date.now() - ms } });
  }, ms);
}

// Records every text the status line is given from now on, for statusesShown.
async function watchStatus(): Promise<void> {
  await page.evaluate(() => {
    const status = document.querySelector('clicknote-ui')!.shadowRoot!.querySelector('[data-clicknote="status"]')!;
    const seen = window as unknown as { statusesShown: string[] };
    seen.statusesShown = [];
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) seen.statusesShown.push(node.textContent ?? '');
      }
    }).observe(status, { childList: true });
  });
}

// The texts the status line was given since watchStatus, in order.
const statusesShown = () => page.evaluate(() => (window as unknown as { statusesShown: string[] }).statusesShown);

// The start of every test.
async function fresh(): Promise<void> {
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.remove([`draft:${tab.id}`, `send:${tab.id}`]);
  });
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('picked_up') }));
  await page.goto(home);
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeVisible();
}

test.beforeEach(fresh);

test('a send to an agent that waits ends as picked up, and the list is empty', async () => {
  await annotate(page, '#cta', 'Picked up');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(PICKED_UP);
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'done');
  await expect(part(page, 'status-offer')).toBeHidden();
  await expect(part(page, 'list-item')).toHaveCount(0);
  const [send] = await sends();
  expect(send.id).toMatch(/^[0-9a-f]{16}$/);
  expect(await asked()).toEqual([{ type: 'state', id: send.id, agent: 't7' }]);
  expect(await stored(sw, 'send')).toBeNull();
  expect((await stored<{ annotations: unknown[] }>(sw, 'draft'))?.annotations ?? []).toEqual([]);
  expect(await cropIds(sw)).not.toContain(send.send.annotations[0].id);
});

test('a send to an agent that takes it at once never shows the queued text', async () => {
  await annotate(page, '#cta', 'Taken at once');
  await watchStatus();
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(PICKED_UP);
  const shown = await statusesShown();
  expect(shown).toContain('Sending…');
  expect(shown.filter(text => text.includes('Queued'))).toEqual([]);
  expect(await asked()).toHaveLength(1);
});

// The answer to the first request for the state is held back, so the bar is seen to wait for it.
test('a send whose first state request fails shows the queued text with its line', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: DOWN, hold: 0 }));
  await annotate(page, '#cta', 'No state');
  await part(page, 'send').click();
  await expect.poll(async () => (await asked()).length).toBe(1);
  expect(await part(page, 'status').textContent()).toBe('Sending…');
  await expect(part(page, 'list-item')).toHaveCount(0);
  await letGo(sw, 'state');
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'quiet');
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'offer')).toHaveCSS('font-family', /monospace/);       // a line to paste as it is
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ line: LINE, status: 'queued' });
});

// A bridge that lists the agent as waiting or not, and that answers a send and a request for its
// state as given.
function listing(waiting: boolean, send: StubReply, asked: StubReply): BridgeStub {
  return { ...bridge(send, asked), agents: { reply: { ok: true, agents: [{ ...AGENT, waiting }], preselect: 't7' } } };
}

const options = () => part(page, 'agent-select').locator('option');

test('the dot follows the agent when the user comes back', async () => {
  await expect(options()).toHaveText([listedAs(AGENT)]);
  // The agent starts to wait in another window.
  await stubBridge(sw, listing(true, { reply: SENT }, { reply: state('picked_up') }));
  await comeBack(session.context, page);
  await expect(options()).toHaveText([listedAs({ ...AGENT, waiting: true })]);
  expect(listedAs({ ...AGENT, waiting: true })).toMatch(/^● /);
  // Its wait ends; the user uses the bar once two seconds have passed since the last listing.
  await stubBridge(sw, listing(false, { reply: SENT }, { reply: state('picked_up') }));
  await page.waitForTimeout(2100);
  await part(page, 'count').click();
  await expect(options()).toHaveText([listedAs(AGENT)]);
  expect(listedAs(AGENT)).toMatch(/^○ /);
});

// The agent waits until it has picked the send up. The answer to the request for the state is held
// back until the listings that the click on Send makes have been answered.
test('after a send is picked up the agents are listed again', async () => {
  const waiting = { ...AGENT, waiting: true };
  await stubBridge(sw, listing(true, { reply: SENT }, { reply: state('picked_up'), hold: 0 }));
  await reactivate(sw, page);
  await expect(options()).toHaveText([listedAs(waiting)]);
  await annotate(page, '#cta', 'Picked up by a waiting agent');
  await part(page, 'send').click();
  await expect.poll(async () => (await asked()).length).toBe(1);
  await expect(options()).toHaveText([listedAs(waiting)]);
  await stubBridge(sw, listing(false, { reply: SENT }, { reply: state('picked_up') }));
  await letGo(sw, 'state');
  await expect(part(page, 'status')).toHaveText(PICKED_UP);
  await expect(options()).toHaveText([listedAs(AGENT)]);
  expect(await agentsAsked()).toBe(1);
});

test('a queued send says so and offers its line, and the button copies it', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'Queued');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'quiet');
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
  await expect(part(page, 'list-item')).toHaveCount(0);
  await expect(part(page, 'pick-toggle')).toBeEnabled();          // a queued send does not freeze the list
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ line: LINE, kept: false, status: 'queued' });
  await part(page, 'copy-offer').click();
  await expect.poll(clipboard).toBe(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copied');
  // The bar goes on asking every two seconds; while the send stays queued, the button still says
  // Copied. Two more asks, so the first of them has surely been answered.
  const before = (await asked()).length;
  await expect.poll(async () => (await asked()).length, { timeout: 8_000 }).toBeGreaterThanOrEqual(before + 2);
  expect(await part(page, 'copy-offer').textContent()).toBe('Copied');
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
});

test('a queued send that is picked up later says so without a click', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { replies: [state('queued'), state('queued'), state('picked_up')] }));
  await annotate(page, '#cta', 'Picked up later');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'status')).toHaveText(PICKED_UP, { timeout: 10_000 });
  await expect(part(page, 'status-offer')).toBeHidden();
  expect(await asked()).toHaveLength(3);
  expect(await stored(sw, 'send')).toBeNull();
});

// Stand-in bridges that the agent has left: they say of a queued send that its agent is gone, and
// list another agent (LEFT) or none (NONE_LEFT).
const OTHER = standIn({ id: 't6m', about: 'landing page copy', harness: 'claude-code' });
const leftFor = (agents: AgentInfo[]): BridgeStub =>
  ({ ...bridge({ reply: SENT }, { reply: state('agent_gone') }), agents: { reply: { ok: true, agents, preselect: null } } });
const LEFT = leftFor([OTHER]);
const NONE_LEFT = leftFor([]);

// A send is queued for the agent, and the agent leaves the list, as `left` has it; the bar says so
// with the next answer about the send.
async function queuedThenLeft(comment: string, left = LEFT): Promise<void> {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', comment);
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await stubBridge(sw, left);
  await expect(part(page, 'status')).toHaveText(GONE);
}

// The bar says once that the agent is gone, and forgets the send.
test('a send whose agent left is told once', async () => {
  await watchStatus();
  await queuedThenLeft('Left behind');
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'problem');
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
  await part(page, 'copy-offer').click();
  await expect.poll(clipboard).toBe(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copied');
  expect(await stored(sw, 'send')).toBeNull();
  expect(await statusesShown()).toEqual(['Sending…', QUEUED, GONE]);
  // After a reload, turning the bar on again shows nothing of that send.
  await page.reload();
  await stubBridge(sw, LEFT);
  await activate(sw, page);
  await expect.poll(() => answered(sw, 'draft:load')).toBe(1);
  await expect(options()).toHaveText([listedAs(OTHER)]);
  await expect(part(page, 'status')).toBeHidden();
  expect(await answered(sw, 'send:state')).toBe(0);
  expect(await asked()).toEqual([]);
});

// The agent waits again under its id and gets the send, but the bar has forgotten it.
test('an agent that comes back after the bar forgot its send changes nothing in the bar', async () => {
  await queuedThenLeft('Left, then back');
  await stubBridge(sw, listing(true, { reply: SENT }, { reply: state('picked_up') }));
  // The user comes back to the page once two seconds have passed since the press on Send, which
  // listed the agents: a return lists them at most once in two seconds.
  await page.waitForTimeout(2100);
  await comeBack(session.context, page);
  await expect(options()).toHaveText([listedAs({ ...AGENT, waiting: true })]);
  expect(await answered(sw, 'send:state')).toBe(0);
  expect(await part(page, 'status').textContent()).toBe(GONE);
  // A new send from the tab to that agent is followed, and ends as picked up.
  await annotate(page, '#cta', 'Sent again');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(PICKED_UP);
  const [send] = await sends();
  expect(send.agent).toBe('t7');
  expect(await asked()).toEqual([{ type: 'state', id: send.id, agent: 't7' }]);
});

// The bridge holds its answer to this send until the page has been reloaded, and the agent leaves
// the list meanwhile.
test('the first word about a send can be that its agent is gone', async () => {
  await annotate(page, '#cta', 'Gone before the first word');
  await stubBridge(sw, bridge({ reply: SENT, hold: 0 }, { reply: state('queued') }));
  await part(page, 'send').click();
  await expect.poll(async () => (await sends()).length).toBe(1);
  await page.reload();
  await stubBridge(sw, LEFT);
  await activate(sw, page);
  await expect(part(page, 'status')).toHaveText(GONE);
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'list-item')).toHaveCount(0);
  expect(await stored(sw, 'send')).toBeNull();
  expect((await stored<{ annotations: unknown[] }>(sw, 'draft'))?.annotations ?? []).toEqual([]);
  // The bridge's own answer to the send comes afterwards, and changes nothing.
  await letGo(sw, 'send');
  await expect.poll(() => answered(sw, 'send')).toBe(1);
  expect(await stored(sw, 'send')).toBeNull();
  expect(await part(page, 'status').textContent()).toBe(GONE);
});

test('the dropdown no longer offers an agent that is gone', async () => {
  await queuedThenLeft('Left the dropdown');
  await expect(options()).toHaveText([listedAs(OTHER)]);
  expect(await part(page, 'status').textContent()).toBe(GONE);
});

// The only agent leaves. A listing then turns Send off, but leaves the message on the status line,
// with its line, until the user does something else there.
test('the message for an only agent that is gone stays until the user does something else', async () => {
  await watchStatus();
  await queuedThenLeft('Left alone', NONE_LEFT);
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
  // The listing right after the message.
  await expect(options()).toHaveText(['No agent listening']);
  await expect(part(page, 'send')).toBeDisabled();
  await expect.poll(() => answered(sw, 'agents')).toBe(1);
  // The user comes back to the page, and then presses in the bar, each once two seconds have
  // passed since the listing on a use before it: each lists the agents again.
  await page.waitForTimeout(2100);
  await comeBack(session.context, page);
  await expect.poll(() => answered(sw, 'agents')).toBe(2);
  await page.waitForTimeout(2100);
  await part(page, 'count').click();
  await expect.poll(() => answered(sw, 'agents')).toBe(3);
  await part(page, 'copy-offer').click();
  await expect.poll(clipboard).toBe(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copied');
  expect(await statusesShown()).toEqual(['Sending…', QUEUED, GONE]);
  expect(await part(page, 'status').textContent()).toBe(GONE);
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'send')).toBeDisabled();
  // After a reload the bar shows what it shows without a send: that no agent is listening.
  await page.reload();
  await stubBridge(sw, NONE_LEFT);
  await activate(sw, page);
  await expect(part(page, 'status')).toHaveText(NO_AGENTS);
  await expect(part(page, 'offer')).toHaveText(WAIT_SENTENCE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy sentence');
  await expect.poll(() => answered(sw, 'draft:load')).toBe(1);
  expect(await answered(sw, 'send:state')).toBe(0);
  expect(await asked()).toEqual([]);
});

// What the user does next takes the place of the message: a copy, or a send once the agent is back.
test('after the message of a gone agent, a copy or a new send shows its own status in its place', async () => {
  for (const next of ['a copy', 'a send'] as const) {
    await fresh();
    await queuedThenLeft(`Left before ${next}`, NONE_LEFT);
    await annotate(page, '#cta', `Made for ${next}`);
    expect(await part(page, 'status').textContent(), next).toBe(GONE);
    if (next === 'a copy') {
      await part(page, 'copy').click();
      await expect(part(page, 'status'), next).toHaveText(COPIED);
    } else {
      // The agent waits again: the dropdown lists it, Send comes on, and the message stays.
      await stubBridge(sw, listing(true, { reply: SENT }, { reply: state('picked_up') }));
      await part(page, 'agent-select').focus();
      await expect(part(page, 'send'), next).toBeEnabled();
      expect(await part(page, 'status').textContent(), next).toBe(GONE);
      await part(page, 'agent-select').blur();
      await part(page, 'send').click();
      await expect(part(page, 'status'), next).toHaveText(PICKED_UP);
    }
    await expect(part(page, 'status-offer'), next).toBeHidden();
    await expect(part(page, 'list-item'), next).toHaveCount(0);
  }
});

test('a page reloaded while a send is queued goes on following it', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'Queued before the reload');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  const [send] = await sends();
  await page.reload();
  await stubBridge(sw, bridge({ reply: SENT }, { replies: [state('queued'), state('picked_up')] }));
  await activate(sw, page);
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'list-item')).toHaveCount(0);
  await expect(part(page, 'status')).toHaveText(PICKED_UP, { timeout: 10_000 });
  expect(await asked()).toEqual([
    { type: 'state', id: send.id, agent: 't7' }, { type: 'state', id: send.id, agent: 't7' }]);
  expect(await sends()).toEqual([]);
});

// The bridge holds its answer to this send, and to the first request for its state, until the
// page has been reloaded and shows the send in progress.
test('a page reloaded before the bridge answered learns that the send arrived, and its list empties', async () => {
  await annotate(page, '#cta', 'Sent before the reload');
  await stubBridge(sw, bridge({ reply: SENT, hold: 0 }, { reply: state('queued'), hold: 0 }));
  await part(page, 'send').click();
  await expect.poll(async () => (await sends()).length).toBe(1);
  const [send] = await sends();
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'status')).toHaveText('Sending…');
  await expect(part(page, 'list-item')).toHaveCount(1);
  for (const control of ['send', 'copy', 'pick-toggle']) await expect(part(page, control)).toBeDisabled();
  await expect(part(page, 'agent-select')).toHaveValue('t7');
  await expect.poll(async () => (await asked()).length).toBe(1);
  await letGo(sw, 'state');
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'list-item')).toHaveCount(0);
  await expect(part(page, 'pick-toggle')).toBeEnabled();
  // The bridge's own answer to the send comes afterwards, and changes nothing.
  await letGo(sw, 'send');
  await expect.poll(() => answered(sw, 'send')).toBe(1);
  expect(await sends()).toHaveLength(1);
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
  await expect(part(page, 'list-item')).toHaveCount(0);
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ id: send.id, line: LINE, kept: false, status: 'queued' });
  expect((await stored<{ annotations: unknown[] }>(sw, 'draft'))?.annotations ?? []).toEqual([]);
});

// While the bridge receives a send, it does not hold it yet, and says `unknown` for it. The
// request of the send runs until the test lets it end without an answer.
test('a page reloaded while the bridge still receives the send waits for it', async () => {
  await annotate(page, '#cta', 'Still arriving');
  await stubBridge(sw, bridge({ timeout: true, hold: 0 }, { replies: [state('unknown', null), state('queued')], hold: 1 }));
  await part(page, 'send').click();
  await expect.poll(async () => (await sends()).length).toBe(1);
  const [send] = await sends();
  await page.reload();
  await activate(sw, page);
  // The first answer is no answer yet: the bar goes on saying Sending…, with the list as it was. It
  // asks again two seconds after it has had that answer, and the answer to that is held back.
  await expect.poll(async () => (await asked()).length, { timeout: 8_000 }).toBe(2);
  expect(await part(page, 'status').textContent()).toBe('Sending…');
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'quiet');
  await expect(part(page, 'status-offer')).toBeHidden();
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect(part(page, 'send')).toBeDisabled();
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ id: send.id, line: null, status: null });
  // Now the bridge has it.
  await letGo(sw, 'state');
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'list-item')).toHaveCount(0);
  expect(await asked()).toHaveLength(2);
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ id: send.id, line: LINE, kept: false, status: 'queued' });
  // The request of the send ends without an answer. From here the bar follows the send, and never
  // sends it again.
  await letGo(sw, 'send');
  await expect.poll(() => answered(sw, 'send')).toBe(1);
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('picked_up') }));
  await expect(part(page, 'status')).toHaveText(PICKED_UP);
  expect(await stored(sw, 'send')).toBeNull();
  expect(await sends()).toEqual([]);
});

// The send was started more than ten seconds ago, so `unknown` is the bridge's last word on it.
// The bridge holds its answer to the request for the state until the page shows the send in
// progress, and the request of the send runs until the test lets it end without an answer.
test('a page reloaded before the bridge answered learns that the send never arrived, and its list stays', async () => {
  await annotate(page, '#cta', 'Never arrives');
  await stubBridge(sw, bridge({ timeout: true, hold: 0 }, { reply: state('unknown', null), hold: 0 }));
  await part(page, 'send').click();
  await expect.poll(async () => (await sends()).length).toBe(1);
  await page.reload();
  await startedAgo(11_000);
  await activate(sw, page);
  await expect(part(page, 'status')).toHaveText('Sending…');
  await expect.poll(async () => (await asked()).length).toBe(1);
  await letGo(sw, 'state');
  await expect(part(page, 'status')).toHaveText(NOT_ARRIVED);
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'problem');
  await expect(part(page, 'status-offer')).toBeHidden();
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect(part(page, 'send')).toBeEnabled();
  expect(await stored(sw, 'send')).toBeNull();
  // The request of the send ends without an answer afterwards, and changes nothing.
  await letGo(sw, 'send');
  await expect.poll(() => answered(sw, 'send')).toBe(1);
  expect(await stored(sw, 'send')).toBeNull();
  expect(await part(page, 'status').textContent()).toBe(NOT_ARRIVED);
  await expect(part(page, 'list-item')).toHaveCount(1);
  expect(await sends()).toHaveLength(1);
});

test('a bridge that is gone while a send is queued keeps the line on offer and is asked again when the user comes back', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'Queued, then the bridge goes');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await stubBridge(sw, NO_BRIDGE);
  // The next ask fails, and that ends the round of asks.
  await expect.poll(async () => (await asked()).length).toBe(1);
  await page.waitForTimeout(3000);
  expect(await asked()).toHaveLength(1);
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
  // Coming back while the bridge is still gone asks again, and changes nothing.
  await comeBack(session.context, page);
  await expect.poll(async () => (await asked()).length).toBe(2);
  await page.waitForTimeout(500);
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
  await expect(part(page, 'offer')).toHaveText(LINE);
  // The bridge runs again, and the user comes back once more.
  await page.waitForTimeout(2000);
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('picked_up') }));
  await comeBack(session.context, page);
  await expect(part(page, 'status')).toHaveText(PICKED_UP);
  expect(await asked()).toHaveLength(1);
});

// Makes the service worker read the tab's record of a send 1.5 seconds late, or on time again.
async function slowRecord(on: boolean): Promise<void> {
  await sw.evaluate(on => {
    type Get = (keys?: unknown) => Promise<{ [key: string]: unknown }>;
    const hooks = self as unknown as { __get?: Get };
    const area = chrome.storage.session as unknown as { get: Get };
    if (!on) {
      if (hooks.__get) area.get = hooks.__get;
      delete hooks.__get;
      return;
    }
    const real = hooks.__get = area.get;
    area.get = async keys => {
      if (typeof keys === 'string' && keys.startsWith('send:')) await new Promise(done => setTimeout(done, 1500));
      return real.call(chrome.storage.session, keys);
    };
  }, on);
}

// How the agents come to be listed while the bridge is gone.
type Listed = 'the dropdown' | 'a reload, the listing first' | 'a reload, the record first';

// A send is queued and the user makes another annotation; then the bridge goes, and the agents
// are listed as `listed` says. The status line stays the send's, with its line on offer, and Send
// goes off.
async function listedWhileGone(listed: Listed): Promise<void> {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'Queued');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await annotate(page, '#cta', 'Made after the send');
  await expect(part(page, 'send')).toBeEnabled();
  if (listed === 'the dropdown') {
    await stubBridge(sw, NO_BRIDGE);
    await part(page, 'agent-select').focus();
    await expect.poll(agentsAsked).toBe(1);
    await expect(part(page, 'send')).toBeDisabled();
    // So that the focus does not come back to the dropdown when the user comes back to the page.
    await part(page, 'agent-select').blur();
  } else if (listed === 'a reload, the listing first') {
    await page.reload();
    await stubBridge(sw, NO_BRIDGE);
    await slowRecord(true);
    try {
      await activate(sw, page);
      await expect(part(page, 'status')).toHaveText(NOT_LISTENING);
      await expect(part(page, 'status')).toHaveText(QUEUED);
    } finally {
      await slowRecord(false);
    }
  } else {
    await page.reload();
    await stubBridge(sw, { ...NO_BRIDGE, agents: { reply: DOWN, hold: 0 } });
    await activate(sw, page);
    await expect(part(page, 'status')).toHaveText(QUEUED);
    await expect.poll(agentsAsked).toBe(1);
    await letGo(sw, 'agents');
  }
  // The dropdown says so once the listing has been answered.
  await expect(part(page, 'agent-select').locator('option')).toHaveText(['No agent listening']);
  await expect(part(page, 'send')).toBeDisabled();
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
  await expect(part(page, 'offer')).toHaveText(LINE);
  await expect(part(page, 'copy-offer')).toHaveText('Copy line');
  await expect(part(page, 'list-item')).toHaveCount(1);
}

test('a queued send keeps its line on offer when the agents cannot be listed', async () => {
  await listedWhileGone('the dropdown');
});

// A reload lists the agents and loads the record of the send at the same time; each order is
// made certain here by holding back one of the two.
test('a page reloaded while a send is queued and the bridge is down shows the send\'s line', async () => {
  await listedWhileGone('a reload, the listing first');
  await fresh();
  await listedWhileGone('a reload, the record first');
});

test('Send comes back when the user returns after the bridge is back', async () => {
  for (const listed of ['the dropdown', 'a reload, the listing first', 'a reload, the record first'] as const) {
    await fresh();
    await listedWhileGone(listed);
    await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
    // A return lists the agents at most once in two seconds, counted from the dropdown's listing.
    if (listed === 'the dropdown') await page.waitForTimeout(2000);
    await comeBack(session.context, page);
    await expect(part(page, 'send'), listed).toBeEnabled();
    await expect(part(page, 'agent-select'), listed).toHaveValue('t7');
    expect(await agentsAsked(), listed).toBe(1);
    expect(await part(page, 'status').textContent(), listed).toBe(QUEUED);
    await expect(part(page, 'offer'), listed).toHaveText(LINE);
  }
});

test('a second send takes the place of the first, and a late answer about the first changes nothing', async () => {
  const second = 'Browser annotations (1) on the fixture: read /tmp/clicknote-e2e/sends/y/annotations.md';
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'First');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  const [first] = await sends();
  await annotate(page, '#cta', 'Second');
  // The answer to the next ask about the first is held back until after the second send, and says
  // that its agent is gone; the asks about the second say that it is queued.
  await stubBridge(sw, bridge(
    { reply: { ...SENT, line: second } }, { replies: [state('agent_gone'), state('queued', second)], hold: 0 }));
  await expect.poll(async () => (await asked()).length).toBe(1);
  await part(page, 'send').click();
  await expect.poll(async () => (await sends()).length).toBe(1);
  const [next] = await sends();
  expect(next.id).not.toBe(first.id);
  await letGo(sw, 'state');
  await expect(part(page, 'offer')).toHaveText(second);
  await expect(part(page, 'status')).toHaveText(QUEUED);
  // The late answer about the first has come.
  await expect.poll(() => answered(sw, 'send:state')).toBeGreaterThanOrEqual(2);
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'quiet');
  await expect(part(page, 'offer')).toHaveText(second);
  const states = await asked();
  expect(states[0]).toEqual({ type: 'state', id: first.id, agent: 't7' });
  expect(states.slice(1).every(request => request.id === next.id)).toBe(true);
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ id: next.id, line: second, status: 'queued' });
});

// The send is made older (startedAgo): a page that loads it asks once, as the thirty seconds have
// passed.
test('after thirty seconds the state is asked for again only when the user comes back or uses the bar', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'Queued for long');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await page.reload();
  await startedAgo(60_000);
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await activate(sw, page);
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect.poll(async () => (await asked()).length).toBe(1);
  await page.waitForTimeout(2500);
  expect(await asked()).toHaveLength(1);
  // Coming back to the page asks once.
  await comeBack(session.context, page);
  await expect.poll(async () => (await asked()).length).toBe(2);
  // A press in the bar asks once, and not again within two seconds: a press made as soon as that
  // ask has been answered asks nothing.
  await page.waitForTimeout(2100);
  await part(page, 'count').click();
  await expect.poll(() => answered(sw, 'send:state')).toBe(3);
  await part(page, 'count').click();
  await page.waitForTimeout(500);
  expect(await asked()).toHaveLength(3);
  // The focus coming into the bar asks too.
  await page.waitForTimeout(1600);
  await part(page, 'note').focus();
  await expect.poll(async () => (await asked()).length).toBe(4);
  await page.waitForTimeout(2500);
  expect(await asked()).toHaveLength(4);
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
});

// The one check that a draft is still what was sent. Nothing a user does changes a draft while
// the request of a send runs, so the test changes the stored draft itself.
test('a list that changed during the send stays, and the bar says so', async () => {
  await annotate(page, '#cta', 'As it was sent');
  await stubBridge(sw, bridge({ reply: SENT, hold: 0 }, { reply: state('queued') }));
  await part(page, 'send').click();
  await expect.poll(async () => (await sends()).length).toBe(1);
  await changeStoredComment(sw, 'Changed behind the send');
  await letGo(sw, 'send');
  await expect(part(page, 'status')).toHaveText(`${QUEUED} ${STAYS}`);
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect(part(page, 'list-item')).toContainText('Changed behind the send');
  await expect(part(page, 'send')).toBeEnabled();
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ line: LINE, kept: true, status: 'queued' });
  const draft = await stored<{ annotations: { id: string; comment: string }[] }>(sw, 'draft');
  expect(draft?.annotations.map(annotation => annotation.comment)).toEqual(['Changed behind the send']);
  expect(await cropIds(sw)).toContain(draft!.annotations[0].id);      // its screenshot stays with it
  // The bar goes on following the send, and still says why the list stays.
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('picked_up') }));
  await expect(part(page, 'status')).toHaveText(`${PICKED_UP} ${STAYS}`);
  await expect(part(page, 'list-item')).toHaveCount(1);
});

test('an answer about a send that is no longer the tab\'s shows nothing', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'Forgotten');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  // The record goes behind the page's back; the bridge would now say that the send was picked up.
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.remove(`send:${tab.id}`);
  });
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('picked_up') }));
  await page.waitForTimeout(2500);
  expect(await part(page, 'status').textContent()).toBe(QUEUED);
  await expect(part(page, 'offer')).toHaveText(LINE);
  // The service worker answers without asking the bridge, and the page asks no more.
  expect(await asked()).toEqual([]);
  await comeBack(session.context, page);
  await page.waitForTimeout(500);
  expect(await asked()).toEqual([]);
  const answer = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: () => chrome.runtime.sendMessage({ type: 'send:state', id: '0123456789abcdef' }),
    });
    return result?.result;
  });
  expect(answer).toEqual({ followed: false });
  expect(await asked()).toEqual([]);
});

test('a send that the bridge does not answer says so, offers the sentence, and is asked for when the user comes back', async () => {
  await annotate(page, '#cta', 'No answer');
  await stubBridge(sw, bridge({ timeout: true }, { reply: state('queued') }));
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(NO_ANSWER);
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'problem');
  await expect(part(page, 'offer')).toHaveText(WAIT_SENTENCE);
  await expect(part(page, 'offer')).not.toHaveCSS('font-family', /monospace/);   // a sentence, in the bar's font
  await expect(part(page, 'copy-offer')).toHaveText('Copy sentence');
  await expect(part(page, 'list-item')).toHaveCount(1);
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ line: null, kept: false, status: null });
  await page.waitForTimeout(2500);
  expect(await asked()).toEqual([]);
  // The bridge had the send all the same.
  await comeBack(session.context, page);
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'list-item')).toHaveCount(0);
  expect(await asked()).toHaveLength(1);
  expect(await sends()).toHaveLength(1);
});

// The bridge still receives the send when its request ends without an answer, and says `unknown`
// for it: within ten seconds of its start, that is no answer yet.
test('an answer that the send may still be arriving leaves the line that says no answer came', async () => {
  await annotate(page, '#cta', 'Still arriving after no answer');
  await stubBridge(sw, bridge({ timeout: true }, { replies: [state('unknown', null), state('queued')], hold: 1 }));
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(NO_ANSWER);
  await comeBack(session.context, page);
  // The bar asks again two seconds after it has had the first answer; the answer to that is held.
  await expect.poll(async () => (await asked()).length, { timeout: 8_000 }).toBe(2);
  expect(await part(page, 'status').textContent()).toBe(NO_ANSWER);
  await expect(part(page, 'status')).toHaveAttribute('data-tone', 'problem');
  await expect(part(page, 'offer')).toHaveText(WAIT_SENTENCE);
  await expect(part(page, 'send')).toBeEnabled();
  // The bridge has it now.
  await letGo(sw, 'state');
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'list-item')).toHaveCount(0);
});

test('a copy made while a send is queued keeps its own message', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'Queued');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await annotate(page, '#cta', 'Copied while the send is queued');
  await part(page, 'copy').click();
  await expect(part(page, 'status')).toHaveText(COPIED);
  await expect(part(page, 'status-offer')).toBeHidden();
  // The bar goes on asking, and the send stays queued. Two more asks, so the first of them has
  // surely been answered.
  const before = (await asked()).length;
  await expect.poll(async () => (await asked()).length, { timeout: 8_000 }).toBeGreaterThanOrEqual(before + 2);
  expect(await part(page, 'status').textContent()).toBe(COPIED);
  await expect(part(page, 'status-offer')).toBeHidden();
});

test('a bridge that is down at a send turns Send off, keeps the list and the record, and says whether the send arrived once it runs', async () => {
  await annotate(page, '#cta', 'Bridge down');
  await stubBridge(sw, NO_BRIDGE);
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(NO_ANSWER);
  await expect(part(page, 'offer')).toHaveText(WAIT_SENTENCE);
  await expect(part(page, 'send')).toBeDisabled();
  await expect(part(page, 'agent-select').locator('option')).toHaveText(['No agent listening']);
  await expect(part(page, 'list-item')).toHaveCount(1);
  expect(await stored<StoredSend>(sw, 'send')).toMatchObject({ line: null, status: null });
  // Coming back while the bridge is still down leaves the line about this send as it is.
  await page.waitForTimeout(2100);
  await comeBack(session.context, page);
  await expect.poll(async () => (await asked()).length).toBe(1);
  await page.waitForTimeout(500);
  expect(await part(page, 'status').textContent()).toBe(NO_ANSWER);
  // The bridge runs again, and never had the send, which was started more than ten seconds ago.
  await page.waitForTimeout(2000);
  await startedAgo(11_000);
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('unknown', null) }));
  await comeBack(session.context, page);
  await expect(part(page, 'status')).toHaveText(NOT_ARRIVED);
  await expect(part(page, 'send')).toBeEnabled();
  await expect(part(page, 'list-item')).toHaveCount(1);
  expect(await stored(sw, 'send')).toBeNull();
});

test('a send whose record cannot be written is not started', async () => {
  type Write = (items: { [key: string]: unknown }) => Promise<void>;
  interface Hooks { __write?: Write }
  await annotate(page, '#cta', 'Stays');
  await expect(part(page, 'send')).toBeEnabled();
  await sw.evaluate(() => {
    const area = chrome.storage.session as unknown as { set: Write };
    const real = (self as unknown as Hooks).__write = area.set;
    area.set = items => Object.keys(items).some(key => key.startsWith('send:'))
      ? Promise.reject(new Error('QUOTA_BYTES quota exceeded'))
      : real.call(chrome.storage.session, items);
  });
  try {
    await part(page, 'send').click();
    await expect(part(page, 'status'))
      .toHaveText('Sending failed: The extension could not keep a record of this send, so it was not started.');
  } finally {
    await sw.evaluate(() => {
      (chrome.storage.session as unknown as { set: Write }).set = (self as unknown as Hooks).__write!;
    });
  }
  expect(await sends()).toEqual([]);
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect(part(page, 'send')).toBeEnabled();
});

// The bridge holds its answer to this send until the tab has gone to another page.
test('a send that arrives after the tab went to another page keeps the annotations made there', async () => {
  await annotate(page, '#cta', 'Sent from the first page');
  await stubBridge(sw, bridge({ reply: SENT, hold: 0 }, { reply: state('queued') }));
  await part(page, 'send').click();
  await expect.poll(async () => (await sends()).length).toBe(1);
  await page.goto(new URL('other.html', home).href);
  await activate(sw, page);
  // The bar follows the send of the tab on this page too.
  await expect(part(page, 'status')).toHaveText(QUEUED);
  await expect(part(page, 'list-item')).toHaveCount(0);
  await annotate(page, 'p', 'Made on the other page');
  await letGo(sw, 'send');
  await expect.poll(() => answered(sw, 'send')).toBe(1);              // the bridge's answer has come
  await page.reload();
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(1);
  await expect(part(page, 'list-item')).toContainText('Made on the other page');
});

test('a send followed in one tab does not show in another tab on the same page', async () => {
  await stubBridge(sw, bridge({ reply: SENT }, { reply: state('queued') }));
  await annotate(page, '#cta', 'In the first tab');
  await part(page, 'send').click();
  await expect(part(page, 'status')).toHaveText(QUEUED);
  const second = await session.context.newPage();
  try {
    await second.goto(home);
    await activate(sw, second);
    await expect(part(second, 'bar')).toBeVisible();
    await expect(part(second, 'list-item')).toHaveCount(0);
    await expect(part(second, 'pick-toggle')).toBeEnabled();
    await expect(part(second, 'status')).toBeHidden();
    expect(await stored(sw, 'send')).toBeNull();                      // the second tab has none
  } finally {
    await second.close();
  }
  await page.bringToFront();
  await expect(part(page, 'status')).toHaveText(QUEUED);
});
