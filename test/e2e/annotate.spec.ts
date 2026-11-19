import { expect, test } from '@playwright/test';
import type { BrowserContext, ConsoleMessage, Page, Worker } from '@playwright/test';
import {
  activate, annotate, hoverAt, launch, part, pickAt, reactivate, standIn, stubBridge,
} from './helpers.ts';
import type { BridgeStub, Session } from './helpers.ts';

// One page for the whole file; each test builds on the state the previous one left.
test.describe.configure({ mode: 'serial' });

let session: Session;
let context: BrowserContext;
let page: Page;
let sw: Worker;

// No bridge runs: every request is answered at once, so no test here waits on a real
// request to the test port. roundtrip.spec.ts covers the refused connection itself.
const DOWN = { ok: false, kind: 'bridge_down', message: '' };
const NO_BRIDGE: BridgeStub = { agents: { reply: DOWN }, send: { reply: DOWN }, copy: { reply: DOWN }, state: { reply: DOWN } };

test.beforeAll(async () => {
  session = await launch();
  ({ context, page, sw } = session);
  await stubBridge(sw, NO_BRIDGE);
});

test.afterAll(async () => {
  await session?.close();
});

test('turning on shows the bar in pick mode', async () => {
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeVisible();
  await expect(part(page, 'pick-toggle')).toHaveAttribute('aria-pressed', 'true');
});

// How many lines of its own text the general comment field shows: the height inside its padding
// and its border, in its line height. Layout keeps sizes in sixty-fourths of a pixel, so four
// lines can come out a fraction of such a unit short.
async function noteLines(): Promise<number> {
  const { inner, line } = await part(page, 'note').evaluate(el => {
    const style = getComputedStyle(el);
    const px = (value: string) => Number.parseFloat(value);
    return {
      inner: el.getBoundingClientRect().height - px(style.paddingTop) - px(style.paddingBottom)
        - px(style.borderTopWidth) - px(style.borderBottomWidth),
      line: px(style.lineHeight),
    };
  });
  expect(line).toBeGreaterThan(0);
  return (inner + 1 / 64) / line;
}

test('the general comment field is four lines high', async () => {
  expect(await noteLines()).toBeGreaterThanOrEqual(4);
});

