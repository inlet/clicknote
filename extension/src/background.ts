import type {
  AgentInfo, BridgeRequest, PageInfo, Rect, SendPayload, SendStatus, SentOk, StateOk,
} from '../../shared/types.ts';
import { isLinkable, parseUrl } from '../../shared/url.ts';
import { bridgePort, failed, fetchFailed, readReply, sendToBridge } from './bridge-client.ts';
import type { ClientReply } from './bridge-client.ts';
import { blobToBase64, cropRect } from './crop.ts';
import {
  clearCrops, deleteCrops, deleteDraft, deleteSentDraft, forgetRecord, getCrop, loadDraft,
  newSendId, putCrop, readRecord, saveDraft, saveRecord, updateRecord, whatWasSent,
} from './drafts.ts';
import { noAnswer, settled, stillArriving } from './follow.ts';
import type { Draft, Followed, NotFollowed, SendRecord, SendReply, ToBackground, ToContent } from './messages.ts';
import { chooseAgent, forgetTabAgent, isOpenAddress, readTabAgent, saveTabAgent } from './tab-agent.ts';

// The service worker: turns the extension on for a tab, captures and crops screenshots,
// keeps the unsent annotations of each tab, the record of its send and the tab's agent, and
// relays requests to the bridge. Chrome may stop it at any time, so nothing lives in module
// variables: drafts, records, agents and crops are in storage. Its listeners are added at the top
// level, so an event starts it when it is stopped.

// True in the build for the browser tests (`node build.mjs --e2e`).
declare const __E2E__: boolean;

const CANNOT_ANNOTATE = 'Cannot annotate this page. For file:// pages, switch on "Allow access to file URLs" for this extension.';
const NO_RECEIVER = 'Receiving end does not exist';
const CAPTURE_QUOTA = 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND';
const NOTHING_TO_SEND = 'There are no annotations to send.';
const NO_RECORD = 'The extension could not keep a record of this send, so it was not started.';
const NOT_FOLLOWED: NotFollowed = { followed: false };

// Fired by a click on the toolbar button and by the shortcut the manifest suggests.
chrome.action.onClicked.addListener(tab => {
  if (tab.id !== undefined) activate(tab.id).catch(warn('Turning on failed'));
});

chrome.runtime.onMessage.addListener((message: ToBackground, sender, sendResponse) => {
  const answered = answer(message, sender).then(sendResponse, error => sendResponse(failed(error)));
  if (__E2E__) void answered.then(() => noteAnswered(message.type));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  deleteDraft(tabId).catch(warn('Removing the draft of a closed tab failed'));
  forgetTabAgent(tabId).catch(warn('Forgetting the agent of a closed tab failed'));
});

// chrome.storage.session is emptied when the browser starts and when the extension is
// installed, updated or reloaded. The crops in IndexedDB would outlive their drafts.
chrome.runtime.onStartup.addListener(startAfresh);
chrome.runtime.onInstalled.addListener(startAfresh);

if (__E2E__) installTestHooks();

// After the session storage was emptied: the crops go.
function startAfresh(): void {
  clearCrops().catch(warn('Clearing the crops failed'));
}

// Shows or hides the UI in the tab, injecting the content script when it is not there yet.
// When the page cannot be entered (chrome:// pages, the Web Store, file:// without access),
// the button gets a badge and a title that says why.
async function activate(tabId: number): Promise<void> {
  if (await toggle(tabId)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    await chrome.action.setBadgeText({ tabId, text: '!' });
    await chrome.action.setTitle({ tabId, title: CANNOT_ANNOTATE });
  }
}

// Sends `toggle` to the content script. False when the tab has none: only then does Chrome
// report that the receiving end does not exist. A content script that does not answer
// counts as there, so it is never injected twice.
async function toggle(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' } satisfies ToContent, { frameId: 0 });
    return true;
  } catch (error) {
    return !String(error).includes(NO_RECEIVER);
  }
}

