import type { Rect } from '../../shared/types.ts';

// Where to cut an annotation's crop out of a screenshot of the visible tab, and how the crop
// travels as text. No browser APIs, so it runs in Node too.

const CHUNK = 0x8000;

// The part of the screenshot to keep, in image pixels: the visible part of the element plus
// `margin` CSS pixels on each side, clipped to the viewport. `rect` and `viewport` are in CSS
// pixels and `scale` is image pixels per CSS pixel. Null when no part of the element is visible.
export function cropRect(
  rect: Rect,
  viewport: { width: number; height: number },
  scale: number,
  margin = 8,
): { sx: number; sy: number; sw: number; sh: number } | null {
  const visible = Math.min(viewport.width, rect.x + rect.width) > Math.max(0, rect.x)
    && Math.min(viewport.height, rect.y + rect.height) > Math.max(0, rect.y);
  if (!visible) return null;

  // Rounding each edge, not the size, keeps an edge at the viewport on the edge of the image.
  const sx = Math.round(Math.max(0, rect.x - margin) * scale);
  const sy = Math.round(Math.max(0, rect.y - margin) * scale);
  const sw = Math.round(Math.min(viewport.width, rect.x + rect.width + margin) * scale) - sx;
  const sh = Math.round(Math.min(viewport.height, rect.y + rect.height + margin) * scale) - sy;
  if (!(sw >= 1 && sh >= 1)) return null;
  return { sx, sy, sw, sh };
}

// The bytes of `blob` as base64, without a `data:` prefix.
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // In chunks, because a spread of every byte at once overflows the call stack.
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
}
