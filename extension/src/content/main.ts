import { renderMarkdown } from '../../../shared/markdown.ts';
import type { AgentInfo, AgentsOk, Annotation, BridgeError, Intent, PageInfo, Rect, SentOk } from '../../../shared/types.ts';
import { sourceFile } from '../../../shared/url.ts';
import type { Draft, Followed, NotFollowed, Sent, SendRecord, SendReply, ToBackground, ToContent } from '../messages.ts';
import { failed, unanswered } from '../bridge-client.ts';
import { follow as followSend, FOLLOW_FIRST_MS, SENDING, sendFailed, sendOff, settled, shows, WAIT_OFFER } from '../follow.ts';
import type { SendOff, Shown } from '../follow.ts';
import { createBar } from './bar.ts';
import type { Offer, Tone } from './bar.ts';
import { findBySelector, snapshot } from './describe.ts';
import { createMarkers } from './markers.ts';
import type { Placed } from './markers.ts';
import { startPicking } from './picker.ts';
import { createPopup } from './popup.ts';
import type { PopupRequest } from './popup.ts';
import { createStore, toBackground } from './store.ts';
import { createUi, h, HOST_TAG, trusted } from './ui.ts';

// The content script. The service worker injects it when the user turns the extension on in
// a tab, and from then on sends `toggle` to hide or show the UI. It shows the UI at once,
// in pick mode, with the annotations left on this page before a reload.

interface Instance { dispose(): void }

// What an annotation records of its element.
type Described = ReturnType<typeof snapshot>;

// The send the bar follows: the tab's record, as the page knows it.
interface Following {
  id: string;
  agent: AgentInfo;
  sent: Sent;                   // what it carried
  count: number;                // how many annotations it carried
  startedAt: number;            // when it started, which following counts from
  arrived: boolean;             // the page has had word that the bridge has it
  stop: AbortController;        // ends the following, as when a new send takes its place
  asking: boolean;              // a round of asks runs (pursue)
  shown: string | null;         // what the bar last showed for it (statusKey); null before anything
}

const COPYING = 'Copying…';
const COPIED = 'Copied. Paste the line into your agent.';
const COPIED_MARKDOWN = 'Copied as Markdown, without screenshots.';
const CLIPBOARD_FAILED = 'The clipboard could not be written.';
const NO_AGENTS = 'No agent is listening. Say this to your coding agent, then choose it here. Copy still works.';

// The shortest time, in milliseconds, between two listings of the agents on a return to the page
// or a use of the bar.
const LOOK_AGAIN_PAUSE = 2000;

// The shortest time, in milliseconds, between two requests for the state of a send, once its
// round of asks has ended and a return to the page or a use of the bar asks again.
const ASK_AGAIN_PAUSE = 2000;

// What `follow` is given for a send that the tab no longer follows. The following has ended by
// then, so this is never shown.
const UNFOLLOWED = unanswered('This tab no longer follows this send.');

// A second injection into the same page replaces the first: a double click on the toolbar
// button can inject twice, and a script left behind by a reloaded extension still has its
// listeners and its host on the page.
const scope = globalThis as typeof globalThis & { __clicknoteContent?: Instance };
scope.__clicknoteContent?.dispose();
document.querySelector(HOST_TAG)?.remove();
scope.__clicknoteContent = start();