// The answer to one message from a content script. The tab it came from decides which draft
// and which window.
async function answer(message: ToBackground, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tab = sender.tab;
  if (tab?.id === undefined) return failed('This message has to come from a tab.');
  const tabId = tab.id;
  switch (message.type) {
    case 'draft:load':
      return { draft: await loadDraft(tabId, message.url) };
    case 'draft:save':
      await saveDraft(tabId, message.draft);
      return { ok: true };
    case 'capture':
      return { ok: await capture(tab, message.id, message.rect, message.viewport) };
    case 'crop:get':
      return { dataUrl: await cropDataUrl(message.id) };
    case 'crop:delete':
      await deleteCrops([message.id]);
      return { ok: true };
    case 'agents':
      return agentsFor(tabId, message.url);
    case 'send':
      return sendDraft(tabId, message.agent, message.page);
    case 'send:state':
      return stateOfSend(tabId, message.id);
    case 'send:load':
      return { record: await readRecord(tabId) };
    case 'copy':
      return copyDraft(tabId, message.page);
    case 'opened':
      return opened(tabId, sender, message.code);
    default:
      return failed('The service worker does not know this message.');
  }
}

// Captures the visible part of the tab and stores the crop of `rect` under the annotation id.
// False when the capture fails or nothing of the element is visible.
async function capture(
  tab: chrome.tabs.Tab,
  id: string,
  rect: Rect,
  viewport: { width: number; height: number },
): Promise<boolean> {
  // captureVisibleTab takes the active tab of the window, which would then be another page.
  if (!tab.active) return false;
  try {
    const screenshot = await (await fetch(await captureVisibleTab(tab.windowId))).blob();
    const bitmap = await createImageBitmap(screenshot);
    try {
      // From the screenshot itself, so it is right under page zoom, unlike devicePixelRatio.
      const area = cropRect(rect, viewport, bitmap.width / viewport.width);
      if (!area) return false;
      const canvas = new OffscreenCanvas(area.sw, area.sh);
      const context = canvas.getContext('2d');
      if (!context) return false;
      context.drawImage(bitmap, area.sx, area.sy, area.sw, area.sh, 0, 0, area.sw, area.sh);
      await putCrop(id, await canvas.convertToBlob({ type: 'image/png' }));
      return true;
    } finally {
      bitmap.close();
    }
  } catch (error) {
    warn('The capture failed')(error);
    return false;
  }
}

// A PNG data URL of the visible tab. Chrome allows two captures per second; a capture over
// that limit waits for the next second and tries once more.
async function captureVisibleTab(windowId: number): Promise<string> {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  } catch (error) {
    if (!String(error).includes(CAPTURE_QUOTA)) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000));
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

async function cropDataUrl(id: string): Promise<string | null> {
  const png = await getCrop(id);
  return png ? `data:image/png;base64,${await blobToBase64(png)}` : null;
}

// The agents for the bar, as the bridge lists them, with the one to choose: the tab's agent when
// it is listed, ahead of the bridge's own choice for the page's site. A listing without a failure
// that does not hold the tab's agent makes the tab forget it.
async function agentsFor(tabId: number, url: string): Promise<ClientReply> {
  const reply = await callBridge({ type: 'agents', url });
  if (!reply.ok || !('agents' in reply)) return reply;
  const tabAgent = await readTabAgent(tabId).catch(error => {
    warn('Reading the agent of the tab failed')(error);
    return null;
  });
  const { preselect, forget } = chooseAgent(tabAgent, reply.agents.map(agent => agent.id), reply.preselect);
  if (forget) await forgetTabAgent(tabId).catch(warn('Forgetting the agent of the tab failed'));
  return { ...reply, preselect };
}

// The open page of a link tells the code in its address. Only the top frame of a tab on the open
// address with that code, on this build's port, is believed, and only then is the bridge asked
// whose link it is: its agent becomes the tab's agent. A local file the service worker opens in
// the tab itself, when the extension has access to file URLs and the tab still shows the open
// page; a web page the open page opens. The answer comes in every case, also after a failure, so
// the page goes on: `ok` when the bridge knew the link.
async function opened(tabId: number, sender: chrome.runtime.MessageSender, code: string): Promise<{ ok: boolean }> {
  if (sender.frameId !== 0 || !isOpenAddress(sender.url, code, bridgePort())) return { ok: false };
  const reply = await callBridge({ type: 'opened', code });
  if (!reply.ok || !('url' in reply) || !isLinkable(reply.url)) return { ok: false };
  await saveTabAgent(tabId, reply.agent).catch(warn('Keeping the agent of the tab failed'));
  if (parseUrl(reply.url)?.protocol === 'file:' && await chrome.extension.isAllowedFileSchemeAccess()
    && await stillOpen(tabId, code)) {
    await chrome.tabs.update(tabId, { url: reply.url }).catch(warn('Opening the local file failed'));
  }
  return { ok: true };
}

