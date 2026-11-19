import { trusted } from './ui.ts';
import type { Ui } from './ui.ts';

// Pick mode. A transparent shield in the UI covers the page and takes the pointer, so a
// click picks instead of following a link, and an iframe, whose events never reach this
// document, is picked as a whole. The bar, the markers and the popup lie above the shield
// and stay clickable.

// Shows the shield: hovering it outlines the element underneath, a click picks it. While
// `paused()` is true (the popup is open, or a pick's crop is taken) the outline stays and
// clicks do nothing. Returns the function that ends pick mode, which removes the shield and
// the outline.
export function startPicking(ui: Ui, onPick: (el: Element) => void, paused: () => boolean): () => void {
  const { shield, host } = ui;
  const listening = new AbortController();
  const { signal } = listening;
  let pointer: { x: number; y: number } | null = null;

  const hover = () => {
    if (!paused()) ui.highlight(pointer && elementAt(pointer.x, pointer.y, host));
  };

  shield.addEventListener('pointermove', event => {
    pointer = { x: event.clientX, y: event.clientY };
    hover();
  }, { signal });
  shield.addEventListener('pointerleave', () => {
    pointer = null;
    hover();
  }, { signal });
  // Keeps the page's focus and text selection where they are.
  shield.addEventListener('mousedown', event => event.preventDefault(), { signal });
  // The page never sees the click: it lands on the shield, and ui.ts stops it at the root.
  shield.addEventListener('click', trusted((event: MouseEvent) => {
    if (paused()) return;
    const el = elementAt(event.clientX, event.clientY, host);
    if (el) onPick(el);
  }), { signal });
  // A scroll moves the page under a pointer that stands still.
  window.addEventListener('scroll', hover, { capture: true, passive: true, signal });

  shield.hidden = false;
  return () => {
    listening.abort();
    shield.hidden = true;
    ui.highlight(null);
  };
}

// The deepest page element at a point in the viewport, descending into open shadow roots.
// Our own UI is skipped: everything in its shadow root is reported as the host.
export function elementAt(x: number, y: number, host: Element): Element | null {
  let found = topmost(document.elementsFromPoint(x, y), host);
  for (let root = found?.shadowRoot; found && root; root = found.shadowRoot) {
    const inner = topmost(root.elementsFromPoint(x, y), host);
    if (!inner || !root.contains(inner)) break;
    found = inner;
  }
  return found;
}

function topmost(elements: Element[], host: Element): Element | null {
  return elements.find(el => el !== host) ?? null;
}
