// Makes the pictures under docs/readme/ that show the look of the extension:
// - annotating.png, the screenshot at the top of the README: the demo page with three
//   annotations, the popup of a fourth being written, and the bar with a waiting agent chosen;
// - look-dark.png: the same in dark mode, where the bar, the popup and the outline are dark and
//   the demo page, which has no dark mode, stays light;
// - look-queued.png: the bar alone after a send of three annotations to an agent that does not
//   wait, so the send is queued and its line is on offer;
// - look-icons.png: the extension's four icons, each at its own size and each pixel shown 2x2, on
//   a light and on a dark toolbar ground.
//
//   npm run readme:screenshot
//
// which is `node build.mjs --e2e` and then this script. Like the browser tests, it drives the
// e2e build of the extension (dist/extension-e2e) in Playwright's Chromium, with a stand-in
// for the bridge, so nothing reaches a running bridge.
import { expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sendLine } from '../../shared/line.ts';
import { activate, annotate, launch, part, pickAt, standIn, stubBridge } from '../../test/e2e/helpers.ts';

const HERE = import.meta.dirname;
const ROOT = join(HERE, '..', '..');

// The agent in the dropdown, preselected as if the site had sent to it before. The bar lists it
// as `● my-site · landing page copy · claude-code · waiting`, or with an open dot and without
// `waiting` when it does not wait.
const AGENT = { id: '3f9c2a7b8d10', folder: 'my-site', about: 'landing page copy', harness: 'claude-code' };
const WAITING = standIn({ ...AGENT, waiting: true });
const IDLE = standIn({ ...AGENT, waiting: false });

// The send of look-queued.png: its folder, and its line, for the demo page at the address the
// reference gives it, so the picture does not change with the port the page is served on.
const FOLDER = '/Users/you/.local/state/clicknote/sends/20261119-153012';
const LINE = sendLine(3, 'http://localhost:3000/', `${FOLDER}/annotations.md`);

const NOTHING = { reply: { ok: false, kind: 'failed', message: 'The screenshot sends nothing.' } };

if (!existsSync(join(ROOT, 'dist', 'extension-e2e', 'manifest.json'))) {
  console.error('dist/extension-e2e is not built. Run "node build.mjs --e2e" first, or "npm run readme:screenshot".');
  process.exit(1);
}

await annotating('light', 'annotating.png');
await annotating('dark', 'look-dark.png');
await queued('look-queued.png');
await icons('look-icons.png');

// The demo page in the colour scheme given, with a session that closes afterwards.
async function withDemo(colorScheme, body) {
  const session = await launch({
    folder: HERE,
    page: 'demo.html',
    browser: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme },
  });
  try {
    await body(session);
  } finally {
    await session.close();
  }
}

// The README's scene: three annotations, a general comment, and the popup of a fourth being
// written, with the waiting agent chosen.
async function annotating(colorScheme, name) {
  await withDemo(colorScheme, async ({ page, sw }) => {
    await stubBridge(sw, {
      agents: { reply: { ok: true, agents: [WAITING], preselect: WAITING.id } },
      send: NOTHING,
      copy: NOTHING,
      state: NOTHING,
    });
    await activate(sw, page);
    await expect(part(page, 'agent-select')).toHaveValue(WAITING.id);
    await threeAnnotations(page);

    // The fourth annotation, being written: its popup is open under the element.
    await pickAt(page, '#reminders-text');
    await part(page, 'comment').fill('Shorten this to two lines, like the other cards');
    await expect(part(page, 'add')).toBeEnabled();
    await expect(part(page, 'status')).toBeHidden();

    await page.screenshot({ path: join(HERE, name), animations: 'disabled' });
    console.log(`wrote ${relative(ROOT, join(HERE, name))}`);
  });
}