// Whether the tab still shows the open address of the link with this code. The bridge's answer
// can come late, and a tab the user has taken elsewhere must stay there. Chrome gives the tab's URL
// only for a page on 127.0.0.1, which the extension may reach; a tab without one, a tab that is
// gone and a lookup that fails all count as moved on.
async function stillOpen(tabId: number, code: string): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return isOpenAddress(tab?.url, code, bridgePort());
}

// Sends the tab's draft to the agent. The record of the send is written before the bridge is
// asked, in place of any earlier one, so a page that loads before the bridge has answered goes
// on following the send: the id made here, which goes to the bridge with the send, when it
// started, the agent, and what it carries, with no line and no state yet. The draft and its crops
// are read first, so the record comes as close to the request as it can. A send whose record
// cannot be written is not started. The bridge answers once it has queued the send, with its
// line, and the answer says that it is queued (noteState). After a failure in which the bridge
// did nothing with the send, the record goes. After one without an answer of the bridge's own
// (noAnswer) it stays: the bridge may have the send all the same, and the state asked for later
// tells.
async function sendDraft(tabId: number, agent: AgentInfo, page: PageInfo): Promise<SendReply> {
  const loaded = await payloadOf(tabId, page);
  if (!loaded) return failed(NOTHING_TO_SEND);
  const record: SendRecord = {
    id: newSendId(), startedAt: Date.now(), agent, sent: whatWasSent(loaded.draft), line: null, kept: false, status: null,
  };
  try {
    await saveRecord(tabId, record);
  } catch (error) {
    warn('Keeping the record of the send failed')(error);
    return failed(NO_RECORD);
  }
  const reply = await callBridge({ type: 'send', id: record.id, agent: agent.id, send: loaded.send });
  if (!reply.ok) {
    if (!noAnswer(reply)) await forgetRecord(tabId, record.id).catch(warn('Forgetting the record of the send failed'));
    return reply;
  }
  // readReply gives a send nothing but a SentOk or a failure.
  const { line } = reply as SentOk;
  // The bridge has the send, so a step that fails must not turn this into a failure: the user
  // would send again and the agent would get it twice.
  const noted = await noteState(tabId, record.id, 'queued', line).catch(error => {
    warn('Noting the state of the send failed')(error);
    return null;
  });
  return noted ?? { ok: true, state: 'queued', line, kept: false };
}

// How the send with this id stands, for the page that follows it. Only the tab's record is asked
// about: for another id the answer is NOT_FOLLOWED, and the bridge is not asked. The bridge is
// asked with the agent in the record, and what it answers is noted in the record (noteState),
// unless the tab's record has meanwhile become another send's. A failure leaves the record as it
// is.
async function stateOfSend(tabId: number, id: string): Promise<SendReply | NotFollowed> {
  const record = await readRecord(tabId);
  if (record?.id !== id) return NOT_FOLLOWED;
  const reply = await callBridge({ type: 'state', id, agent: record.agent.id });
  if (!reply.ok) return reply;
  // readReply gives a request for a send's state nothing but a StateOk or a failure.
  const { state, line } = reply as StateOk;
  return await noteState(tabId, id, state, line) ?? NOT_FOLLOWED;
}

// Notes in the tab's record what the bridge said about the send with this id, and gives how the
// send stands, for the page. Null when the tab's record is of another send, or gone: then nothing
// changes. A record without a line has had no word yet that the bridge has the send. For it,
// `unknown` is no answer yet while the send may still be arriving (stillArriving): the record
// stays as it is, and the page is told `sending`. After that, `unknown` means that the send never
// arrived: the record goes, and the draft stays. Any other state is that word (arrive). A settled
// state then removes the record; any other gives it the line, whether the list was kept, and the
// state. The line is the bridge's, or the record's when the bridge gives none, as for a send it no
// longer knows. A write that fails is logged and changes nothing in the answer, which the page
// needs to learn that the send arrived.
async function noteState(tabId: number, id: string, state: SendStatus, line: string | null): Promise<Followed | null> {
  const record = await readRecord(tabId);
  if (record?.id !== id) return null;
  if (record.line === null && state === 'unknown') {
    if (stillArriving(record.startedAt, Date.now())) return { ok: true, state: 'sending', line: null, kept: false };
    await forgetRecord(tabId, id).catch(warn('Forgetting the record of the send failed'));
    return { ok: true, state, line: null, kept: false };
  }
  const kept = record.line === null ? await arrive(tabId, record) : record.kept;
  const known = line ?? record.line;
  if (settled(state)) await forgetRecord(tabId, id).catch(warn('Forgetting the record of the send failed'));
  else await updateRecord(tabId, { ...record, line: known, kept, status: state }).catch(warn('Noting the state of the send failed'));
  return { ok: true, state, line: known, kept };
}

