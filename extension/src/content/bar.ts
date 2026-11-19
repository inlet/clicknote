import { listedAs } from '../../../shared/label.ts';
import type { AgentInfo, Annotation } from '../../../shared/types.ts';
import type { Placed } from './markers.ts';
import { clamp, h, icon, logo, trusted } from './ui.ts';
import type { Ui } from './ui.ts';

// The bar floating at the bottom right: the count, the pick mode switch, the list of
// annotations, the general comment, the choice of agent, Send and Copy, and a status line.
// It can be dragged by its header and collapsed to the header alone.

export interface BarHandlers {
  onTogglePick(): void;
  onOpen(annotation: Annotation): void;
  onHover(annotation: Annotation | null): void;   // a row under the pointer, or none
  cropOf(id: string): Promise<string | null>;     // the crop as a data URL
  onNote(note: string): void;                     // the general comment, at each change
  onAgentsWanted(): void;                         // the dropdown got focus
  onSend(agent: AgentInfo): void;
  onCopy(): void;
  onCopyOffer(text: string): Promise<boolean>;    // whether it reached the clipboard
  onUse(): void;                                  // a press or the focus anywhere inside the bar
}

// How the status line reads: in progress, done, or a problem the user has to act on.
export type Tone = 'quiet' | 'done' | 'problem';

// A text the status line offers to copy, such as the sentence to say to an agent, and the
// label of the button that copies it. `code`: the text is a line to paste as it is, such as a
// command or a path, which the bar sets in a fixed-width font; a sentence is set in its own font.
export interface Offer { text: string; button: string; code?: boolean }

export interface Bar {
  render(placed: Placed[], note: string): void;
  setPicking(on: boolean): void;
  setAgents(agents: AgentInfo[], preselect: string | null): void;
  setBusy(on: boolean): void;                     // a send or copy runs: the list cannot change
  // An empty text hides the line. With an offer, a block under the line shows its text, with a
  // button that copies it; without one, that block is hidden.
  setStatus(text: string, tone: Tone, offer?: Offer): void;
  keepInView(): void;                             // after the window has changed size
}

const HINT_PICKING = 'Click an element on the page to annotate it.';
const HINT_NOT_PICKING = 'Turn on Pick, then click an element to annotate it.';
const NO_AGENT = 'No agent listening';
const CHOOSE_AGENT = 'Choose an agent…';
const OFFER_COPIED = 'Copied';
const CROP_HEIGHT = 72;