function start(): Instance {
  const listening = new AbortController();
  const { signal } = listening;
  const ui = createUi();
  const store = createStore();
  // In this order, so the popup lies above the bar and the bar above the markers.
  const markers = createMarkers(ui, openAnnotation);
  const bar = createBar(ui, {
    onTogglePick: () => setPicking(!stopPicking),
    onOpen: openAnnotation,
    onHover: annotation => ui.highlight(annotation ? elementOf(annotation) : popupElement),
    cropOf: id => toBackground<{ dataUrl?: string | null }>({ type: 'crop:get', id })
      .then(reply => reply?.dataUrl ?? null, () => null),
    onNote: note => store.setNote(note),
    onAgentsWanted: () => {
      lookedAgain = performance.now();
      listAgents().catch(warn('Listing the agents failed'));
    },
    onSend: agent => void send(agent).catch(warn('Sending failed')),
    onCopy: () => void copy().catch(warn('Copying failed')),
    onCopyOffer: text => writeClipboard(ui.root, text),
    onUse: () => {
      askAgain();
      listOnLook();
    },
  });
  const popup = createPopup(ui);

  let stopPicking: (() => void) | null = null;
  let popupElement: Element | null = null;    // the element the open popup is about
  let shown: (Element | null)[] = [];         // the elements the markers and the list show
  let editing: string | null = null;          // the annotation the open popup edits
  let listing = 0;                            // counts the requests for the agents
  let delivered = 0;                          // counts the sends and copies that have ended
  let listAfterDelivery = false;              // a listing was answered while one ran
  let whyOff: SendOff | null = null;          // why Send is off, while the status line says it
  let shownKey = '';                          // what the status line shows, as statusKey gives it
  let said = 0;                               // counts what the status line was given to show
  let lookedAgain = -Infinity;                // when a return, a use of the bar or the dropdown last listed the agents
  let following: Following | null = null;    // the send the bar follows
  let askedAt = -Infinity;                    // when the state of a send was last asked for
  let goneMessage: string | null = null;      // the message that a send's agent is gone (statusKey): listings leave it shown
  let frozen = false;                         // the request of a send or a copy runs: the list cannot change
  let pickAfter = false;                      // whether pick mode comes back once it is over
  let capturing = false;                      // the crop of a pick is being taken
  let cancelled = false;                      // Esc was pressed while it was taken
  let unadded: string | null = null;          // the crop of the pick the popup is open for, until Add

  // The element of each annotation: the one picked, while it is on the page, else whatever
  // its selector finds now, which covers a reload and a page that re-renders.
  const elements = new Map<string, Element>();
  function elementOf(annotation: Annotation): Element | null {
    const known = elements.get(annotation.id);
    if (known?.isConnected) return known;
    const found = findBySelector(annotation.selector);
    if (found) elements.set(annotation.id, found);
    else elements.delete(annotation.id);
    return found;
  }

  function render(): void {
    const placed: Placed[] = store.annotations().map(annotation => ({ annotation, element: elementOf(annotation) }));
    shown = placed.map(({ element }) => element);
    markers.render(placed);
    bar.render(placed, store.note());
  }

  // After a scroll, a resize or a change to the page: everything follows its element, and
  // the markers and the list are redrawn when an element has gone, come back or been replaced.
  // The bar moves back inside a window that has shrunk, also while the UI was hidden.
  function follow(): void {
    const now = store.annotations().map(elementOf);
    if (now.length !== shown.length || now.some((element, index) => element !== shown[index])) render();
    else markers.follow();
    ui.followHighlight();
    popup.follow();
    bar.keepInView();
  }

  let followQueued = false;
  function queueFollow(): void {
    if (followQueued) return;
    followQueued = true;
    requestAnimationFrame(() => {
      followQueued = false;
      if (ui.visible()) follow();
    });
  }

  function setPicking(on: boolean): void {
    if (frozen) {
      pickAfter = on;           // the last state asked for, once the list may change again
      return;
    }
    if (on && !stopPicking) {
      stopPicking = startPicking(ui, element => void pick(element).catch(warn('Picking failed')),
        () => popup.isOpen() || capturing);
    }
    if (!on && stopPicking) {
      stopPicking();
      stopPicking = null;
      ui.highlight(popupElement);   // an open popup keeps its element outlined
    }
    bar.setPicking(on);
  }

  function setVisible(on: boolean): void {
    if (on) {
      ui.show();
      setPicking(true);
      follow();
      listAgents().catch(warn('Listing the agents failed'));
    } else {
      popup.close();
      setPicking(false);
      ui.hide();
    }
  }

  function openPopup(element: Element | null, request: PopupRequest): void {
    popup.open(request);
    popupElement = element;
    ui.highlight(element);
  }

  function popupClosed(): void {
    popupElement = null;
    editing = null;
    ui.highlight(null);
  }

  // A pick describes the element and takes its crop at once, before the popup takes the
  // focus, so both show the element as the user clicked it: a page menu that closes when
  // focus leaves it may be gone by the time of Add. The crop is stored under the id the
  // annotation will get, and deleted when the pick is not added. A pick whose element cannot
  // be described is dropped before the crop, so the next pick works.
  async function pick(element: Element): Promise<void> {
    if (capturing) return;
    const described = snapshot(element, element.getBoundingClientRect());
    capturing = true;
    cancelled = false;
    const id = newId();
    try {
      await capture(id, described.rect);
    } finally {
      capturing = false;
    }
    // Cancelled with Esc, turned off, or replaced by a second injection while the crop was taken.
    if (cancelled || signal.aborted || !ui.visible()) {
      dropCrop(id);
      return;
    }
    openPopup(element, {
      label: described.label,
      anchor: () => element,
      editing: false,
      onSubmit: (comment, intent) => {
        unadded = null;
        add(id, element, described, comment, intent);
      },
      onClose: () => {
        if (unadded === id) {
          unadded = null;
          dropCrop(id);
        }
        popupClosed();
      },
    });
    unadded = id;           // after open, which closes a popup that was open with its own crop
  }

  function openAnnotation(annotation: Annotation): void {
    if (frozen) return;
    openPopup(elementOf(annotation), {
      label: annotation.label,
      anchor: () => elementOf(annotation),
      comment: annotation.comment,
      intent: annotation.intent,
      editing: true,
      onSubmit: (comment, intent) => store.update(annotation.id, { comment, intent }),
      onDelete: () => store.remove(annotation.id),
      onClose: popupClosed,
    });
    editing = annotation.id;
  }

  // Crops the visible part of `rect` from a screenshot of the page without the UI on top, and
  // stores it under `id`. A failed capture leaves the annotation without a crop.
  async function capture(id: string, rect: Rect): Promise<void> {
    await ui.hiddenDuring(() => toBackground({
      type: 'capture',
      id,
      rect,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }).catch(warn('The capture failed')));
  }

  // The annotation, with the description and the crop taken at the pick.
  function add(id: string, element: Element, described: Described, comment: string, intent: Intent): void {
    elements.set(id, element);
    store.add({ id, intent, comment, ...described });
  }

  // The status line. A problem found while listing the agents or sending says why Send is
  // off, and a later listing that finds agents removes it. The progress and the other outcomes
  // of a send or a copy stay: no listing that ran into one changes the line, nor does the
  // listing after it.
  function setStatus(text: string, tone: Tone, offer?: Offer): void {
    say(text, tone, offer);
    whyOff = null;
  }

  function explainSendOff(off: SendOff): void {
    say(off.text, 'problem', off.offer);
    whyOff = off;
  }

  function say(text: string, tone: Tone, offer?: Offer): void {
    bar.setStatus(text, tone, offer);
    shownKey = statusKey(text, tone, offer);
    said += 1;
  }

  // The agents for the dropdown. The bridge lists them again inside a send, so a list that
  // is a little old never sends to an agent that has gone. Only the latest answer counts.
  // An answer to a listing that a send or copy ran into, which can end just after it, is
  // not used: the dropdown and Send stay as they are, and the agents are listed again once
  // the send or copy has ended. `explain` is false for that listing.
  // A listing that fails or finds no agent turns Send off, and the agents are listed again when
  // the user comes back to the page or uses the bar (listOnLook). While the bar follows a send, the
  // status line is that send's: a listing then turns Send off or on and leaves the line as it is.
  // So it does while the line says that a send's agent is gone (goneMessage), with the send's line
  // on offer, until something else is shown there, as by a send or a copy.
  async function listAgents(explain = true): Promise<void> {
    const asked = ++listing;
    const deliveredBefore = delivered;
    const reply = await askBridge<AgentsOk>({ type: 'agents', url: location.href });
    if (asked !== listing) return;
    if (frozen || delivered !== deliveredBefore) {
      listAfterDelivery = true;
      if (!frozen) listAgainAfterDelivery();
      return;
    }
    if (reply.ok) bar.setAgents(reply.agents, reply.preselect);
    else bar.setAgents([], null);
    if (!explain || following || shownKey === goneMessage) return;
    if (!reply.ok) explainSendOff(sendOff(reply) ?? { text: `Listing the agents failed: ${reply.message}` });
    else if (reply.agents.length === 0) explainSendOff({ text: NO_AGENTS, offer: WAIT_OFFER });
    else if (whyOff) setStatus('', 'quiet');
  }

  // The user comes back to the page or uses the bar: the agents are listed again, so the dot of
  // each agent is as fresh as the user's look, and Send comes on without a click once an agent is
  // listed. Not while a send or copy runs. A page can make the events of a return itself, by moving
  // the focus into a frame and back, so this lists at most once in LOOK_AGAIN_PAUSE; the dropdown,
  // which lists the agents each time it gets the focus, counts as such a listing too.
  function listOnLook(): void {
    if (frozen) return;
    if (performance.now() - lookedAgain < LOOK_AGAIN_PAUSE) return;
    lookedAgain = performance.now();
    listAgents().catch(warn('Listing the agents failed'));
  }

  function listAgainAfterDelivery(): void {
    if (!listAfterDelivery) return;
    listAfterDelivery = false;
    listAgents(false).catch(warn('Listing the agents failed'));
  }

  // While the request of a send or a copy runs, the list cannot change, so a clear after it
  // never takes anything that was not sent: pick mode waits, no annotation opens, and an open
  // popup cannot add, save or delete, though what is typed in it stays. Afterwards pick mode is
  // as before, and a popup about an annotation that was sent closes. A send that is queued does
  // not freeze the list.
  function setFrozen(on: boolean): void {
    if (on) {
      const picking = stopPicking !== null;
      setPicking(false);
      frozen = true;
      pickAfter = picking;
    } else {
      frozen = false;
      setPicking(pickAfter);
      if (editing && !store.annotations().some(annotation => annotation.id === editing)) popup.close();
    }
    popup.setLocked(on);
    bar.setBusy(on);
  }

  // Send and Copy are off while the request of one of them runs, and the list is frozen. Gives
  // what `work` gives. An error inside ends it with `<failure>: <message>` instead of leaving the
  // progress on screen, and gives undefined.
  async function delivering<T>(progress: string, failure: string, work: () => Promise<T>): Promise<T | undefined> {
    setFrozen(true);
    setStatus(progress, 'quiet');
    try {
      return await work();
    } catch (error) {
      setStatus(`${failure}: ${failed(error).message}`, 'problem');
      warn(failure)(error);
      return undefined;
    } finally {
      setFrozen(false);
      delivered += 1;
      listAgainAfterDelivery();
    }
  }

  // Sends the annotations to the agent. It takes the place of the send the bar followed. The list
  // is frozen while the request runs, with the progress on the status line. The service worker
  // answers once the bridge has the send: the list then loses what was sent (arrive), or takes over
  // the tab's draft when that has changed since (kept), and the bar follows the send from its
  // record. The progress stays on the status line until the first answer about the send's state,
  // which is asked for FOLLOW_FIRST_MS after the send was stored: an agent that waits has picked
  // the send up by then, and the bar does not say first that it is queued. When no answer about it
  // comes, as when that ask fails, the bar shows what the send's own answer said, unless the status
  // line has been given something else since. After a failure the list stays as it is, and the bar
  // says why (showSendFailed). A failure without an answer of the bridge's own leaves the record,
  // so the bar asks for the state when the user comes back or uses the bar. The record is loaded
  // while the list is still frozen, so no second Send can come in between.
  async function send(agent: AgentInfo): Promise<void> {
    stopFollowing();
    const count = store.annotations().length;
    const sent: Sent = {
      note: store.note(),
      annotations: store.annotations().map(({ id, comment, intent }) => ({ id, comment, intent })),
    };
    const done = await delivering(SENDING, 'Sending failed', async () => {
      await store.save();     // under the URL the page has now, which the service worker checks
      const reply = await askBridge<SendReply>({ type: 'send', agent, page: pageInfo() });
      if (reply.ok) await arrive(reply.kept, sent);
      return { reply, record: await loadRecord() };
    });
    if (!done) return;
    const { reply, record } = done;
    if (!reply.ok) {
      showSendFailed(reply);
      // A state that comes later is shown only when it differs from this.
      if (record) startFollowing(record).shown = shownKey;
      return;
    }
    const progress = said;
    const f = record ? startFollowing(record) : null;
    if (f) {
      // The list has had the answer to the send already, even when the record has no line.
      f.arrived = true;
      await pursue(f, { delay: FOLLOW_FIRST_MS });
    }
    // Nothing has been shown since the progress: no answer about the send came.
    if (said !== progress) return;
    const shown = shows(reply, agent, count, true);
    if (f) showFor(f, shown);
    else showState(shown);
  }

  // Goes on following the send in the tab's record, as after a reload, on whatever page the tab
  // shows now. A send that the bridge has shows its state at once. One without a state may still
  // be in its request, as when the page was reloaded before the bridge answered: the bar shows the
  // progress, with the list frozen and the record's agent in the dropdown, until the first answer
  // that is not `sending`, which then counts as the answer to the send. While the send may still be
  // arriving (`sending`), it is asked about again every FOLLOW_EVERY_MS (followSend, with no time
  // left but for that). The listing that the page started with is answered while the list is
  // frozen, and such an answer is not shown; the agents are listed again afterwards, also when that
  // listing was answered before the list froze.
  async function goOn(record: SendRecord): Promise<void> {
    const f = startFollowing(record);
    if (record.status !== null) {
      showAnswer(f, { ok: true, state: record.status, line: record.line, kept: record.kept });
      await pursue(f);
      return;
    }
    bar.setAgents([record.agent], record.agent.id);
    listAfterDelivery = true;
    const first = await delivering(SENDING, 'Sending failed', async () => {
      const reply = await followSend({
        ask: () => stateOf(f),
        show: () => {},
        sleep: ms => pause(ms, f.stop.signal),
        now: Date.now,
        from: -Infinity,
        signal: f.stop.signal,
      }) ?? UNFOLLOWED;
      if (reply.ok && saysArrived(reply) && !f.arrived) {
        f.arrived = true;
        await arrive(reply.kept, f.sent);
      }
      return reply;
    });
    if (!first) return;
    // The tab no longer has this send, so no answer about it will come.
    if (f.stop.signal.aborted) {
      setStatus('', 'quiet');
    } else if (!first.ok) {
      showSendFailed(first);
      f.shown = shownKey;
    } else {
      await pursue(f, { first });
    }
  }

  // The list once the bridge has the send that carried `sent`: without what it carried, or the
  // tab's draft as the service worker has it when that has changed since the send (kept). An
  // annotation that the send did not carry stays, and so does a general comment that no longer
  // reads as sent.
  async function arrive(kept: boolean, sent: Sent): Promise<void> {
    if (kept) await takeOverDraft();
    else store.removeSent(sent);
  }

  // What the bar shows when the request for a send failed (sendFailed). When Send cannot work, it
  // goes off as after a listing that fails, and coming back to the page lists the agents again.
  // After an agent that is gone, the agents are listed again.
  function showSendFailed(error: BridgeError): void {
    const { text, tone, offer } = sendFailed(error);
    if (sendOff(error)) {
      bar.setAgents([], null);
      explainSendOff(offer ? { text, offer } : { text });
    } else {
      setStatus(text, tone, offer);
    }
    if (error.kind === 'agent_gone') listAgents().catch(warn('Listing the agents failed'));
  }

  // Shows how a send stands, unless the status line shows that already: the line does not flicker
  // at each answer, and its button keeps saying Copied while nothing changes.
  function showState({ text, tone, offer }: Shown): void {
    if (statusKey(text, tone, offer) !== shownKey) setStatus(text, tone, offer);
  }

  // Shows how the followed send `f` stands, unless the bar showed that last for it: what the status
  // line has been given since, such as the message of a copy, stays until the send's state changes.
  function showFor(f: Following, shown: Shown): void {
    const key = statusKey(shown.text, shown.tone, shown.offer);
    if (key === f.shown) return;
    f.shown = key;
    showState(shown);
  }

  function startFollowing(record: SendRecord): Following {
    stopFollowing();
    following = {
      id: record.id,
      agent: record.agent,
      sent: record.sent,
      count: record.sent.annotations.length,
      startedAt: record.startedAt,
      arrived: record.line !== null,
      stop: new AbortController(),
      asking: false,
      shown: null,
    };
    return following;
  }

  function stopFollowing(): void {
    following?.stop.abort();
    following = null;
  }

  // Asks how the send stands and shows each answer: after `delay` milliseconds, at once without
  // one, then every FOLLOW_EVERY_MS until FOLLOW_FOR_MS have passed since the send started
  // (followSend). `again`: a single ask, as when the user comes back after that. `first`: an answer
  // that has come already, which stands for the first ask. One round at a time.
  async function pursue(
    f: Following, { first, again = false, delay = 0 }: { first?: SendReply; again?: boolean; delay?: number } = {},
  ): Promise<void> {
    if (f.asking) return;
    f.asking = true;
    let given = first;
    try {
      await followSend({
        ask: () => {
          const reply = given;
          given = undefined;
          return reply ? Promise.resolve(reply) : stateOf(f);
        },
        show: reply => showAnswer(f, reply),
        sleep: ms => pause(ms, f.stop.signal),
        now: Date.now,
        from: again ? -Infinity : f.startedAt,
        signal: f.stop.signal,
        delay,
      });
    } finally {
      f.asking = false;
    }
  }

  // Once the round of asks for the followed send has ended without a settled state, the user's
  // coming back to the page or a use of the bar asks once more, at most once in ASK_AGAIN_PAUSE.
  // Not while the request of a send or copy runs.
  function askAgain(): void {
    const f = following;
    if (!f || f.asking || frozen) return;
    if (performance.now() - askedAt < ASK_AGAIN_PAUSE) return;
    pursue(f, { again: true }).catch(warn('Asking for the state of the send failed'));
  }

  // How the send stands, as the service worker answers. For a send that the tab no longer
  // follows, the following ends, and nothing is shown.
  async function stateOf(f: Following): Promise<SendReply> {
    askedAt = performance.now();
    const reply = await askBridge<SendReply | NotFollowed>({ type: 'send:state', id: f.id });
    if (!('followed' in reply)) return reply;
    if (following === f) following = null;
    f.stop.abort();
    return UNFOLLOWED;
  }

  // Shows an answer about the send `f`, when it differs from what the bar last showed for it
  // (showFor). A failure leaves the status line as it is: the bar asks again when the user comes
  // back or uses the bar. So does `sending` once the line shows something of this send, such as
  // that no answer came. The first answer that says the bridge has the send removes what it
  // carried from the list, or takes over the tab's draft when it has changed since (kept), as the
  // answer to the send does. A settled state ends the following. Once the send is picked up, or its
  // agent is gone, the agents are listed again: the agent that picked it up has stopped waiting,
  // and the dropdown no longer offers an agent that is gone. The message that the agent is gone
  // stays on the status line through that listing and the ones after it (goneMessage).
  function showAnswer(f: Following, reply: SendReply): void {
    if (!reply.ok) return;
    if (saysArrived(reply) && !f.arrived) {
      f.arrived = true;
      arrive(reply.kept, f.sent).catch(warn('Taking over the annotations of this page failed'));
    }
    if (reply.state !== 'sending' || f.shown === null) {
      const shown = shows(reply, f.agent, f.count, f.arrived);
      showFor(f, shown);
      if (reply.state === 'agent_gone') goneMessage = statusKey(shown.text, shown.tone, shown.offer);
    }
    if (!settled(reply.state) || following !== f) return;
    following = null;
    if (reply.state === 'picked_up' || reply.state === 'agent_gone') listAgents().catch(warn('Listing the agents failed'));
  }

  // The list takes over the tab's draft for this page as the service worker has it, without
  // saving it again. The bridge has the send, so a draft that cannot be loaded, whether the
  // request is rejected or the service worker answers with a failure, leaves the list as it is
  // rather than turn that into a failure.
  async function takeOverDraft(): Promise<void> {
    const loaded = await toBackground<{ draft?: Draft | null } | BridgeError>({ type: 'draft:load', url: location.href })
      .catch(error => {
        warn('Loading the annotations of this page failed')(error);
        return null;
      });
    if (loaded && 'ok' in loaded) warn('Loading the annotations of this page failed')(loaded.message);
    else if (loaded?.draft) store.restore(loaded.draft);
  }

  // The record of the tab's send, or null, also when it cannot be loaded.
  async function loadRecord(): Promise<SendRecord | null> {
    const loaded = await toBackground<{ record?: SendRecord | null } | BridgeError>({ type: 'send:load' })
      .catch(error => {
        warn('Loading the record of the send failed')(error);
        return null;
      });
    if (loaded && 'ok' in loaded) {
      warn('Loading the record of the send failed')(loaded.message);
      return null;
    }
    return loaded?.record ?? null;
  }

  // Through the bridge, Copy writes the files like Send and clears the same way; the
  // clipboard gets the line. Without the bridge, or with one whose version does not fit, the
  // clipboard gets the Markdown, made here without screenshots, and the annotations stay.
  async function copy(): Promise<void> {
    await delivering(COPYING, 'Copying failed', async () => {
      await store.save();
      const page = pageInfo();
      const reply = await askBridge<SentOk>({ type: 'copy', page });
      if (reply.ok) {
        store.clear();
        if (await writeClipboard(ui.root, reply.line)) setStatus(COPIED, 'done');
        else setStatus(`${CLIPBOARD_FAILED} Paste this line into your agent: ${reply.line}`, 'problem');
      } else if (reply.kind === 'bridge_down' || reply.kind === 'version_mismatch') {
        const annotations = store.annotations().map(annotation => ({ ...annotation, screenshot: null }));
        const markdown = renderMarkdown(page, store.note(), annotations);
        if (await writeClipboard(ui.root, markdown)) setStatus(COPIED_MARKDOWN, 'done');
        else setStatus(CLIPBOARD_FAILED, 'problem');
      } else {
        setStatus(`Copying failed: ${reply.message}`, 'problem');
      }
    });
  }

  function onMessage(message: ToContent, _sender: chrome.runtime.MessageSender, reply: (answer: unknown) => void): void {
    if (message.type !== 'toggle') return;
    setVisible(!ui.visible());
    reply({ ok: true });
  }

  // Esc closes the popup when one is open, else it leaves pick mode, else it is the page's.
  // While the crop of a pick is taken, before the popup can take the focus, no key reaches
  // the page, so none fires its hotkeys; Esc there cancels the pick and pick mode stays on.
  const onKey = (event: KeyboardEvent) => {
    if (!ui.visible()) return;
    const escape = event.type === 'keydown' && event.key === 'Escape' && !event.isComposing;
    if (capturing) {
      if (escape) cancelled = true;
    } else if (!escape) {
      return;
    } else if (popup.isOpen()) {
      popup.close();
    } else if (stopPicking) {
      setPicking(false);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    window.addEventListener(type, onKey, { capture: true, signal });
  }
  window.addEventListener('scroll', queueFollow, { capture: true, passive: true, signal });
  window.addEventListener('resize', queueFollow, { signal });
  // A user who has told an agent in another window to wait comes back to the page: the state of
  // the send the bar follows is asked for again (askAgain), and the agents are listed again
  // (listOnLook). Only on events the browser made.
  const lookAgain = trusted(() => {
    if (!ui.visible() || document.visibilityState !== 'visible') return;
    askAgain();
    listOnLook();
  });
  document.addEventListener('visibilitychange', lookAgain, { signal });
  window.addEventListener('focus', lookAgain, { signal });
  // A single-page app changes the URL without a reload. The draft moves along, so a reload
  // on the new URL finds it.
  const moveDraft = () => void store.save();
  window.addEventListener('popstate', moveDraft, { signal });
  window.addEventListener('hashchange', moveDraft, { signal });
  window.navigation?.addEventListener('navigatesuccess', moveDraft, { signal });
  // A reload or a navigation while the popup of a pick is open: that pick is never added.
  // A page that goes into the back/forward cache keeps the popup open for when it returns.
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    if (unadded) dropCrop(unadded);
    unadded = null;
  }, { signal });
  const pageChanges = new MutationObserver(queueFollow);
  pageChanges.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  chrome.runtime.onMessage.addListener(onMessage);
  store.subscribe(render);

  render();
  setVisible(true);
  load().catch(warn('Loading the annotations of this page failed'));

  // The tab's send and the draft of this page, in that order: a draft that the service worker
  // deletes in between, as it learns that the send arrived, is then not shown as unsent. With a
  // record, the bar goes on following its send.
  async function load(): Promise<void> {
    const record = await loadRecord();
    const loaded = await toBackground<{ draft?: Draft | null }>({ type: 'draft:load', url: location.href })
      .catch(error => {
        warn('Loading the annotations of this page failed')(error);
        return null;
      });
    if (loaded?.draft) store.restore(loaded.draft);
    if (record) await goOn(record);
  }

  return {
    dispose() {
      if (unadded) dropCrop(unadded);
      stopFollowing();
      listening.abort();
      pageChanges.disconnect();
      stopPicking?.();
      ui.host.remove();
      try {
        chrome.runtime.onMessage.removeListener(onMessage);
      } catch {
        // The extension this script came from is gone; so is its listener.
      }
    },
  };
}

