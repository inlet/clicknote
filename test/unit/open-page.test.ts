import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { expiredPage, openPage, pageHeaders } from '../../bridge/src/open-page.ts';

const LABEL = 'site / 1 · claude-code · t8s';
const FILE_HELP = 'This page cannot open a local file by itself. The Clicknote extension opens it '
  + 'when "Allow access to file URLs" is switched on for it at chrome://extensions. Switch it on, then ask your agent '
  + 'to open the page again.';
const NO_EXTENSION = 'This page cannot open a local file by itself. The Clicknote extension does that, '
  + 'and it is not in this browser. Install it, then ask your agent to open the page '
  + 'again. Or copy the address below into the address bar.';

// The page as the browser builds it, without running its script.
function parse(html: string): Document {
  return new JSDOM(html).window.document;
}

test('the open page names the page and the agent', () => {
  const url = 'http://localhost:3000/a';
  const document = parse(openPage({ url, label: LABEL }, 'abc'));
  assert.equal(document.title, 'Clicknote');
  const opening = document.getElementById('opening')!;
  const opened = document.getElementById('opened')!;
  assert.equal(opening.textContent, `Opening ${url} for ${LABEL} …`);
  assert.equal(opened.textContent, `This tab was opened for ${LABEL}. The page is ${url}.`);
  for (const block of [opening, opened]) {
    const link = block.querySelector('a')!;
    assert.equal(link.getAttribute('href'), url);
    assert.equal(link.textContent, url);
    assert.equal(link.relList.contains('noreferrer'), true);
  }
  assert.equal(document.body.dataset.target, url);
  assert.equal(document.body.dataset.kind, 'web');
});

test('every page has the title Clicknote', () => {
  const pages = [
    openPage({ url: 'http://localhost:3000/a', label: LABEL }, 'abc'),
    openPage({ url: 'file:///Users/me/site/index.html', label: LABEL }, 'abc'),
    expiredPage(),
  ];
  for (const html of pages) {
    assert.equal(parse(html).title, 'Clicknote');
  }
});

// One help for a browser whose extension does not open the file, one for a browser without the
// extension; the page's script shows at most one of them.
test('a local file gets both help texts and no link', () => {
  for (const url of ['file:///Users/me/site/index.html', 'file:///Users/me/"><b>x</b><script>alert(1)</script>.html']) {
    const document = parse(openPage({ url, label: LABEL }, 'abc'));
    assert.equal(document.body.dataset.kind, 'file');
    for (const [id, text] of [['file-help', FILE_HELP], ['no-extension', NO_EXTENSION]]) {
      const block = document.getElementById(id);
      assert.notEqual(block, null, id);
      assert.equal(block!.hidden, true, id);
      assert.deepEqual([...block!.querySelectorAll('p')].map(paragraph => paragraph.textContent), [text, url], id);
    }
    assert.equal(document.querySelectorAll('a').length, 0);
    assert.equal(document.querySelectorAll('b').length, 0);
    assert.equal(document.querySelectorAll('script').length, 1);
  }
  const web = parse(openPage({ url: 'http://localhost:3000/a', label: LABEL }, 'abc'));
  assert.equal(web.getElementById('file-help'), null);
  assert.equal(web.getElementById('no-extension'), null);
});

test('markup in the URL or the label stays text', () => {
  const url = 'http://localhost:3000/?q="><script>alert(1)</script>';
  const label = `<b>x</b> " '`;
  const document = parse(openPage({ url, label }, 'abc'));
  const scripts = document.querySelectorAll('script');
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].getAttribute('nonce'), 'abc');
  assert.equal(document.querySelectorAll('b').length, 0);
  assert.equal(document.body.dataset.target, url);
  assert.equal(document.getElementById('opening')!.textContent, `Opening ${url} for ${label} …`);
});

test('the script and the style carry the nonce, and the page asks for no icon', () => {
  for (const url of ['http://localhost:3000/a', 'file:///Users/me/site/index.html']) {
    const document = parse(openPage({ url, label: LABEL }, 'abc'));
    const elements = [...document.querySelectorAll('script, style')];
    assert.deepEqual(elements.map(element => element.localName).sort(), ['script', 'style']);
    for (const element of elements) assert.equal(element.getAttribute('nonce'), 'abc', url);
    const icon = document.querySelector('link[rel="icon"]');
    assert.equal(icon?.getAttribute('href'), 'data:,');
  }
});

test('the expired page says what to do', () => {
  const document = parse(expiredPage());
  assert.equal(document.body.textContent!.includes('This link has expired. Ask your agent to open the page again.'), true);
  assert.equal(document.querySelectorAll('script').length, 0);
});

test('the headers keep the page closed', () => {
  assert.deepEqual(pageHeaders('abc'), {
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'nonce-abc'; style-src 'nonce-abc'; img-src data:; "
      + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  const policy = pageHeaders()['content-security-policy'];
  assert.equal(policy.includes('script-src'), false);
  assert.equal(policy.includes('style-src'), false);
});