export function createBar(ui: Ui, handlers: BarHandlers): Bar {
  const count = h('span', { part: 'count', class: 'count', text: '0' });
  const pick = h('button', {
    part: 'pick-toggle',
    class: 'pill',
    attrs: { 'aria-pressed': 'false', title: 'Pick an element (Esc to stop)' },
  }, icon('pick'), 'Pick');
  const collapse = h('button', {
    part: 'collapse',
    class: 'pill round collapse',
    attrs: { 'aria-expanded': 'true', 'aria-label': 'Collapse', title: 'Collapse' },
  }, icon('chevron'));
  const title = h('div', { class: 'bar-title' }, logo(), h('span', { text: 'Annotations' }), count);
  const header = h('div', { class: 'bar-header' }, title, pick, collapse);
  const list = h('ol', { part: 'list', class: 'list' });
  const hint = h('p', { class: 'empty', text: HINT_NOT_PICKING });
  const noteField = h('textarea', {
    part: 'note',
    class: 'note',
    attrs: { rows: '4', 'aria-label': 'General comment', placeholder: 'General comment for the agent (optional)' },
  });
  const select = h('select', { part: 'agent-select', class: 'agent-select', attrs: { 'aria-label': 'Agent' } });
  const copy = h('button', {
    part: 'copy',
    class: 'pill tall outlined',
    text: 'Copy',
    attrs: { title: 'Copy to the clipboard instead of sending' },
  });
  const send = h('button', { part: 'send', class: 'pill tall filled', text: 'Send' });
  const status = h('p', { part: 'status', class: 'status', attrs: { role: 'status' } });
  status.hidden = true;
  // A text the status line offers to copy, such as the sentence to say to an agent.
  const offer = h('p', { part: 'offer', class: 'offer' });
  const copyOffer = h('button', { part: 'copy-offer', class: 'pill outlined' });
  const statusOffer = h('div', { part: 'status-offer', class: 'status-offer' }, offer, copyOffer);
  statusOffer.hidden = true;
  // The dropdown has a row of its own, so the chosen agent can be read at a glance. The status
  // line sits above it and the actions: the bar grows upwards, so Send and Copy stay under the
  // pointer when a message appears. The dropdown draws its own arrow, which lies over its end.
  // The lower part of the bar is three boxes on one ground: in a low window the list and the
  // messages between them give way and scroll, and the comment, the dropdown and the buttons stay.
  const messages = h('div', { class: 'footer messages' }, status, statusOffer);
  messages.hidden = true;
  const body = h('div', { class: 'bar-body' }, list, hint,
    h('div', { class: 'footer footer-start' }, noteField),
    messages,
    h('div', { class: 'footer footer-end' },
      h('div', { class: 'agent' }, select, icon('chevron')),
      h('div', { part: 'actions', class: 'bar-actions' }, copy, send)));
  const bar = h('section', { part: 'bar', class: 'panel bar', attrs: { 'aria-label': 'Annotations' } }, header, body);
  ui.root.append(bar);

  let annotationCount = 0;
  let busy = false;
  let agents: AgentInfo[] | null = null;         // null until the first listing
  let preselected: string | null = null;
  let chosen: string | null = null;              // the agent the user picked in this page session
  let statuses = 0;                              // counts the calls to setStatus
  let offered: Offer | null = null;              // what the status line offers to copy

  // Fetched once per annotation; a crop never changes.
  const crops = new Map<string, Promise<string | null>>();
  const cropOf = (id: string) => {
    let crop = crops.get(id);
    if (!crop) crops.set(id, crop = handlers.cropOf(id));
    return crop;
  };

  function row({ annotation, element }: Placed): HTMLLIElement {
    const meta = h('span', { class: 'row-meta' },
      icon(annotation.intent), annotation.intent === 'change' ? 'Change' : 'Question');
    const text = h('span', { class: 'row-text' }, h('span', { class: 'row-comment', text: annotation.comment }), meta);
    if (!element) {
      meta.append(' · ', h('span', { part: 'not-found', class: 'not-found', text: 'no longer found' }));
      const crop = h('img', { class: 'crop', attrs: { alt: `The element of annotation ${annotation.number}` } });
      crop.hidden = true;
      // The crop has device pixels; shown at its size in CSS pixels, or smaller to fit.
      crop.addEventListener('load', () => {
        crop.style.maxWidth = `min(100%, ${crop.naturalWidth / devicePixelRatio}px)`;
        crop.style.maxHeight = `min(${CROP_HEIGHT}px, ${crop.naturalHeight / devicePixelRatio}px)`;
      });
      void cropOf(annotation.id).then(url => {
        if (!url) return;
        crop.src = url;
        crop.hidden = false;
      });
      text.append(crop);
    }
    const badge = h('span', { class: 'badge', text: String(annotation.number), attrs: { 'data-intent': annotation.intent } });
    const button = h('button', { class: 'row' }, badge, text);
    button.addEventListener('click', () => handlers.onOpen(annotation));
    for (const type of ['mouseenter', 'focus']) button.addEventListener(type, () => handlers.onHover(annotation));
    for (const type of ['mouseleave', 'blur']) button.addEventListener(type, () => handlers.onHover(null));
    return h('li', { part: 'list-item' }, button);
  }

  const selectedAgent = () => agents?.find(agent => agent.id === select.value);

  // Send needs annotations and an agent, Copy only annotations; neither while one of them runs.
  function updateActions(): void {
    copy.disabled = busy || annotationCount === 0;
    send.disabled = copy.disabled || !selectedAgent();
    select.title = select.selectedOptions[0]?.textContent ?? '';
  }

  // A click on a button of the bar leaves the focus in the page, so a page menu that closes
  // when focus leaves it stays open, for instance to be picked.
  bar.addEventListener('mousedown', event => {
    if ((event.target as Element).closest('button')) event.preventDefault();
  });
  // The user uses the bar. Only on events the browser made, so page script cannot make them.
  for (const type of ['pointerdown', 'focusin'] as const) bar.addEventListener(type, trusted(() => handlers.onUse()));
  pick.addEventListener('click', handlers.onTogglePick);
  noteField.addEventListener('input', () => handlers.onNote(noteField.value));
  select.addEventListener('focus', handlers.onAgentsWanted);
  select.addEventListener('change', () => {
    chosen = select.value;
    updateActions();
  });
  send.addEventListener('click', trusted(() => {
    const agent = selectedAgent();
    if (agent) handlers.onSend(agent);
  }));
  copy.addEventListener('click', trusted(() => handlers.onCopy()));
  // The button says Copied until the status line changes; a copy that ends after that says nothing.
  copyOffer.addEventListener('click', trusted(() => {
    if (!offered) return;
    const shown = statuses;
    void handlers.onCopyOffer(offered.text).then(copied => {
      if (copied && shown === statuses) copyOffer.textContent = OFFER_COPIED;
    });
  }));

  collapse.addEventListener('click', () => {
    const expand = body.hidden;
    body.hidden = !expand;
    const name = expand ? 'Collapse' : 'Expand';
    collapse.setAttribute('aria-expanded', String(expand));
    collapse.setAttribute('aria-label', name);
    collapse.title = name;
  });

  // Dragging by the header. The bar stays anchored at its bottom right, so it grows upwards
  // as annotations are added, and it is kept inside the window.
  header.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const start = bar.getBoundingClientRect();
    const grab = { x: event.clientX - start.left, y: event.clientY - start.top };
    header.setPointerCapture(event.pointerId);
    header.classList.add('dragging');
    const move = (moved: PointerEvent) => moveTo(moved.clientX - grab.x, moved.clientY - grab.y);
    const end = () => {
      header.classList.remove('dragging');
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', end);
      header.removeEventListener('pointercancel', end);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
  });

  // The size comes from the bounding box, like the positions it is measured against:
  // offsetWidth and offsetHeight round a fraction away.
  function moveTo(left: number, top: number): void {
    const { width: vw, height: vh } = ui.viewport();
    const { width, height } = bar.getBoundingClientRect();
    setOffset('right', clamp(vw - left - width, 0, vw - width));
    setOffset('bottom', clamp(vh - top - height, 0, vh - height));
  }

  // Grown upwards past the top of the window, or left outside a window that shrank, the bar
  // moves back in, so the header with the handle, Pick and Collapse is always reachable.
  // Its height is capped below the window's, so a long list scrolls inside it instead.
  // A bar inside the window is left where it is: this runs at every frame of a page that
  // animates, and any rounding here would make the bar creep.
  function keepInView(): void {
    const rect = bar.getBoundingClientRect();
    if (rect.width === 0) return;                       // zero while the UI is hidden
    const { width: vw, height: vh } = ui.viewport();
    const right = vw - rect.right;
    const bottom = vh - rect.bottom;
    const keptRight = clamp(right, 0, vw - rect.width);
    const keptBottom = clamp(bottom, 0, vh - rect.height);
    if (keptRight !== right) setOffset('right', keptRight);
    if (keptBottom !== bottom) setOffset('bottom', keptBottom);
  }

  function setOffset(side: 'right' | 'bottom', px: number): void {
    const value = `${px}px`;
    if (bar.style[side] !== value) bar.style[side] = value;
  }

  // Any change of the bar's size: the list, the status line, collapsing, the comment field
  // made taller, or the UI shown again.
  new ResizeObserver(keepInView).observe(bar);

  // Fills the dropdown with these agents and selects one, as setAgents says. Each option reads
  // as listedAs gives it, and its title holds all of that, for a text the dropdown cuts.
  function showAgents(next: AgentInfo[], preselect: string | null): void {
    agents = next;
    preselected = preselect;
    const listed = (id: string | null) => next.some(agent => agent.id === id);
    const selected = listed(chosen) ? chosen : listed(preselect) ? preselect : next.length === 1 ? next[0].id : null;
    const options = next.map(agent => {
      const text = listedAs(agent);
      return h('option', { text, attrs: { value: agent.id, title: text } });
    });
    if (next.length === 0) options.push(h('option', { text: NO_AGENT, attrs: { value: '' } }));
    else if (selected === null) options.unshift(h('option', { text: CHOOSE_AGENT, attrs: { value: '', disabled: '' } }));
    select.replaceChildren(...options);
    select.value = selected ?? '';
    updateActions();
  }

  return {
    render(placed, note) {
      annotationCount = placed.length;
      count.textContent = String(placed.length);
      list.replaceChildren(...placed.map(row));
      list.hidden = placed.length === 0;
      hint.hidden = placed.length > 0;
      // Only when it differs, so typing in the field does not move the caret.
      if (noteField.value !== note) noteField.value = note;
      updateActions();
    },
    setPicking(on) {
      pick.setAttribute('aria-pressed', String(on));
      hint.textContent = on ? HINT_PICKING : HINT_NOT_PICKING;
    },
    // The selection is the agent the user chose, else `preselect` (the tab's agent, else the one
    // bound to the site), else the only one. Among several agents nothing is guessed: a
    // placeholder asks the user to choose, and Send stays off until then. An unchanged list is
    // left alone, so a dropdown that is open stays open.
    setAgents(next, preselect) {
      if (preselect !== preselected || JSON.stringify(next) !== JSON.stringify(agents)) showAgents(next, preselect);
    },
    setBusy(on) {
      busy = on;
      pick.disabled = on;
      noteField.readOnly = on;
      updateActions();
    },
    setStatus(text, tone, shownOffer) {
      statuses += 1;
      status.textContent = text;
      status.dataset.tone = tone;
      status.hidden = text === '';
      offered = shownOffer ?? null;
      offer.textContent = offered?.text ?? '';
      offer.classList.toggle('code', offered?.code === true);
      copyOffer.textContent = offered?.button ?? '';
      statusOffer.hidden = offered === null;
      messages.hidden = status.hidden && statusOffer.hidden;
    },
    keepInView,
  };
}
