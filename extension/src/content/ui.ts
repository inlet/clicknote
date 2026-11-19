import { DARK, ICON, LIGHT } from './look.ts';
import type { Token } from './look.ts';

// The UI host: one `<clicknote-ui>` element on the page with a shadow root, so the page's CSS
// and ours do not touch. It holds the shield for pick mode and the highlight box; the markers,
// the bar and the popup add their own parts to `root`.

// True in the build for the browser tests (`node build.mjs --e2e`). Not defined when Node runs
// the sources, as the unit tests do.
declare const __E2E__: boolean;

export const HOST_TAG = 'clicknote-ui';

export interface Ui {
  root: ShadowRoot;
  host: HTMLElement;
  shield: HTMLElement;                    // covers the page in pick mode, see picker.ts
  show(): void;
  hide(): void;
  visible(): boolean;
  highlight(el: Element | null): void;    // outlines `el`, or nothing
  followHighlight(): void;                // puts the outline back on its element after a scroll
  hiddenDuring<T>(work: () => Promise<T>): Promise<T>;
  viewport(): { width: number; height: number };   // what fixed positions are relative to
}

export function createUi(): Ui {
  const host = document.createElement(HOST_TAG);
  host.toggleAttribute('data-off', true);
  // Closed, so page script cannot reach in to read the UI or drive it. The build for the
  // browser tests leaves it open, because Playwright's locators pierce open roots only.
  const root = host.attachShadow({ mode: typeof __E2E__ !== 'undefined' && __E2E__ ? 'open' : 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(STYLES);
  root.adoptedStyleSheets = [sheet];

  const shield = h('div', { class: 'shield' });
  shield.hidden = true;
  const box = h('div', { part: 'highlight', class: 'highlight' });
  box.hidden = true;
  root.append(shield, box);

  // What happens in the UI stays in it: page hotkeys do not fire while the user types, and
  // a page's "click outside closes the menu" does not see clicks on the bar or the shield,
  // nor its "focus outside closes the menu" the focus moving into the UI.
  for (const type of STOPPED_EVENTS) root.addEventListener(type, event => event.stopPropagation());

  document.documentElement.append(host);

  let highlighted: Element | null = null;
  const followHighlight = () => {
    const rect = highlighted?.isConnected ? highlighted.getBoundingClientRect() : null;
    box.hidden = !rect || (rect.width === 0 && rect.height === 0);
    if (rect) placeAt(box, rect.left, rect.top, rect.width, rect.height);
  };
  const highlight = (el: Element | null) => {
    highlighted = el;
    followHighlight();
  };

  return {
    root,
    host,
    shield,
    show: () => host.toggleAttribute('data-off', false),
    // The outline goes too, so it does not come back on an old element with the UI.
    hide() {
      highlight(null);
      host.toggleAttribute('data-off', true);
    },
    visible: () => !host.hasAttribute('data-off'),
    highlight,
    followHighlight,
    // The screenshot must show the page as the user sees it without our UI on top.
    async hiddenDuring(work) {
      host.toggleAttribute('data-capturing', true);
      try {
        await nextFrames(2);
        return await work();
      } finally {
        host.toggleAttribute('data-capturing', false);
      }
    },
    // The host is fixed to the whole viewport, without scroll bars. Unlike the root element's
    // client size, this is also right on a page in quirks mode.
    viewport: () => ({ width: host.clientWidth, height: host.clientHeight }),
  };
}

interface Props {
  part?: string;                         // the part's name for the tests, as `data-clicknote`
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
}

// An element with its properties and children.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.part) el.dataset.clicknote = props.part;
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  el.append(...children);
  if (el instanceof HTMLButtonElement) el.type = 'button';
  return el;
}

const ICONS = {
  pick: ['M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3', 'M8 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z'],
  chevron: ['M4 6l4 4 4-4'],
  trash: ['M2.5 4.5h11', 'M6 4.5V3h4v1.5', 'M4 4.5l.6 9h6.8l.6-9', 'M6.75 7v4M9.25 7v4'],
  change: ['M3 13l.7-3 6.8-6.8a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2L6 12.3z'],
  question: ['M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z', 'M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.4-.9.8-.9 1.4', 'M8 11.4v.1'],
} as const;

// A line icon on a 16 px grid, as large as the stylesheet makes it where it sits. Built from
// paths, not markup, so a page's Trusted Types policy does not stand in the way.
export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name]) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Clicknote's icon in its simple drawing, for the bar's title. Each shape takes its colour from
// the look's custom properties, so the icon follows the mode.
export function logo(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', ICON.viewBox);
  svg.setAttribute('class', 'logo');
  svg.setAttribute('aria-hidden', 'true');
  for (const { tag, attrs, fill, stroke } of ICON.shapes) {
    const shape = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, value);
    if (fill) shape.style.fill = `var(--cn-${fill})`;
    if (stroke) shape.style.stroke = `var(--cn-${stroke})`;
    svg.append(shape);
  }
  return svg;
}

