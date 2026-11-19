import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  domPath, findBySelector, labelFor, snapshot, truncate, uniqueSelector,
} from '../../extension/src/content/describe.ts';
import { STYLE_PROPS } from '../../shared/types.ts';
import type { Rect } from '../../shared/types.ts';

// Ids that need escaping in a selector: a leading digit, a leading dash and digit, CSS
// punctuation, a lone dash, and a non-ASCII letter.
const AWKWARD_IDS = ['1st', '-2nd', 'a.b:c', '-', 'naïve'];

const dom = new JSDOM(`<!doctype html>
<html>
<head><title>Describe fixture</title></head>
<body>
  <header>
    <img src="data:," alt="Logo">
    <button id="cta">Get started</button>
  </header>
  <main>
    <section id="features">
      <h2>Features</h2>
      <div class="card"><h3>Fast</h3><p>Pick in one click.</p></div>
      <div class="card"><h3>Exact</h3><p>One selector, one element.</p></div>
      <div class="card"><h3>Readable</h3><p>A path you can follow.</p></div>
    </section>
    <p id="long">${'a'.repeat(60)}</p>
    <div id="spaced">
      one
        two\tthree
    </div>
    <div class="md:flex gap-2"><span>left</span><span>right</span></div>
    <ul>${AWKWARD_IDS.map((id) => `<li id="${id}">${id}</li>`).join('')}</ul>
  </main>
  <footer>
    <p id="dup">one</p>
    <p id="dup">two</p>
  </footer>
  <div id="huge">${'lorem ipsum '.repeat(300)}</div>
  <x-widget id="host"></x-widget>
</body>
</html>`);

const { document } = dom.window;

// #host holds a button and a nested host; the nested root has a `p > span` at its top
// level and another one deeper down.
const hostRoot = byId('host').attachShadow({ mode: 'open' });
hostRoot.innerHTML = '<button>Inside</button><div class="panel"></div>';
const panelRoot = el('.panel', hostRoot).attachShadow({ mode: 'open' });
panelRoot.innerHTML = '<section><p><span>deep</span></p></section><p><span>top</span></p>';

// The browser globals describe.ts uses, taken from the jsdom window for these tests.
const globals = {
  document,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  CSS: dom.window.CSS,
  ShadowRoot: dom.window.ShadowRoot,
};
before(() => Object.assign(globalThis, globals));
after(() => {
  for (const name of Object.keys(globals)) Reflect.deleteProperty(globalThis, name);
  dom.window.close();
});

const R: Rect = { x: 0, y: 0, width: 10, height: 10 };

function el(selector: string, root: ParentNode = document): Element {
  const found = root.querySelector(selector);
  assert.ok(found, `no element for ${selector}`);
  return found;
}

function all(selector: string): Element[] {
  return Array.from(document.querySelectorAll(selector));
}

function byId(id: string): Element {
  const found = document.getElementById(id);
  assert.ok(found, `no element with id ${id}`);
  return found;
}

test('truncate keeps short text and cuts long text to the limit, ellipsis included', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('abcdef', 6), 'abcdef');
  assert.equal(truncate('abcdefg', 6), 'abcde…');
  assert.equal(truncate('ab😀cd', 4), 'ab…');                                   // no half emoji
});

test('labelFor: tag, start of the text, size', () => {
  assert.equal(labelFor(el('#cta'), { x: 0, y: 0, width: 120.4, height: 39.6 }), 'button "Get started" 120x40');
  assert.equal(labelFor(el('#long'), R), `p "${'a'.repeat(40)}…" 10x10`);
  assert.equal(labelFor(el('img'), R), 'img 10x10');
  assert.equal(labelFor(el('#spaced'), R), 'div "one two three" 10x10');   // whitespace collapsed
});

test('labelFor and snapshot use the rendered text when the browser provides it', () => {
  const button = document.createElement('button');
  button.textContent = 'Get started';
  Object.defineProperty(button, 'innerText', { value: 'GET\nSTARTED' });       // text-transform: uppercase
  assert.equal(labelFor(button, R), 'button "GET STARTED" 10x10');
  assert.equal(snapshot(button, R).text, 'GET\nSTARTED');
});