// What the first word that the bridge has a send changes: the agent it went to becomes the tab's
// agent, and the tab's draft and its crops go while the draft is still what the send carried.
// True when the draft stays, because it has changed since (kept). The send has arrived, so a step
// that fails is logged and changes nothing else.
async function arrive(tabId: number, record: SendRecord): Promise<boolean> {
  await saveTabAgent(tabId, record.agent.id).catch(warn('Keeping the agent of the tab failed'));
  return deleteSentDraft(tabId, record.sent).catch(error => {
    warn('Removing the sent draft failed')(error);
    return false;
  });
}

// Copies the tab's draft through the bridge, which writes the files and gives the line. After
// a delivery the draft and its crops are deleted, while the draft is still what was copied;
// after a failure everything stays.
async function copyDraft(tabId: number, page: PageInfo): Promise<ClientReply> {
  const loaded = await payloadOf(tabId, page);
  if (!loaded) return failed(NOTHING_TO_SEND);
  const reply = await callBridge({ type: 'copy', send: loaded.send });
  if (reply.ok) {
    // The files are written, so a failed cleanup must not turn this into a failure.
    await deleteSentDraft(tabId, whatWasSent(loaded.draft)).catch(warn('Removing the copied draft failed'));
  }
  return reply;
}

// The tab's draft and what a send or copy of it carries: the page, the note, and the
// annotations with their crops. Only a draft made on the page being sent counts, so one left
// from another page is never sent under this page. Null when there is nothing to send.
async function payloadOf(tabId: number, page: PageInfo): Promise<{ draft: Draft; send: SendPayload } | null> {
  const draft = await loadDraft(tabId, page.url);
  if (!draft || draft.annotations.length === 0) return null;
  return { draft, send: { page, note: draft.note, annotations: draft.annotations, images: await imagesOf(draft) } };
}

// The crops of the draft's annotations as base64 PNGs, by annotation id. An annotation
// without a crop is sent without an image.
async function imagesOf(draft: Draft): Promise<Record<string, string>> {
  const images: Record<string, string> = {};
  for (const { id } of draft.annotations) {
    const png = await getCrop(id);
    if (png) images[id] = await blobToBase64(png);
  }
  return images;
}

async function callBridge(request: BridgeRequest): Promise<ClientReply> {
  if (__E2E__) return callTestBridge(request);
  return sendToBridge(request);
}

// A handler that logs an error which must not stop anything else, for the worker's console.
function warn(what: string): (error: unknown) => void {
  return error => console.warn(`${what}:`, error);
}

// Hooks for the browser tests. They are reached only behind `__E2E__`, so the production
// bundle leaves them out.
interface TestHooks {
  __clicknoteBridge?: (request: BridgeRequest) => unknown;   // set by a test to stand in for the bridge
  __clicknoteRequests?: BridgeRequest[];                     // every request the stand-in received
  __clicknoteAnswered?: ToBackground['type'][];              // every message answered, in that order
  __clicknoteActivate?: (tabId: number) => Promise<void>;    // what a click on the button does
}

function installTestHooks(): void {
  const hooks = self as unknown as TestHooks;
  hooks.__clicknoteRequests = [];
  hooks.__clicknoteAnswered = [];
  hooks.__clicknoteActivate = activate;
}

// Notes that the service worker has answered a message of this type: all it does for the message
// is done by then.
function noteAnswered(type: ToBackground['type']): void {
  ((self as unknown as TestHooks).__clicknoteAnswered ??= []).push(type);
}

// The bridge's reply in the test build. When a test has set a stand-in, the stand-in answers,
// and its reply is recorded and checked like a real one. A stand-in that throws is read as a
// `fetch` that rejects, so it can stand in for a bridge that gives no answer in time. Else the
// request goes to the bridge on the test port, on which no bridge a user runs listens, so a
// test never reaches real agents.
async function callTestBridge(request: BridgeRequest): Promise<ClientReply> {
  const hooks = self as unknown as TestHooks;
  const standIn = hooks.__clicknoteBridge;
  if (!standIn) return sendToBridge(request);
  (hooks.__clicknoteRequests ??= []).push(request);
  try {
    return readReply(request.type, await standIn(request));
  } catch (error) {
    return fetchFailed(error);
  }
}