// A request for the bridge, through the service worker, and its answer. An extension that
// was reloaded or removed since this script was injected cannot answer: the service worker
// could not be reached, so no answer came, and a send may have reached the agent all the same.
function askBridge<T>(message: ToBackground): Promise<T | BridgeError> {
  return toBackground<T | BridgeError>(message).catch(unanswered);
}

// Whether an answer says that the bridge has the send, or had it: any state the bridge gives but
// `unknown`, and `unknown` with the line the service worker keeps for a send that had arrived. Not
// `sending`: the send may still be arriving.
function saysArrived(reply: Followed): boolean {
  if (reply.state === 'sending') return false;
  return reply.state !== 'unknown' || reply.line !== null;
}

// The status line as one string, to tell whether it changes.
function statusKey(text: string, tone: Tone, offer?: Offer): string {
  return JSON.stringify([text, tone, offer?.text ?? null, offer?.button ?? null]);
}

// Waits `ms` milliseconds, or until `signal` ends.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// Deletes the crop of a pick that was not added.
function dropCrop(id: string): void {
  toBackground({ type: 'crop:delete', id }).catch(warn('Deleting the crop failed'));
}

// The page as it is at the moment of Send or Copy.
function pageInfo(): PageInfo {
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    sourceFile: sourceFile(location.href),
  };
}

// Puts `text` on the clipboard. Pages that are not a secure context, such as a dev server on
// plain http under another name than localhost, have no Clipboard API; there the copy
// command does it, which the extension's clipboardWrite permission allows.
async function writeClipboard(root: ShadowRoot, text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    if (copyCommand(root, text)) return true;
    warn('Writing to the clipboard failed')(error);
    return false;
  }
}

// Copies `text` from a field in our own shadow root, out of sight, and gives the focus back.
function copyCommand(root: ShadowRoot, text: string): boolean {
  const focused = (root.activeElement ?? document.activeElement) as HTMLElement | null;
  const field = h('textarea', { class: 'clipboard', attrs: { 'aria-hidden': 'true', tabindex: '-1' } });
  field.value = text;
  root.append(field);
  field.select();
  try {
    return document.execCommand('copy');
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
  }
}

// The id of an annotation: 8 random hexadecimal characters.
function newId(): string {
  return randomHex(4);
}

// `bytes` random bytes as lower-case hexadecimal characters. Not from crypto.randomUUID, which a
// page that is not a secure context, such as one on plain http, does not have.
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function warn(what: string): (error: unknown) => void {
  return error => console.warn(`[clicknote] ${what}:`, error);
}