// The handler for an event the user caused. An event made by page script, such as a click()
// on a button, is ignored, so the page cannot send, pick or add in the user's name.
export function trusted<E extends Event>(handler: (event: E) => void): (event: E) => void {
  return event => {
    if (event.isTrusted) handler(event);
  };
}

// Positions a fixed element in viewport coordinates.
export function placeAt(el: HTMLElement, left: number, top: number, width?: number, height?: number): void {
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  if (width !== undefined) el.style.width = `${width}px`;
  if (height !== undefined) el.style.height = `${height}px`;
}

// `value` kept between `min` and `max`; `min` wins when the range is empty.
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

const SVG = 'http://www.w3.org/2000/svg';

const STOPPED_EVENTS = [
  'keydown', 'keyup', 'keypress',
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
  'focusin', 'focusout',
];

// Two frames, so the browser has painted the page without the UI. A hidden tab paints no
// frames at all, so a timer ends the wait there.
function nextFrames(count: number): Promise<void> {
  return new Promise(done => {
    const timer = setTimeout(done, 250);
    const step = (left: number) => {
      if (left === 0) {
        clearTimeout(timer);
        done();
      } else {
        requestAnimationFrame(() => step(left - 1));
      }
    };
    step(count);
  });
}

// The colours of a mode as custom properties on the host: `--cn-surface`, `--cn-text` and so on.
// The page's rules reach the host too. The prefix keeps the names apart from a page's own, and
// !important makes ours win where a page uses the same: for important declarations the shadow
// root's stylesheet wins over the page's.
function properties(tokens: Record<Token, string>): string {
  return Object.entries(tokens).map(([name, value]) => `--cn-${name}: ${value} !important;`).join('\n  ');
}

const MONOSPACE = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Soft surfaces without hard borders, a lilac ring and shadow around the bar and the popup, and
// every button a pill. The colours are the look's, in light mode and, on a dark system, in dark.
const STYLES = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  display: block !important;
  pointer-events: none !important;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif !important;
  color: var(--cn-text) !important;
  -webkit-font-smoothing: antialiased;
  color-scheme: light dark;

  ${properties(LIGHT)}
}
@media (prefers-color-scheme: dark) {
  :host {
    ${properties(DARK)}
  }
}
:host([data-off]) { display: none !important; }
:host([data-capturing]) { visibility: hidden !important; }
/* The shield draws nothing, so it stays during a capture: a second click goes to it, not to the page. */
:host([data-capturing]) .shield { visibility: visible; }

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button { margin: 0; font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--cn-focus); outline-offset: 2px; }
.icon {
  flex: none; width: 16px; height: 16px;
  fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
}
.logo {
  flex: none; width: 26px; height: 26px;
  fill: none; stroke: var(--cn-icon-ink); stroke-width: ${ICON.strokeWidth}; stroke-linecap: round; stroke-linejoin: round;
}

.shield { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; }
.highlight {
  position: fixed; pointer-events: none;
  border: 2px solid var(--cn-pick-line); border-radius: 10px; background: var(--cn-pick-fill);
}

/* A marker on the page and its badge in the list: a white disc with a dark outline and a hard
   shadow to its lower right, green for a Change and lilac for a Question, in both modes. With a
   padding of only 2px, a number of two digits fits inside the disc; one of three makes it a pill.
   The marker's focus ring is the same in both modes too. */
.marker, .badge {
  --cn-kind: var(--cn-change);
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 26px; height: 26px; padding: 0 2px;
  border: 1.75px solid var(--cn-marker-ink); border-radius: 13px;
  background: var(--cn-marker); color: var(--cn-marker-ink);
  font-size: 12px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums;
  box-shadow: 3px 3px 0 var(--cn-kind);
}
[data-intent="question"] { --cn-kind: var(--cn-question); }
.marker { position: fixed; pointer-events: auto; cursor: pointer; }
.marker:focus-visible { outline-color: var(--cn-marker-focus); }
.badge { min-width: 24px; height: 24px; border-radius: 12px; font-size: 11px; box-shadow: 2.5px 2.5px 0 var(--cn-kind); }

