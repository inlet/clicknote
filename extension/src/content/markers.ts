import type { Annotation } from '../../../shared/types.ts';
import { h, placeAt } from './ui.ts';
import type { Ui } from './ui.ts';

// The numbered markers at the top-left of each annotated element that is still on the page.
// Several annotations on one element sit side by side, so each can be clicked.

// An annotation with the element it points at, or null when that is no longer found.
export interface Placed { annotation: Annotation; element: Element | null }

export interface Markers {
  render(placed: Placed[]): void;
  follow(): void;                          // puts the markers back on their elements
}

const GAP = 6;                             // between markers side by side, past the shadow of the first
const OVERHANG = { x: 13, y: 13 };         // how far a marker sticks out past the corner: half of it
const EDGE = 2;

export function createMarkers(ui: Ui, onOpen: (annotation: Annotation) => void): Markers {
  const layer = h('div', { class: 'markers' });
  ui.root.append(layer);
  let shown: { marker: HTMLElement; element: Element }[] = [];

  function follow(): void {
    const { width: vw, height: vh } = ui.viewport();
    const used = new Map<Element, number>();   // width taken by earlier markers on the element
    for (const { marker, element } of shown) {
      const rect = element.getBoundingClientRect();
      marker.hidden = rect.width === 0 && rect.height === 0;
      if (marker.hidden) continue;
      // Kept inside the window while the element is in view, as for a header at the very top.
      const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      const x = inView ? Math.max(EDGE, rect.left - OVERHANG.x) : rect.left - OVERHANG.x;
      const y = inView ? Math.max(EDGE, rect.top - OVERHANG.y) : rect.top - OVERHANG.y;
      const offset = used.get(element) ?? 0;
      placeAt(marker, x + offset, y);
      used.set(element, offset + marker.offsetWidth + GAP);
    }
  }

  return {
    render(placed) {
      shown = [];
      for (const { annotation, element } of placed) {
        if (!element) continue;
        const marker = h('button', {
          part: 'marker',
          class: 'marker',
          text: String(annotation.number),
          attrs: {
            'aria-label': `Annotation ${annotation.number}: ${annotation.comment}`,
            title: annotation.comment,
            'data-intent': annotation.intent,
          },
        });
        marker.addEventListener('click', () => onOpen(annotation));
        shown.push({ marker, element });
      }
      layer.replaceChildren(...shown.map(({ marker }) => marker));
      follow();
    },
    follow,
  };
}