// The bar after the three annotations of the README's scene were sent to the agent that does not
// wait: the status says the send is queued, and the send's line is on offer to copy.
async function queued(name) {
  await withDemo('light', async ({ page, sw }) => {
    await stubBridge(sw, {
      agents: { reply: { ok: true, agents: [IDLE], preselect: IDLE.id } },
      send: { reply: { ok: true, folder: FOLDER, line: LINE, agent: IDLE.id } },
      copy: NOTHING,
      state: { reply: { ok: true, state: 'queued', line: LINE } },
    });
    await activate(sw, page);
    await expect(part(page, 'agent-select')).toHaveValue(IDLE.id);
    await threeAnnotations(page);
    await part(page, 'send').click();
    await expect(part(page, 'copy-offer')).toBeVisible();
    await expect(part(page, 'status')).toHaveText(/Queued: the agent gets them when it next waits\.$/);
    // A send leaves the focus in the general comment; the picture is about the status.
    await part(page, 'note').blur();
    await page.mouse.move(5, 5);

    await part(page, 'bar').screenshot({ path: join(HERE, name), animations: 'disabled' });
    console.log(`wrote ${relative(ROOT, join(HERE, name))}`);
  });
}

// The four icons of the extension, as the toolbar shows them, on a light and on a dark ground.
async function icons(name) {
  const sizes = [16, 32, 48, 128];
  const source = size => `data:image/png;base64,${readFileSync(join(ROOT, 'extension', 'icons', `icon-${size}.png`)).toString('base64')}`;
  const row = (ground, ink, heading) => `
    <section style="background:${ground};color:${ink}">
      <h2>${heading}</h2>
      <div class="icons">${sizes.map(size => `
        <figure><img src="${source(size)}" style="width:${size}px;height:${size}px"><figcaption>${size} px</figcaption></figure>`).join('')}
      </div>
    </section>`;
  const html = `<!doctype html><html><head><style>
    body { margin: 0; font: 13px/1.4 system-ui, sans-serif; }
    section { padding: 20px 28px 18px; }
    h2 { margin: 0 0 14px; font-size: 13px; font-weight: 600; }
    .icons { display: flex; align-items: flex-end; gap: 36px; }
    figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
    img { image-rendering: pixelated; display: block; }
  </style></head><body id="sheet" style="display:inline-block">
    ${row('#F1F3F4', '#202124', 'On a light toolbar (#F1F3F4), each pixel shown 2x2')}
    ${row('#202124', '#E8EAED', 'On a dark toolbar (#202124), each pixel shown 2x2')}
  </body></html>`;
  const session = await launch({ folder: HERE, page: 'demo.html', browser: { viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 } });
  try {
    await session.page.setContent(html);
    await session.page.locator('#sheet').screenshot({ path: join(HERE, name) });
    console.log(`wrote ${relative(ROOT, join(HERE, name))}`);
  } finally {
    await session.close();
  }
}

// The three annotations of the README's scene and its general comment: a Change on the trial
// button, a Question on the row of feature cards and a Change on Sign in.
async function threeAnnotations(page) {
  await annotate(page, '#trial', 'Make this the primary button and a little larger');
  await annotateRow(page, 'Why three cards? Is a fourth feature planned?');
  await annotate(page, '#sign-in', 'Make Sign in easier to see');
  await part(page, 'note').fill('Keep the colours and the spacing. This round is about wording and hierarchy.');
}

// Annotates the row of feature cards as a whole, as a Question: a pick in the gap between
// the first two cards, where no card is.
async function annotateRow(page, comment) {
  const first = await page.locator('#features > .card').first().boundingBox();
  await page.mouse.click(first.x + first.width + 12, first.y + first.height / 2);
  await expect(part(page, 'popup-label')).toHaveText(/^div /);
  await part(page, 'intent-question').click();
  await part(page, 'comment').fill(comment);
  await part(page, 'comment').press('ControlOrMeta+Enter');
  await expect(part(page, 'popup')).toBeHidden();
}
