// Makes the pictures under docs/readme/ that show the look of the extension:
// - annotating.png, the screenshot under How in the README: the demo page with three
//   annotations, the popup of a fourth being written, and the bar with a waiting agent chosen;
// - look-dark.png: the same in dark mode, where the bar, the popup and the outline are dark and
//   the demo page, which has no dark mode, stays light;
// - look-queued.png: the bar alone after a send of three annotations to an agent that does not
//   wait, so the send is queued and its line is on offer;
// - look-icons.png: the extension's four icons, each at its own size and each pixel shown 2x2, on
//   a light and on a dark toolbar ground;
// - social-preview.png: the repository's social preview, the picture a shared link to it shows,
//   made from the icon and annotating.png. GitHub does not take it from the repository: upload it
//   by hand under Settings, General, Social preview.
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
await socialPreview('social-preview.png');

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

// The social preview, at the 1280 x 640 that GitHub asks for, on the lilac of the icon's tile: on
// the left the icon, the name and the tagline; on the right the README's scene, cut from
// annotating.png, in a window drawn like the one in the icon; and over its corner the icon's
// bubble with the start of the line the agent gets.
async function socialPreview(name) {
  const icon = readFileSync(join(ROOT, 'extension', 'icons', 'icon.svg'), 'utf8');
  const scene = `data:image/png;base64,${readFileSync(join(HERE, 'annotating.png')).toString('base64')}`;
  // The part of annotating.png (2560 x 1600) that the window shows, from its left and top edge,
  // and the scale it is shown at: the popup and the whole bar.
  const cut = { left: 990, top: 560, scale: 0.42 };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body {
      margin: 0; width: 1280px; height: 640px; overflow: hidden; position: relative;
      background: #EEF0FF radial-gradient(#C9CEFF 1.4px, transparent 1.6px) 14px 14px / 28px 28px;
      font-family: system-ui, sans-serif; color: #1B1B1F; -webkit-font-smoothing: antialiased;
    }
    .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-weight: 600; }
    .text { position: absolute; left: 72px; top: 0; bottom: 0; width: 440px; display: flex; flex-direction: column; justify-content: center; }
    .brand { display: flex; align-items: center; gap: 18px; }
    .brand svg { width: 76px; height: 76px; display: block; }
    h1 { margin: 0; font-size: 74px; line-height: 1; font-weight: 800; letter-spacing: -0.035em; }
    .tagline { margin: 34px 0 0; font-size: 33px; line-height: 1.18; font-weight: 700; letter-spacing: -0.015em; }
    .sub { margin: 18px 0 0; font-size: 21px; line-height: 1.4; color: #55555F; }
    .chips { margin-top: 30px; display: flex; gap: 10px; }
    .chip { font-size: 16px; font-weight: 600; padding: 7px 14px; border: 2.5px solid #1B1B1F; border-radius: 999px; background: #FFFFFF; }
    .chip.skill { background: #B9F27C; }
    .window {
      position: absolute; left: 560px; top: 76px; width: 660px; overflow: hidden;
      border: 3px solid #1B1B1F; border-radius: 18px; background: #FFFFFF; box-shadow: 12px 12px 0 #A9B5FF;
    }
    .toolbar { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #A9B5FF; border-bottom: 3px solid #1B1B1F; }
    .dot { width: 11px; height: 11px; border-radius: 50%; background: #1B1B1F; }
    .address { margin-left: 14px; font-size: 14px; padding: 5px 12px; background: #FFFFFF; border: 2px solid #1B1B1F; border-radius: 8px; }
    .scene { height: 436px; position: relative; overflow: hidden; }
    .scene img { position: absolute; width: ${2560 * cut.scale}px; left: ${-cut.left * cut.scale}px; top: ${-cut.top * cut.scale}px; }
    .bubble { position: absolute; left: 470px; top: 512px; }
    .bubble > svg { display: block; overflow: visible; }
    .line { position: absolute; inset: 0; display: flex; align-items: center; gap: 12px; padding: 0 22px; font-size: 17px; white-space: nowrap; }
  </style></head><body>
    <div class="text">
      <div class="brand">${icon}<h1>Clicknote</h1></div>
      <p class="tagline">Feedback on a web page, straight to your coding agent.</p>
      <p class="sub">Click what should change, say how, and send it all in one go.</p>
      <div class="chips"><span class="chip">Chromium extension</span><span class="chip skill">Agent skill</span></div>
    </div>
    <div class="window">
      <div class="toolbar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="address mono">localhost:3000</span></div>
      <div class="scene"><img src="${scene}"></div>
    </div>
    <div class="bubble">
      <svg width="520" height="64"><path d="M16 0H96L118-26L126 0H504A16 16 0 0 1 520 16V48A16 16 0 0 1 504 64H16A16 16 0 0 1 0 48V16A16 16 0 0 1 16 0Z" fill="#FFD08A" stroke="#1B1B1F" stroke-width="3" stroke-linejoin="round"/></svg>
      <div class="line mono">
        <svg width="26" height="20" fill="none" stroke="#1B1B1F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7 7-7 7M15 17h9"/></svg>
        Browser annotations (4) on localhost:3000 …
      </div>
    </div>
  </body></html>`;
  const session = await launch({ folder: HERE, page: 'demo.html', browser: { viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 } });
  try {
    await session.page.setContent(html);
    await session.page.screenshot({ path: join(HERE, name) });
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