test('the general comment field is four lines high also in a short window', async () => {
  await page.setViewportSize({ width: 1280, height: 300 });
  try {
    await expect.poll(noteLines).toBeGreaterThanOrEqual(4);
    const bar = (await part(page, 'bar').boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(0);
    expect(bar.y + bar.height).toBeLessThanOrEqual(300);
    // The header is reachable: its collapse button takes a click, and a second one opens the bar
    // again.
    const collapse = part(page, 'collapse');
    const header = (await collapse.boundingBox())!;
    expect(header.y).toBeGreaterThanOrEqual(0);
    await collapse.click();
    await expect(collapse).toHaveAttribute('aria-expanded', 'false');
    await collapse.click();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

// A drag of the field's corner sets its height in its style. The window is 720 pixels high.
test('the general comment field stays four lines high when it is dragged smaller, and grows to a quarter of the window', async () => {
  const note = part(page, 'note');
  try {
    await note.evaluate((el: HTMLElement) => { el.style.height = '20px'; });
    expect(await noteLines()).toBeGreaterThanOrEqual(4);
    await note.evaluate((el: HTMLElement) => { el.style.height = '1000px'; });
    expect(Math.abs((await note.boundingBox())!.height - 720 / 4)).toBeLessThanOrEqual(1 / 64);
  } finally {
    await note.evaluate((el: HTMLElement) => { el.style.height = ''; });
  }
});

test('hover highlights and a click opens the popup without following the link', async () => {
  await hoverAt(page, '#link');
  await expect(part(page, 'highlight')).toBeVisible();
  await pickAt(page, '#link');
  await expect(page).toHaveURL(/page\.html$/);
  await expect(part(page, 'popup-label')).toHaveText(/^a "Other" \d+x\d+$/);
  await expect(part(page, 'intent-change')).toHaveAttribute('aria-pressed', 'true');
  // The browser runs on the same machine as this test, so it reports the same system.
  await expect(part(page, 'add').locator('.kbd')).toHaveText(process.platform === 'darwin' ? '⌘↵' : 'Ctrl+↵');
});

test('⌘↵ adds the annotation with a marker and a list row', async () => {
  await part(page, 'comment').fill('Make this the primary action');
  await part(page, 'comment').press('Meta+Enter');
  await expect(part(page, 'popup')).toBeHidden();
  await expect(part(page, 'marker')).toHaveText('1');
  await expect(part(page, 'count')).toHaveText('1');
  await expect(part(page, 'list-item')).toContainText('Make this the primary action');
});

test('an empty comment cannot be added', async () => {
  await pickAt(page, '#cta');
  await expect(part(page, 'add')).toBeDisabled();
  await part(page, 'cancel').click();
});

test('one element can carry two annotations', async () => {
  await annotate(page, '#cta', 'First');
  await annotate(page, '#cta', 'Second');
  await expect(part(page, 'list-item')).toHaveCount(3);
  await expect(part(page, 'marker')).toHaveText(['1', '2', '3']);
});

test('a marker reopens the popup to edit, and delete renumbers', async () => {
  await part(page, 'marker').nth(1).click();
  await expect(part(page, 'comment')).toHaveValue('First');
  await part(page, 'delete').click();
  await expect(part(page, 'marker')).toHaveText(['1', '2']);
});

// Focus starts in the comment and goes on from there, so Shift+Tab from the comment never lands on
// Delete, which deletes without asking. On the screen Delete comes after the switch too, in one row
// with Cancel and Save.
test('in the edit popup the Tab order is the comment, the switch, Delete, Cancel, Save', async () => {
  await part(page, 'marker').first().click();
  await expect(part(page, 'add')).toHaveText(/^Save/);
  await expect(part(page, 'comment')).toBeFocused();
  for (const name of ['intent-change', 'intent-question', 'delete', 'cancel', 'add']) {
    await page.keyboard.press('Tab');
    await expect(part(page, name)).toBeFocused();
  }
  const [question, remove, cancel, save] = await Promise.all(
    ['intent-question', 'delete', 'cancel', 'add'].map(async name => (await part(page, name).boundingBox())!));
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
  expect(remove.x > question.x + question.width || remove.y >= question.y + question.height).toBe(true);
  expect(remove.x + remove.width).toBeLessThanOrEqual(cancel.x);
  expect(cancel.x + cancel.width).toBeLessThanOrEqual(save.x);
  expect(Math.abs(middle(remove) - middle(cancel))).toBeLessThanOrEqual(1);
  expect(Math.abs(middle(cancel) - middle(save))).toBeLessThanOrEqual(1);
  await part(page, 'cancel').click();
  await expect(part(page, 'popup')).toBeHidden();
});

test('Esc leaves pick mode so the page works again', async () => {
  await page.keyboard.press('Escape');
  await expect(part(page, 'pick-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.click('#menu-button');
  await expect(page.locator('#menu')).toBeVisible();
});

test('the bar collapses', async () => {
  await part(page, 'collapse').click();
  await expect(part(page, 'list')).toBeHidden();
  await part(page, 'collapse').click();
});

test('shadow root elements and iframes can be picked', async () => {
  await part(page, 'pick-toggle').click();
  await pickAt(page, '#host button');
  await expect(part(page, 'popup-label')).toHaveText(/^button /);
  await part(page, 'cancel').click();
  await pickAt(page, '#frame');
  await expect(part(page, 'popup-label')).toHaveText(/^iframe /);
  await part(page, 'cancel').click();
});

test('annotations survive a reload, and a vanished element is marked', async () => {
  // The shadow button's selector crosses the shadow root; after the reload it must lead back.
  await annotate(page, '#host button', 'Inside the widget');
  await page.evaluate(() => sessionStorage.setItem('remove', '#link'));
  await page.reload();
  await expect(part(page, 'bar')).toHaveCount(0);            // not on by itself
  await activate(sw, page);
  await expect(part(page, 'list-item')).toHaveCount(3);
  await expect(part(page, 'not-found')).toHaveCount(1);
  await expect(part(page, 'marker')).toHaveCount(2);
  // #link (1) is gone; #cta (2) and the shadow button (3) are found again.
  await expect(part(page, 'list-item').nth(0).locator('[data-clicknote="not-found"]')).toHaveCount(1);
  await expect(part(page, 'marker')).toHaveText(['2', '3']);
  // The vanished element's row shows the crop taken at Add.
  await expect(part(page, 'list-item').nth(0).locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
});

test('markers follow their element when the page scrolls', async () => {
  await page.evaluate(() => { document.body.style.paddingBottom = '2000px'; });
  // Lets the redraw for that change pass first, so only the scroll can move the markers.
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  const before = await part(page, 'marker').first().boundingBox();
  await page.evaluate(() => window.scrollBy(0, 100));
  await expect.poll(async () => (await part(page, 'marker').first().boundingBox())?.y).toBeCloseTo(before!.y - 100, 0);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.body.style.paddingBottom = '';
  });
});

test('typing in the popup does not reach the page', async () => {
  await page.evaluate(() => {
    const counter = window as unknown as { keysSeen: number };
    counter.keysSeen = 0;
    document.addEventListener('keydown', () => { counter.keysSeen += 1; });
  });
  await pickAt(page, '#cta');
  await expect(part(page, 'comment')).toBeFocused();     // the popup opens once the crop is taken
  await part(page, 'comment').pressSequentially('abc');
  expect(await page.evaluate(() => (window as unknown as { keysSeen: number }).keysSeen)).toBe(0);
  await part(page, 'cancel').click();
});

// Makes reading the markup of the element at `selector` fail, or work again. Only in the
// world of the content script, which the page's own script cannot reach.
async function breakMarkup(selector: string, broken: boolean): Promise<void> {
  await sw.evaluate(async ({ selector, broken }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      args: [selector, broken],
      func: (selector: string, broken: boolean) => {
        const el = document.querySelector(selector)!;
        if (broken) Object.defineProperty(el, 'outerHTML', { configurable: true, get() { throw new Error('No markup'); } });
        else delete (el as { outerHTML?: string }).outerHTML;
      },
    });
  }, { selector, broken });
}

test('a pick that cannot describe its element is dropped, and the next pick works', async () => {
  const broken = '#features .card:last-child h3';
  const warnings: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'warning') warnings.push(message.text());
  };
  page.on('console', onConsole);
  await breakMarkup(broken, true);
  await pickAt(page, broken);
  await expect.poll(() => warnings).toContainEqual(expect.stringMatching(/^\[clicknote\] Picking failed: .*No markup/));
  await expect(part(page, 'popup')).toBeHidden();
  await pickAt(page, '#cta');
  await expect(part(page, 'popup')).toBeVisible();
  await expect(part(page, 'popup-label')).toHaveText(/^button "Get started" /);
  await part(page, 'cancel').click();
  page.off('console', onConsole);
  await breakMarkup(broken, false);
});

test('turning off hides the UI and frees the page; turning on brings it back in pick mode', async () => {
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeHidden();
  await page.click('#menu-button');
  await expect(page.locator('#menu')).toBeVisible();
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeVisible();
  await expect(part(page, 'pick-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(part(page, 'list-item')).toHaveCount(3);
});

test('a second injection replaces the first instead of adding a second UI', async () => {
  await page.bringToFront();
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    for (const _ of [1, 2]) await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
  });
  await expect(page.locator('clicknote-ui')).toHaveCount(1);
  await expect(part(page, 'list-item')).toHaveCount(3);
  await activate(sw, page);
  await expect(part(page, 'bar')).toBeHidden();
});

// A page that animates: every frame changes the DOM and scrolls, so every frame runs the
// redraw that keeps the bar inside the window.
async function animate(frames: number): Promise<void> {
  await page.evaluate(frames => new Promise<void>(done => {
    const target = document.querySelector('#features')!;
    const step = (left: number) => {
      if (left === 0) return done();
      target.setAttribute('data-frame', String(left));
      window.dispatchEvent(new Event('scroll'));
      requestAnimationFrame(() => step(left - 1));
    };
    step(frames);
  }), frames);
}

// Waits until the bar has its full height. The crop in the first row and the status line come
// after the bar is shown or injected, and the bar grows upwards when either arrives, so a
// measurement taken before would see it move.
async function settled(): Promise<void> {
  const crop = part(page, 'list-item').first().locator('img');
  await expect.poll(() => crop.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(part(page, 'status')).toBeVisible();
}

// A regression test: the bar crept along on such a page, a fraction of a pixel per frame,
// when its height had a fraction that offsetHeight rounds away.
// With three annotations, the crop of one, and a status line that offers a sentence, the bar is
// some 650 pixels high, so the window here is 1000 pixels high: the bar has room to be dragged up.
test('the bar stays where it is while the page animates, also after a drag', async () => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  try {
    await activate(sw, page);
    const bar = part(page, 'bar');
    await expect(bar).toBeVisible();
    await settled();                                              // this bar was injected by the test before
    const box = async () => (await bar.boundingBox())!;
    const staysPut = async () => {
      const before = await box();
      expect(before.height % 1).not.toBe(0);
      await animate(200);
      const after = await box();
      expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.01);
    };
    await staysPut();                                             // at the bottom right, as it starts
    const handle = (await part(page, 'count').boundingBox())!;    // in the header, not a button
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 300, handle.y - 150, { steps: 4 });
    await page.mouse.up();
    const dragged = await box();
    expect(dragged.y).toBeLessThan(handle.y - 100);             // dragged away from the corner
    // Clear of the top edge too: a bar pushed against it would be moved back in as it grows below.
    expect(dragged.y).toBeGreaterThan(1);
    await staysPut();
    // A little taller, with a fraction that offsetHeight rounds the other way: a quarter when it
    // rounded up, three quarters when it rounded down.
    await bar.evaluate((el: HTMLElement) => {
      const height = el.getBoundingClientRect().height;
      el.style.minHeight = `${Math.floor(height) + 1 + (height % 1 < 0.5 ? 0.75 : 0.25)}px`;
    });
    await staysPut();
    await bar.evaluate((el: HTMLElement) => { el.style.minHeight = ''; });
    await activate(sw, page);
    await expect(bar).toBeHidden();
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

// It adds annotations, moves the bar and changes the window size; the tests after it build on
// the six annotations it leaves.
test('the bar stays inside the window as its list grows and the window shrinks', async () => {
  const top = async () => (await part(page, 'bar').boundingBox())!.y;
  const bottom = async () => {
    const box = (await part(page, 'bar').boundingBox())!;
    return box.y + box.height;
  };
  await activate(sw, page);
  const handle = (await part(page, 'count').boundingBox())!;      // in the header, not a button
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, 0, { steps: 4 });
  await page.mouse.up();
  expect(await top()).toBeLessThan(1);                            // dragged to the top edge
  for (const selector of ['#cta', '#menu-button', '#features h3']) await annotate(page, selector, `Grow ${selector}`);
  await expect(part(page, 'list-item')).toHaveCount(6);
  await expect.poll(top).toBeGreaterThanOrEqual(0);
  await page.setViewportSize({ width: 1280, height: 400 });
  await expect.poll(top).toBeGreaterThanOrEqual(0);
  await expect.poll(bottom).toBeLessThanOrEqual(400);
  await page.setViewportSize({ width: 1280, height: 720 });
});

// Whether the whole box of the part lies within a window `height` pixels high.
async function withinHeight(name: string, height: number): Promise<boolean> {
  const box = await part(page, name).boundingBox();
  return box !== null && box.y >= 0 && box.y + box.height <= height;
}

// The list gives way: it scrolls inside the bar, and the header, the general comment, the
// dropdown and Send stay where the user can reach them. The bar cuts off what does not fit in it,
// so Send has to lie within the bar as well as within the window. The list keeps room for a whole
// row of one line: scrolled to the second row, it shows all of it. The first row is the one whose
// element vanished, with its crop, higher than all the room this window leaves the list.
test('in a window lower than the bar the list scrolls and Send stays within the window', async () => {
  await expect(part(page, 'list-item')).toHaveCount(6);
  await page.setViewportSize({ width: 1280, height: 360 });
  try {
    for (const name of ['count', 'note', 'agent-select', 'send']) await expect.poll(() => withinHeight(name, 360)).toBe(true);
    const bar = (await part(page, 'bar').boundingBox())!;
    const send = (await part(page, 'send').boundingBox())!;
    expect(send.y).toBeGreaterThanOrEqual(bar.y);
    expect(send.y + send.height).toBeLessThanOrEqual(bar.y + bar.height);
    const list = await part(page, 'list').evaluate(el => {
      const row = el.children[1];
      const top = () => row.getBoundingClientRect().top - el.getBoundingClientRect().top;
      el.scrollTop += top() - Number.parseFloat(getComputedStyle(el).paddingTop);
      const whole = top() >= 0 && row.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom;
      const scrolled = el.scrollTop;
      el.scrollTop = 0;
      return { scroll: el.scrollHeight, height: el.clientHeight, row: row.textContent, scrolled, whole };
    });
    expect(list.scroll).toBeGreaterThan(list.height);
    expect(list.row).toBe('2SecondChange');
    expect(list.scrolled).toBeGreaterThan(0);
    expect(list.whole).toBe(true);
  } finally {
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

// The mode follows the system: a white bar in light mode, a dark grey one in dark mode.
test('the bar is dark when the system is dark', async () => {
  const ground = () => part(page, 'bar').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await ground()).toBe('rgb(255, 255, 255)');
  await page.emulateMedia({ colorScheme: 'dark' });
  try {
    expect(await ground()).toBe('rgb(31, 31, 38)');
  } finally {
    await page.emulateMedia({ colorScheme: 'light' });
  }
  expect(await ground()).toBe('rgb(255, 255, 255)');
});

// The colours are custom properties on the UI's element, which the page's rules reach too. Their
// names have a prefix of their own, and they win over the page's even under that name.
test('a page that sets its own --text and --surface on every element does not recolour the bar', async () => {
  const look = () => part(page, 'bar').evaluate(el => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.color];
  });
  expect(await look()).toEqual(['rgb(255, 255, 255)', 'rgb(27, 27, 31)']);
  const style = await page.addStyleTag({
    content: '* { --text: red; --surface: red; --cn-text: red !important; --cn-surface: red !important; }',
  });
  try {
    expect(await page.locator('clicknote-ui').evaluate(el => getComputedStyle(el).getPropertyValue('--text'))).toBe('red');
    expect(await look()).toEqual(['rgb(255, 255, 255)', 'rgb(27, 27, 31)']);
  } finally {
    await style.evaluate(el => (el as Element).remove());
  }
});

// A marker is a white disc with a dark outline and a hard shadow to its lower right: green for a
// Change, lilac for a Question. It sits on the page, so it looks the same on a dark system. The
// outline's width is left out: Chrome draws it in whole device pixels.
test('a marker of a Change and one of a Question differ by their shadow\'s colour and are the same in dark mode', async () => {
  await annotate(page, '#features h3', 'Why three?', 'question');
  const marker = (number: number) => page.locator(`[data-clicknote="marker"][aria-label^="Annotation ${number}:"]`);
  const looks = () => Promise.all([marker(6), marker(7)].map(locator => locator.evaluate(el => {
    const style = getComputedStyle(el);
    return {
      shadow: style.boxShadow, ground: style.backgroundColor, ink: style.color,
      outline: `${style.borderTopStyle} ${style.borderTopColor}`, width: style.width,
    };
  })));
  const light = await looks();
  const disc = { ground: 'rgb(255, 255, 255)', ink: 'rgb(27, 27, 31)', outline: 'solid rgb(27, 27, 31)', width: '26px' };
  expect(light).toEqual([
    { ...disc, shadow: 'rgb(185, 242, 124) 3px 3px 0px 0px' },        // 6, a Change
    { ...disc, shadow: 'rgb(169, 181, 255) 3px 3px 0px 0px' },        // 7, a Question
  ]);
  await page.emulateMedia({ colorScheme: 'dark' });
  try {
    expect(await looks()).toEqual(light);
  } finally {
    await page.emulateMedia({ colorScheme: 'light' });
  }
});

// The size of a copy of the first marker and of the first badge, put next to it, with `number`
// for its text: [width, height] of each.
function discs(number: string): Promise<number[][]> {
  return page.locator('clicknote-ui').evaluate((host, text) => ['.marker', '.badge'].map(selector => {
    const original = host.shadowRoot!.querySelector(selector)!;
    const copy = original.cloneNode(true) as HTMLElement;
    copy.textContent = text;
    original.after(copy);
    const { width, height } = copy.getBoundingClientRect();
    copy.remove();
    return [width, height];
  }), number);
}

test('a marker and a badge stay round up to 99 and widen from 100', async () => {
  const round = [[26, 26], [24, 24]];
  expect(await discs('8')).toEqual(round);
  expect(await discs('99')).toEqual(round);
  const [marker, badge] = await discs('100');
  expect(marker[0]).toBeGreaterThan(26);
  expect(badge[0]).toBeGreaterThan(24);
});

// A marker sits on the page and looks the same in both modes, and so does its focus ring: the
// light mode's, which stands out against a white page and against the marker's dark outline.
test('a focused marker has the same ring in dark mode as in light mode', async () => {
  const marker = part(page, 'marker').first();
  await page.keyboard.press('Shift');
  await marker.focus();
  const ring = () => marker.evaluate(el => {
    const style = getComputedStyle(el);
    return [el.matches(':focus-visible'), `${style.outlineStyle} ${style.outlineColor}`];
  });
  expect(await ring()).toEqual([true, 'solid rgb(108, 116, 232)']);
  await page.emulateMedia({ colorScheme: 'dark' });
  try {
    expect(await ring()).toEqual([true, 'solid rgb(108, 116, 232)']);
  } finally {
    await page.emulateMedia({ colorScheme: 'light' });
    await marker.blur();
  }
});

// A picture of a strip of the dropdown as the user sees it, `width` pixels wide, from `from`
// pixels after its left edge, or before its right edge when `from` is negative. Only the band of
// its text, 20 pixels high: the edges of the rounded ends come out a shade apart from one picture
// to the next.
async function dropdownStrip(from: number, width: number): Promise<Buffer> {
  const box = (await part(page, 'agent-select').boundingBox())!;
  const x = from >= 0 ? box.x + from : box.x + box.width + from;
  return page.screenshot({ clip: { x, y: box.y + (box.height - 20) / 2, width, height: 20 }, animations: 'disabled' });
}

// Each part of a label can have 60 characters. Compared with a short entry, a long one shows the
// same dot at its start and leaves the arrow at the end as it is: the text is cut before it.
test('a long entry of the dropdown is cut at its end and keeps its dot', async () => {
  const short = standIn({ id: 't1', about: 'copy', harness: 'codex' });
  const long = standIn({ id: 't8', folder: 'f'.repeat(60), about: 'a'.repeat(60), harness: 'h'.repeat(60) });
  await page.mouse.move(0, 0);
  // Lists this agent alone; the status line about the bridge that was down goes.
  const strips = async (agent: typeof short) => {
    await stubBridge(sw, { ...NO_BRIDGE, agents: { reply: { ok: true, agents: [agent], preselect: null } } });
    await reactivate(sw, page);
    await expect(part(page, 'agent-select')).toHaveValue(agent.id);
    await expect(part(page, 'status')).toBeHidden();
    return { dot: await dropdownStrip(10, 14), beforeArrow: await dropdownStrip(-56, 24), arrow: await dropdownStrip(-30, 22) };
  };
  try {
    const shortStrips = await strips(short);
    const longStrips = await strips(long);
    expect(longStrips.dot.equals(shortStrips.dot)).toBe(true);
    expect(longStrips.arrow.equals(shortStrips.arrow)).toBe(true);
    // The long entry runs on up to where it is cut; the short one ends well before.
    expect(longStrips.beforeArrow.equals(shortStrips.beforeArrow)).toBe(false);
  } finally {
    await stubBridge(sw, NO_BRIDGE);
  }
});

test('a page that cannot be entered gets a badge and a title that says why', async () => {
  const p = await context.newPage();
  await p.goto('chrome://version');
  await activate(sw, p);
  expect(await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return [await chrome.action.getBadgeText({ tabId: tab.id }), await chrome.action.getTitle({ tabId: tab.id })];
  })).toEqual(['!', 'Cannot annotate this page. For file:// pages, switch on "Allow access to file URLs" for this extension.']);
});