test('uniqueSelector returns exactly the element', () => {
  for (const target of all('body *')) {
    const s = uniqueSelector(target);
    assert.equal(document.querySelectorAll(s).length, 1, s);
    assert.equal(document.querySelector(s), target, s);
  }
});

test('uniqueSelector prefers a unique id and survives awkward names', () => {
  assert.equal(uniqueSelector(el('#cta')), '#cta');
  assert.equal(findBySelector(uniqueSelector(byId('1st'))), byId('1st'));        // id starts with a digit
  assert.equal(findBySelector(uniqueSelector(el('[class~="md:flex"]'))), el('[class~="md:flex"]'));
  const dupes = all('[id="dup"]');                                              // two elements share an id
  assert.equal(findBySelector(uniqueSelector(dupes[1])), dupes[1]);
});

test('uniqueSelector escapes ids the same way without CSS.escape', () => {
  const targets = AWKWARD_IDS.map(byId);
  const withCssEscape = targets.map(uniqueSelector);
  assert.deepEqual(withCssEscape, ['#\\31 st', '#-\\32 nd', '#a\\.b\\:c', '#\\-', '#naïve']);
  Reflect.deleteProperty(globalThis, 'CSS');
  try {
    assert.deepEqual(targets.map(uniqueSelector), withCssEscape);
  } finally {
    Object.assign(globalThis, { CSS: globals.CSS });
  }
  targets.forEach((target, i) => assert.equal(findBySelector(withCssEscape[i]), target));
});

test('elements in an open shadow root use " >> " and are found again', () => {
  const inner = el('#host').shadowRoot!.querySelector('button')!;
  assert.match(uniqueSelector(inner), /^#host >> /);
  assert.equal(findBySelector(uniqueSelector(inner)), inner);
});

test('nested shadow roots repeat " >> " and every element in them is found again', () => {
  const top = panelRoot.lastElementChild!.firstElementChild!;
  assert.equal(top.textContent, 'top');
  // `p > span` alone would also match the deeper span, so the first step is pinned to the top.
  assert.equal(uniqueSelector(top), '#host >> div >> p:not(* > *) > span');
  for (const root of [hostRoot, panelRoot]) {
    for (const target of root.querySelectorAll('*')) {
      assert.equal(findBySelector(uniqueSelector(target)), target, uniqueSelector(target));
    }
  }
});

test('findBySelector returns null for a missing element or a bad selector', () => {
  assert.equal(findBySelector('#gone'), null);
  assert.equal(findBySelector('###'), null);
  assert.equal(findBySelector('#cta >> button'), null);                         // #cta has no shadow root
});

test('domPath is readable, with positions only among same-tag siblings', () => {
  assert.equal(domPath(el('#features .card:nth-of-type(2) h3')),
    'body > main > section#features > div.card (2 of 3) > h3');
  assert.match(domPath(el('#host').shadowRoot!.querySelector('button')!), / > x-widget#host > #shadow-root > button$/);
});

test('snapshot shortens text and html and collects the fixed styles', () => {
  const s = snapshot(el('#huge'), R);
  assert.equal(s.text.length, 500);  assert.equal(s.text.endsWith('…'), true);
  assert.equal(s.html.length, 2000); assert.equal(s.html.endsWith('…'), true);
  assert.deepEqual(Object.keys(s.styles), [...STYLE_PROPS]);
});

test('snapshot combines the descriptions and keeps a plain rect', () => {
  const domRect = { x: 1, y: 2, width: 120, height: 40, top: 2, left: 1, bottom: 42, right: 121 };
  const s = snapshot(el('#cta'), domRect);
  assert.equal(s.label, 'button "Get started" 120x40');
  assert.equal(s.selector, '#cta');
  assert.equal(s.domPath, 'body > header > button#cta');
  assert.equal(s.text, 'Get started');
  assert.equal(s.html, '<button id="cta">Get started</button>');
  assert.deepEqual(s.rect, { x: 1, y: 2, width: 120, height: 40 });
  const spaced = snapshot(el('#spaced'), R);
  assert.equal(spaced.text, 'one\ntwo three');                                  // lines kept, indentation dropped
  assert.equal(spaced.styles.display, 'block');
});