.panel {
  position: fixed; pointer-events: auto;
  background: var(--cn-surface); color: var(--cn-text);
  box-shadow: 0 0 0 1px var(--cn-panel-ring), 0 18px 44px var(--cn-panel-shadow);
}

/* Every button is a pill: plain, round, tinted while pressed, filled (Send, Add) or outlined
   (Copy). A button that is off keeps its shape and greys its text. */
.pill {
  flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 30px; padding: 0 11px; border: none; border-radius: 15px;
  background: transparent; color: var(--cn-text);
  font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer;
}
.pill:enabled:hover { background: var(--cn-hover); }
.pill[aria-pressed="true"], .pill[aria-pressed="true"]:enabled:hover { background: var(--cn-pressed); }
.pill.round { width: 30px; padding: 0; }
.pill.tall { height: 34px; padding: 0 15px; border-radius: 17px; }
.pill.filled { padding: 0 14px; background: var(--cn-fill); color: var(--cn-on-fill); font-weight: 700; }
.pill.tall.filled { padding: 0 19px; }
.pill.filled:enabled:hover { background: var(--cn-fill-hover); }
.pill.outlined { border: 1.5px solid var(--cn-text); background: var(--cn-outline-ground); }
.pill.outlined:enabled:hover { background: var(--cn-hover); }
.pill.danger:enabled:hover { color: var(--cn-bad); }
.pill:disabled { color: var(--cn-off-text); cursor: default; }
.pill.filled:disabled { background: var(--cn-off-ground); }
.pill.outlined:disabled { border-color: var(--cn-off-line); }
.pill .icon { width: 14px; height: 14px; }
.pill.round .icon { width: 16px; height: 16px; }

.bar {
  right: 28px; bottom: 28px; width: 308px; max-height: calc(100vh - 32px);
  display: flex; flex-direction: column; overflow: hidden; border-radius: 26px;
}
.bar-header { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 10px 8px 14px; cursor: grab; user-select: none; touch-action: none; }
/* Collapsed to its header, the bar is a pill with as much room above its buttons as below. */
.bar:has(> .bar-body[hidden]) .bar-header { padding-bottom: 12px; }
.bar-header.dragging { cursor: grabbing; }
.bar-title { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 14px; font-weight: 700; }
.count {
  min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px;
  background: var(--cn-count); color: var(--cn-count-text);
  font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; font-variant-numeric: tabular-nums;
}
.collapse[aria-expanded="false"] .icon { transform: rotate(180deg); }
/* In a window lower than the bar, the list, its hint and the messages under the comment give way,
   each in proportion to its height, and scroll; the header, the comment, the dropdown and the
   buttons keep theirs. */
.bar-body { display: flex; flex-direction: column; min-height: 0; }
.list { min-height: 0; max-height: 40vh; margin: 0; padding: 2px 8px 8px; list-style: none; overflow-y: auto; scrollbar-width: thin; }
.empty { min-height: 0; margin: 0; padding: 2px 16px 14px; overflow: hidden; color: var(--cn-muted); font-size: 12px; }
.row {
  display: flex; align-items: flex-start; gap: 11px; width: 100%; padding: 8px;
  border: none; border-radius: 16px; background: transparent; color: var(--cn-text); text-align: left; cursor: pointer;
}
.row:hover { background: var(--cn-hover); }
/* Inside the row, so the list, which scrolls and so cuts off what lies past its edges, shows all
   of it, also above the first row. */
.row:focus-visible { outline-offset: -2px; }
.row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.row-comment {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; white-space: pre-line;
}
.row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--cn-muted); font-size: 11px; }
.row-meta .icon { width: 12px; height: 12px; }
.not-found { color: var(--cn-bad); }
.crop { display: block; align-self: flex-start; max-width: 100%; margin-top: 4px; border-radius: 8px; box-shadow: 0 0 0 1px var(--cn-field-ring); }
/* The lower part, on a ground of its own under a line: the comment, the messages, the dropdown and
   the buttons, 8px apart. Under the messages, half of that is padding, which scrolls with them and
   leaves room for the focus ring of their button; the other half is a border, which stays between
   them and the dropdown when they are cut off. */
.footer { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 0 12px 8px; background: var(--cn-footer); }
.footer-start { padding-top: 10px; border-top: 1px solid var(--cn-footer-line); }
.messages {
  flex: 0 1 auto; min-height: 0; padding-bottom: 4px; border-bottom: 4px solid var(--cn-footer);
  overflow-y: auto; scrollbar-width: thin;
}
.footer-end { padding-bottom: 12px; }
.bar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
/* Across the whole footer, with its own arrow at the end. An entry too long for it is cut at its
   end with an ellipsis, before the arrow, so the dot at its start stays; its title has all of it. */
