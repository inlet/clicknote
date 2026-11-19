"use strict";
(() => {
  // shared/url.ts
  function parseUrl(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }
  function isLinkable(url) {
    if (!/^(https?|file):\/\//i.test(url) || /[\s\p{Cc}]/u.test(url)) return false;
    const protocol = parseUrl(url)?.protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "file:";
  }
  function samePage(a, b) {
    const first = parseUrl(a);
    const second = parseUrl(b);
    if (!first || !second) return false;
    first.hash = "";
    second.hash = "";
    return first.href === second.href;
  }

  // shared/types.ts
  var PROTOCOL = 2;
  var BRIDGE_HOST = "127.0.0.1";
  var BRIDGE_PORT = 47823;
  var BRIDGE_PATH = "/bridge";

  // extension/src/bridge-client.ts
  var OLD_EXTENSION = "This extension is older than the bridge. Load the newest zip from the release page and reload the extension. Copy still works, without screenshots.";
  var OLD_BRIDGE = "The bridge is older than this extension. Ask your agent to stop Clicknote and to open the page again. Copy still works, without screenshots.";
  var UNREADABLE = "The bridge gave an answer that could not be read.";
  var REFUSED = "The bridge refused this extension.";
  var NO_ANSWER = "The bridge did not answer within 25 seconds.";
  var TIMEOUT_MS = 25e3;
  var ERROR_KINDS = { bridge_down: true, version_mismatch: true, agent_gone: true, failed: true };
  var SEND_STATUSES = { picked_up: true, queued: true, agent_gone: true, unknown: true };
  function bridgePort() {
    return false ? BRIDGE_PORT_E2E : BRIDGE_PORT;
  }
  async function sendToBridge(request) {
    const port = bridgePort();
    const envelope = { protocol: PROTOCOL, version: chrome.runtime.getManifest().version, body: request };
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`http://${BRIDGE_HOST}:${port}${BRIDGE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal
      });
    } catch (error) {
      return fetchFailed(error);
    }
    try {
      return readEnvelope(request.type, response.status, await payloadOf(response));
    } catch (error) {
      return unanswered(timedOut(error) ? NO_ANSWER : error);
    }
  }
  function failed(problem) {
    return { ok: false, kind: "failed", message: messageOf(problem) };
  }
  function unanswered(problem) {
    return { ...failed(problem), own: "none" };
  }
  function fetchFailed(error) {
    return timedOut(error) ? unanswered(NO_ANSWER) : bridgeDown(error);
  }
  function bridgeDown(problem) {
    return { ok: false, kind: "bridge_down", message: messageOf(problem), own: "none" };
  }
  function versionMismatch(bridgeProtocol) {
    return {
      ok: false,
      kind: "version_mismatch",
      message: bridgeProtocol > PROTOCOL ? OLD_EXTENSION : OLD_BRIDGE,
      own: "refused"
    };
  }
  function readEnvelope(type, status, payload) {
    if (status === 403) return refused(REFUSED);
    if (status !== 200) return refused(`The bridge answered with status ${status}.`);
    if (!isRecord(payload) || typeof payload.protocol !== "number") return unanswered(UNREADABLE);
    if (payload.protocol !== PROTOCOL) return versionMismatch(payload.protocol);
    if (typeof payload.version !== "string" || !Object.hasOwn(payload, "body")) return unanswered(UNREADABLE);
    return readReply(type, payload.body);
  }
  function readReply(type, reply) {
    if (!isRecord(reply)) return unanswered(UNREADABLE);
    if (reply.ok === false) {
      const { kind, message } = reply;
      return isErrorKind(kind) && typeof message === "string" ? { ok: false, kind, message } : unanswered(UNREADABLE);
    }
    if (reply.ok !== true) return unanswered(UNREADABLE);
    if (type === "agents") {
      const { agents, preselect } = reply;
      const valid = Array.isArray(agents) && agents.every(isAgentInfo) && (preselect === null || typeof preselect === "string");
      return valid ? { ok: true, agents, preselect } : unanswered(UNREADABLE);
    }
    if (type === "opened") {
      const { url, agent: agent2 } = reply;
      return typeof url === "string" && typeof agent2 === "string" ? { ok: true, url, agent: agent2 } : unanswered(UNREADABLE);
    }
    if (type === "state") {
      const { state, line: line2 } = reply;
      return isSendStatus(state) && (typeof line2 === "string" || line2 === null) ? { ok: true, state, line: line2 } : unanswered(UNREADABLE);
    }
    const { folder, line, agent } = reply;
    if (typeof folder !== "string" || typeof line !== "string") return unanswered(UNREADABLE);
    if (agent === void 0) return { ok: true, folder, line };
    return typeof agent === "string" ? { ok: true, folder, line, agent } : unanswered(UNREADABLE);
  }
  function refused(problem) {
    return { ...failed(problem), own: "refused" };
  }
  async function payloadOf(response) {
    if (response.status !== 200) return void 0;
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function timedOut(error) {
    return error?.name === "TimeoutError";
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }
  function isErrorKind(value) {
    return typeof value === "string" && Object.hasOwn(ERROR_KINDS, value);
  }
  function isSendStatus(value) {
    return typeof value === "string" && Object.hasOwn(SEND_STATUSES, value);
  }
  function isAgentInfo(value) {
    if (!isRecord(value)) return false;
    const { id, folder, about, harness, number, waiting } = value;
    return [id, folder, about, harness].every((field) => typeof field === "string") && (number === null || Number.isSafeInteger(number)) && typeof waiting === "boolean";
  }
  function messageOf(problem) {
    if (typeof problem === "string") return problem;
    if (problem instanceof Error) return problem.message;
    const message = problem?.message;
    return typeof message === "string" ? message : String(problem);
  }

  // extension/src/crop.ts
  var CHUNK = 32768;
  function cropRect(rect, viewport, scale, margin = 8) {
    const visible = Math.min(viewport.width, rect.x + rect.width) > Math.max(0, rect.x) && Math.min(viewport.height, rect.y + rect.height) > Math.max(0, rect.y);
    if (!visible) return null;
    const sx = Math.round(Math.max(0, rect.x - margin) * scale);
    const sy = Math.round(Math.max(0, rect.y - margin) * scale);
    const sw = Math.round(Math.min(viewport.width, rect.x + rect.width + margin) * scale) - sx;
    const sh = Math.round(Math.min(viewport.height, rect.y + rect.height + margin) * scale) - sy;
    if (!(sw >= 1 && sh >= 1)) return null;
    return { sx, sy, sw, sh };
  }
  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let start = 0; start < bytes.length; start += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
    }
    return btoa(binary);
  }

  // extension/src/drafts.ts
  var DATABASE = "clicknote";
  var CROPS = "crops";
  var draftKey = (tabId) => `draft:${tabId}`;
  var sendKey = (tabId) => `send:${tabId}`;
  function draftFor(draft, url) {
    return draft && samePage(draft.url, url) ? draft : null;
  }
  function whatWasSent(draft) {
    return { note: draft.note, annotations: draft.annotations.map(({ id, comment, intent }) => ({ id, comment, intent })) };
  }
  function isWhatWasSent(draft, sent) {
    if (draft.note !== sent.note || draft.annotations.length !== sent.annotations.length) return false;
    const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    const held = whatWasSent(draft).annotations.sort(byId);
    return [...sent.annotations].sort(byId).every(({ id, comment, intent }, index) => id === held[index].id && comment === held[index].comment && intent === held[index].intent);
  }
  function newSendId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function readRecord(tabId) {
    const key = sendKey(tabId);
    const stored = (await chrome.storage.session.get(key))[key];
    return isSendRecord(stored) ? stored : null;
  }
  async function saveRecord(tabId, record) {
    await chrome.storage.session.set({ [sendKey(tabId)]: record });
  }
  async function updateRecord(tabId, record) {
    if ((await readRecord(tabId))?.id !== record.id) return;
    await saveRecord(tabId, record);
  }
  async function forgetRecord(tabId, id) {
    if ((await readRecord(tabId))?.id !== id) return;
    await chrome.storage.session.remove(sendKey(tabId));
  }
  async function readDraft(tabId) {
    const key = draftKey(tabId);
    const stored = (await chrome.storage.session.get(key))[key];
    return isDraft(stored) ? stored : null;
  }
  async function loadDraft(tabId, url) {
    return draftFor(await readDraft(tabId), url);
  }
  async function saveDraft(tabId, draft) {
    await chrome.storage.session.set({ [draftKey(tabId)]: draft });
  }
  async function deleteDraft(tabId) {
    const draft = await readDraft(tabId);
    await chrome.storage.session.remove(sendKey(tabId));
    await removeDraft(tabId, draft);
  }
  async function deleteSentDraft(tabId, sent) {
    const draft = await readDraft(tabId);
    if (!draft || draft.annotations.length === 0) return false;
    if (!isWhatWasSent(draft, sent)) return true;
    await removeDraft(tabId, draft);
    return false;
  }
  async function putCrop(id, png) {
    await inCrops("readwrite", (store) => store.put(png, id));
  }
  async function getCrop(id) {
    const stored = await inCrops("readonly", (store) => store.get(id));
    return stored instanceof Blob ? stored : null;
  }
  async function deleteCrops(ids) {
    if (ids.length === 0) return;
    await inCrops("readwrite", (store) => {
      for (const id of ids) store.delete(id);
      return void 0;
    });
  }
  async function clearCrops() {
    await inCrops("readwrite", (store) => store.clear());
  }
  async function removeDraft(tabId, draft) {
    await chrome.storage.session.remove(draftKey(tabId));
    if (draft) await deleteCrops(draft.annotations.map((annotation) => annotation.id));
  }
  function isDraft(value) {
    if (typeof value !== "object" || value === null) return false;
    const { url, note, annotations } = value;
    return typeof url === "string" && typeof note === "string" && Array.isArray(annotations);
  }
  function isSendRecord(value) {
    if (typeof value !== "object" || value === null) return false;
    const { id, startedAt, agent, sent, line, kept, status } = value;
    return typeof id === "string" && typeof startedAt === "number" && typeof agent === "object" && agent !== null && typeof sent === "object" && sent !== null && typeof sent.note === "string" && Array.isArray(sent.annotations) && (line === null || typeof line === "string") && typeof kept === "boolean" && (status === null || isSendStatus(status));
  }
  async function inCrops(mode, work) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(CROPS, mode);
        const request = work(transaction.objectStore(CROPS));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("The crops transaction was aborted."));
      });
    } finally {
      database.close();
    }
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(CROPS);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // extension/src/follow.ts
  var ARRIVE_MS = 1e4;
  function noAnswer(error) {
    return error.kind === "bridge_down" || "own" in error && error.own === "none";
  }
  function settled(state) {
    return state === "picked_up" || state === "unknown" || state === "agent_gone";
  }
  function stillArriving(startedAt, now) {
    return now >= startedAt && now - startedAt <= ARRIVE_MS;
  }

  // extension/src/tab-agent.ts
  var agentKey = (tabId) => `agent:${tabId}`;
  async function readTabAgent(tabId) {
    const key = agentKey(tabId);
    const stored = (await chrome.storage.session.get(key))[key];
    return typeof stored === "string" ? stored : null;
  }
  async function saveTabAgent(tabId, id) {
    await chrome.storage.session.set({ [agentKey(tabId)]: id });
  }
  async function forgetTabAgent(tabId) {
    await chrome.storage.session.remove(agentKey(tabId));
  }
  function chooseAgent(tabAgent, listed, fromBridge) {
    if (tabAgent !== null && listed.includes(tabAgent)) return { preselect: tabAgent, forget: false };
    return { preselect: fromBridge, forget: tabAgent !== null };
  }
  function isOpenAddress(url, code, port) {
    const parsed = parseUrl(url ?? "");
    return parsed?.origin === `http://${BRIDGE_HOST}:${port}` && parsed.pathname === `/open/${code}`;
  }

  // extension/src/background.ts
  var CANNOT_ANNOTATE = 'Cannot annotate this page. For file:// pages, switch on "Allow access to file URLs" for this extension.';
  var NO_RECEIVER = "Receiving end does not exist";
  var CAPTURE_QUOTA = "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND";
  var NOTHING_TO_SEND = "There are no annotations to send.";
  var NO_RECORD = "The extension could not keep a record of this send, so it was not started.";
  var NOT_FOLLOWED = { followed: false };
  chrome.action.onClicked.addListener((tab) => {
    if (tab.id !== void 0) activate(tab.id).catch(warn("Turning on failed"));
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const answered = answer(message, sender).then(sendResponse, (error) => sendResponse(failed(error)));
    if (false) void answered.then(() => noteAnswered(message.type));
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    deleteDraft(tabId).catch(warn("Removing the draft of a closed tab failed"));
    forgetTabAgent(tabId).catch(warn("Forgetting the agent of a closed tab failed"));
  });
  chrome.runtime.onStartup.addListener(startAfresh);
  chrome.runtime.onInstalled.addListener(startAfresh);
  if (false) installTestHooks();
  function startAfresh() {
    clearCrops().catch(warn("Clearing the crops failed"));
  }
  async function activate(tabId) {
    if (await toggle(tabId)) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch {
      await chrome.action.setBadgeText({ tabId, text: "!" });
      await chrome.action.setTitle({ tabId, title: CANNOT_ANNOTATE });
    }
  }
  async function toggle(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "toggle" }, { frameId: 0 });
      return true;
    } catch (error) {
      return !String(error).includes(NO_RECEIVER);
    }
  }
  async function answer(message, sender) {
    const tab = sender.tab;
    if (tab?.id === void 0) return failed("This message has to come from a tab.");
    const tabId = tab.id;
    switch (message.type) {
      case "draft:load":
        return { draft: await loadDraft(tabId, message.url) };
      case "draft:save":
        await saveDraft(tabId, message.draft);
        return { ok: true };
      case "capture":
        return { ok: await capture(tab, message.id, message.rect, message.viewport) };
      case "crop:get":
        return { dataUrl: await cropDataUrl(message.id) };
      case "crop:delete":
        await deleteCrops([message.id]);
        return { ok: true };
      case "agents":
        return agentsFor(tabId, message.url);
      case "send":
        return sendDraft(tabId, message.agent, message.page);
      case "send:state":
        return stateOfSend(tabId, message.id);
      case "send:load":
        return { record: await readRecord(tabId) };
      case "copy":
        return copyDraft(tabId, message.page);
      case "opened":
        return opened(tabId, sender, message.code);
      default:
        return failed("The service worker does not know this message.");
    }
  }
  async function capture(tab, id, rect, viewport) {
    if (!tab.active) return false;
    try {
      const screenshot = await (await fetch(await captureVisibleTab(tab.windowId))).blob();
      const bitmap = await createImageBitmap(screenshot);
      try {
        const area = cropRect(rect, viewport, bitmap.width / viewport.width);
        if (!area) return false;
        const canvas = new OffscreenCanvas(area.sw, area.sh);
        const context = canvas.getContext("2d");
        if (!context) return false;
        context.drawImage(bitmap, area.sx, area.sy, area.sw, area.sh, 0, 0, area.sw, area.sh);
        await putCrop(id, await canvas.convertToBlob({ type: "image/png" }));
        return true;
      } finally {
        bitmap.close();
      }
    } catch (error) {
      warn("The capture failed")(error);
      return false;
    }
  }
  async function captureVisibleTab(windowId) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (error) {
      if (!String(error).includes(CAPTURE_QUOTA)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1e3));
      return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    }
  }
  async function cropDataUrl(id) {
    const png = await getCrop(id);
    return png ? `data:image/png;base64,${await blobToBase64(png)}` : null;
  }
  async function agentsFor(tabId, url) {
    const reply = await callBridge({ type: "agents", url });
    if (!reply.ok || !("agents" in reply)) return reply;
    const tabAgent = await readTabAgent(tabId).catch((error) => {
      warn("Reading the agent of the tab failed")(error);
      return null;
    });
    const { preselect, forget } = chooseAgent(tabAgent, reply.agents.map((agent) => agent.id), reply.preselect);
    if (forget) await forgetTabAgent(tabId).catch(warn("Forgetting the agent of the tab failed"));
    return { ...reply, preselect };
  }
  async function opened(tabId, sender, code) {
    if (sender.frameId !== 0 || !isOpenAddress(sender.url, code, bridgePort())) return { ok: false };
    const reply = await callBridge({ type: "opened", code });
    if (!reply.ok || !("url" in reply) || !isLinkable(reply.url)) return { ok: false };
    await saveTabAgent(tabId, reply.agent).catch(warn("Keeping the agent of the tab failed"));
    if (parseUrl(reply.url)?.protocol === "file:" && await chrome.extension.isAllowedFileSchemeAccess() && await stillOpen(tabId, code)) {
      await chrome.tabs.update(tabId, { url: reply.url }).catch(warn("Opening the local file failed"));
    }
    return { ok: true };
  }
  async function stillOpen(tabId, code) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return isOpenAddress(tab?.url, code, bridgePort());
  }
  async function sendDraft(tabId, agent, page) {
    const loaded = await payloadOf2(tabId, page);
    if (!loaded) return failed(NOTHING_TO_SEND);
    const record = {
      id: newSendId(),
      startedAt: Date.now(),
      agent,
      sent: whatWasSent(loaded.draft),
      line: null,
      kept: false,
      status: null
    };
    try {
      await saveRecord(tabId, record);
    } catch (error) {
      warn("Keeping the record of the send failed")(error);
      return failed(NO_RECORD);
    }
    const reply = await callBridge({ type: "send", id: record.id, agent: agent.id, send: loaded.send });
    if (!reply.ok) {
      if (!noAnswer(reply)) await forgetRecord(tabId, record.id).catch(warn("Forgetting the record of the send failed"));
      return reply;
    }
    const { line } = reply;
    const noted = await noteState(tabId, record.id, "queued", line).catch((error) => {
      warn("Noting the state of the send failed")(error);
      return null;
    });
    return noted ?? { ok: true, state: "queued", line, kept: false };
  }
  async function stateOfSend(tabId, id) {
    const record = await readRecord(tabId);
    if (record?.id !== id) return NOT_FOLLOWED;
    const reply = await callBridge({ type: "state", id, agent: record.agent.id });
    if (!reply.ok) return reply;
    const { state, line } = reply;
    return await noteState(tabId, id, state, line) ?? NOT_FOLLOWED;
  }
  async function noteState(tabId, id, state, line) {
    const record = await readRecord(tabId);
    if (record?.id !== id) return null;
    if (record.line === null && state === "unknown") {
      if (stillArriving(record.startedAt, Date.now())) return { ok: true, state: "sending", line: null, kept: false };
      await forgetRecord(tabId, id).catch(warn("Forgetting the record of the send failed"));
      return { ok: true, state, line: null, kept: false };
    }
    const kept = record.line === null ? await arrive(tabId, record) : record.kept;
    const known = line ?? record.line;
    if (settled(state)) await forgetRecord(tabId, id).catch(warn("Forgetting the record of the send failed"));
    else await updateRecord(tabId, { ...record, line: known, kept, status: state }).catch(warn("Noting the state of the send failed"));
    return { ok: true, state, line: known, kept };
  }
  async function arrive(tabId, record) {
    await saveTabAgent(tabId, record.agent.id).catch(warn("Keeping the agent of the tab failed"));
    return deleteSentDraft(tabId, record.sent).catch((error) => {
      warn("Removing the sent draft failed")(error);
      return false;
    });
  }
  async function copyDraft(tabId, page) {
    const loaded = await payloadOf2(tabId, page);
    if (!loaded) return failed(NOTHING_TO_SEND);
    const reply = await callBridge({ type: "copy", send: loaded.send });
    if (reply.ok) {
      await deleteSentDraft(tabId, whatWasSent(loaded.draft)).catch(warn("Removing the copied draft failed"));
    }
    return reply;
  }
  async function payloadOf2(tabId, page) {
    const draft = await loadDraft(tabId, page.url);
    if (!draft || draft.annotations.length === 0) return null;
    return { draft, send: { page, note: draft.note, annotations: draft.annotations, images: await imagesOf(draft) } };
  }
  async function imagesOf(draft) {
    const images = {};
    for (const { id } of draft.annotations) {
      const png = await getCrop(id);
      if (png) images[id] = await blobToBase64(png);
    }
    return images;
  }
  async function callBridge(request) {
    if (false) return callTestBridge(request);
    return sendToBridge(request);
  }
  function warn(what) {
    return (error) => console.warn(`${what}:`, error);
  }
})();
