// Makes the extension's four PNG icons from the SVG drawings next to this file, each on a
// transparent ground, with the Chromium that Playwright brings:
//
//   node extension/icons/render.mjs
//
// Run it by hand when a drawing changes; the build only copies the PNG files. It needs
// Playwright's Chromium once: `npx playwright install chromium`.
//
// icon.svg is the full drawing: a browser window with its three dots and a green element, and a
// speech bubble with a prompt sign in it. icon-small.svg is the simple drawing, without the dots
// and the element; icon-16.svg the simplest, whose prompt sign has no line. Each drawing is on a
// grid of 64 units and carries the width of its lines. In the two small ones the class `outline`
// marks the shapes the white edge goes around.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..', '..');

// The large icons stand on a lilac tile of their own. The toolbar's icons stand on the toolbar,
// light or dark, so they get a white edge around the drawing that keeps its dark lines apart from
// a dark toolbar. The tile's radius and the drawing's width on it are in pixels, the edge's width
// in the drawing's units.
const ICONS = [
  { size: 128, drawing: 'icon.svg', tile: { radius: 30, drawingWidth: 100 } },
  { size: 48, drawing: 'icon-small.svg', tile: { radius: 12, drawingWidth: 38 } },
  { size: 32, drawing: 'icon-small.svg', edge: 10 },
  { size: 16, drawing: 'icon-16.svg', edge: 13 },
];
const TILE = '#EEF0FF';
const EDGE = '#FFFFFF';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of ICONS) {
    await page.setContent(html(icon, await readFile(join(HERE, icon.drawing), 'utf8')));
    if (icon.edge !== undefined) await page.evaluate(addEdge, { width: icon.edge, colour: EDGE });
    const out = join(HERE, `icon-${icon.size}.png`);
    await page.locator('#icon').screenshot({ path: out, omitBackground: true });
    console.log(`wrote ${relative(ROOT, out)}`);
  }
} finally {
  await browser.close();
}

// A page with the icon as a box of its size: the drawing in its middle, on the tile if it has one.
function html({ size, tile }, svg) {
  const drawingWidth = tile?.drawingWidth ?? size;
  const ground = tile === undefined ? '' : `border-radius: ${tile.radius}px; background: ${TILE};`;
  return `<!doctype html>
<style>
  body { margin: 0; }
  #icon { width: ${size}px; height: ${size}px; display: flex; align-items: center; justify-content: center; ${ground} }
  #icon > svg { display: block; width: ${drawingWidth}px; height: ${drawingWidth}px; }
</style>
<div id="icon">${svg}</div>`;
}

// Runs in the page. Puts a copy of the shapes of the class `outline`, the window and the bubble,
// behind the drawing, filled and outlined in the edge's colour with a line of the edge's width, so
// the drawing's outline widens by half that width all around. Only those: a shape inside them that
// shares their outline, as the title bar does the window's, would lay a second soft rim on theirs.
function addEdge({ width, colour }) {
  const svg = document.querySelector('#icon > svg');
  const outline = svg.querySelectorAll('.outline');
  if (outline.length === 0) throw new Error('The drawing marks no shape with the class "outline".');
  const edge = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (const shape of outline) {
    const copy = shape.cloneNode();
    copy.setAttribute('fill', colour);
    copy.setAttribute('stroke', colour);
    copy.setAttribute('stroke-width', String(width));
    edge.append(copy);
  }
  svg.prepend(edge);
}