.agent { position: relative; }
.agent-select {
  display: block; width: 100%; height: 34px; margin: 0; padding: 0 32px 0 12px;
  border: none; border-radius: 17px; outline: none; appearance: none;
  background: var(--cn-field); color: var(--cn-text); box-shadow: 0 0 0 1px var(--cn-field-ring);
  font: inherit; font-size: 12px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.agent-select:focus-visible { box-shadow: 0 0 0 2px var(--cn-focus); }
/* "Choose an agent…" and "No agent listening" are no agent. */
.agent-select:has(option[value=""]:checked) { color: var(--cn-muted); }
.agent .icon { position: absolute; top: 10px; right: 12px; width: 14px; height: 14px; color: var(--cn-text); pointer-events: none; }
/* Plain while something runs; on a green ground when it worked, on a red one when the user has to act. */
.status { margin: 0; padding: 0 2px; color: var(--cn-muted); font-size: 12px; overflow-wrap: anywhere; user-select: text; }
.status[data-tone="done"], .status[data-tone="problem"] { padding: 8px 12px; border-radius: 14px; }
.status[data-tone="done"] { background: var(--cn-good-ground); color: var(--cn-text); }
.status[data-tone="problem"] { background: var(--cn-bad-ground); color: var(--cn-bad); }
/* A text for the user to copy: one click selects all of it, and it wraps anywhere in the narrow
   bar. A sentence is set in the bar's own font, a line to paste as it is in a fixed-width one. */
.status-offer { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.offer {
  display: block; align-self: stretch; margin: 0; padding: 8px 11px; border-radius: 14px;
  background: var(--cn-well); color: var(--cn-text); box-shadow: 0 0 0 1px var(--cn-field-ring);
  font-size: 12px; overflow-wrap: anywhere; user-select: all;
}
.offer.code { font: 11px/1.45 ${MONOSPACE}; }
.clipboard { position: fixed; top: 0; left: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; pointer-events: none; }

.popup { width: 344px; padding: 14px; display: flex; flex-direction: column; gap: 10px; border-radius: 24px; }
.popup-label {
  padding: 0 2px; overflow: hidden; color: var(--cn-muted); white-space: nowrap; text-overflow: ellipsis;
  font: 11px/1.4 ${MONOSPACE};
}
.comment, .note {
  display: block; width: 100%; margin: 0; resize: vertical;
  border: none; border-radius: 14px; outline: none; box-shadow: 0 0 0 1px var(--cn-field-ring);
  color: var(--cn-text); font: inherit; line-height: 1.4;
}
.comment { min-height: 72px; max-height: 40vh; padding: 9px 12px; background: var(--cn-well); font-size: 13px; }
.comment:focus, .note:focus { box-shadow: 0 0 0 2px var(--cn-focus); }
.comment::placeholder, .note::placeholder { color: var(--cn-muted); opacity: 1; }
/* Never lower than four lines of its own text, also in a short window and after a drag of its
   corner; up to a quarter of the window where that is more. A height here counts the padding
   (border-box), 8px above and below. The first of each pair is for a browser without the unit lh:
   four lines at the line height of 1.4, as its rows give. */
.note {
  min-height: calc(5.6em + 16px); min-height: calc(4lh + 16px);
  max-height: max(25vh, calc(5.6em + 16px)); max-height: max(25vh, calc(4lh + 16px));
  padding: 8px 11px; background: var(--cn-field); font-size: 12px;
}
.note:read-only { color: var(--cn-muted); }
/* The switch, then Delete, Cancel and Add or Save at the right end. Where they do not fit in one
   row, as with Delete, the buttons go to a row of their own as a group, in the same order. */
.popup-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 6px; }
.popup-buttons { display: flex; align-items: center; gap: 6px; margin-left: auto; }
/* Delete, a size smaller than the pills beside it. */
.pill.round.small { width: 26px; height: 26px; }
.segmented { display: inline-flex; padding: 3px; border-radius: 15px; background: var(--cn-segment); }
.segmented button {
  height: 24px; padding: 0 11px; border: none; border-radius: 12px;
  background: transparent; color: var(--cn-segment-text); font-size: 12px; font-weight: 500; cursor: pointer;
}
.segmented button[aria-pressed="true"] {
  background: var(--cn-segment-on); color: var(--cn-text); font-weight: 600; box-shadow: 0 1px 2px var(--cn-segment-shadow);
}
`;
