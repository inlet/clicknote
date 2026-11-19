import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../shared/markdown.ts';
import type { Annotation, PageInfo } from '../../shared/types.ts';

const page: PageInfo = {
  url: 'http://localhost:5173/',
  title: 'Home',
  viewport: { width: 1440, height: 900 },
  devicePixelRatio: 2,
  sourceFile: '/Users/me/site/index.html',
};

function annotation(fields: Partial<Annotation>): Annotation {
  return {
    id: 'a1b2c3d4',
    number: 1,
    intent: 'change',
    comment: 'Make the button green.',
    label: 'button "Get started" 120x40',
    selector: '#cta',
    domPath: 'body > main > section#hero > button#cta',
    text: 'Get started',
    html: '<button id="cta">Get started</button>',
    rect: { x: 100, y: 200, width: 120, height: 40 },
    styles: { 'font-size': '16px', color: 'rgb(255, 255, 255)' },
    screenshot: '1.png',
    ...fields,
  };
}

const a1 = annotation({});
const a2 = annotation({
  id: 'e5f6a7b8',
  number: 2,
  intent: 'question',
  comment: 'Why is this grey?',
  label: 'p "Free for teams up to…" 600x24',
  selector: 'main > p.lead',
  domPath: 'body > main > p.lead',
  text: 'Free for teams up to five people.',
  html: '<p class="lead">Free for teams up to five people.</p>',
  rect: { x: 420, y: 300, width: 600, height: 24 },
  screenshot: '2.png',
});

test('renders the page header, the note and each annotation', () => {
  const md = renderMarkdown(page, 'Make it calmer.', [a1, a2]);
  assert.match(md, /^# Browser annotations\n/);
  assert.match(md, /- Page: `Home` \(http:\/\/localhost:5173\/\)/);
  assert.match(md, /- Viewport: 1440x900 at 2x/);
  assert.match(md, /## General comment\n\nMake it calmer\./);
  assert.match(md, /## 1\. Change: `button "Get started" 120x40`/);
  assert.match(md, /## 2\. Question: /);
  assert.match(md, /- Selector: `#cta`/);
  assert.match(md, /- Screenshot: `1\.png`/);
});

test('omits what is absent', () => {
  const md = renderMarkdown({ ...page, sourceFile: null }, '', [{ ...a1, screenshot: null }]);
  assert.doesNotMatch(md, /General comment|Source file|Screenshot/);
});

test('fences are longer than any backtick run inside', () => {
  const md = renderMarkdown(page, '', [{ ...a1, text: 'use ```js here', html: '<code>````</code>' }]);
  assert.match(md, /\n````\nuse ```js here\n````\n/);
  assert.match(md, /\n`````html\n<code>````<\/code>\n`````\n/);
});

test('renders the exact layout', () => {
  assert.equal(renderMarkdown(page, 'Make it calmer.', [a1]), [
    '# Browser annotations',
    '',
    '- Page: `Home` (http://localhost:5173/)',
    '- Source file: `/Users/me/site/index.html`',
    '- Viewport: 1440x900 at 2x',
    '- Annotations: 1',
    '',
    '## General comment',
    '',
    'Make it calmer.',
    '',
    '## 1. Change: `button "Get started" 120x40`',
    '',
    'Make the button green.',
    '',
    '- ID: `a1b2c3d4`',
    '- Selector: `#cta`',
    '- DOM path: `body > main > section#hero > button#cta`',
    '- Position: x 100, y 200, 120x40',
    '- Screenshot: `1.png`',
    '- Styles: `font-size: 16px; color: rgb(255, 255, 255)`',
    '',
    'Text:',
    '',
    '```',
    'Get started',
    '```',
    '',
    'HTML:',
    '',
    '```html',
    '<button id="cta">Get started</button>',
    '```',
    '',
  ].join('\n'));
});

test('rounds the position and size to whole pixels', () => {
  const rect = { x: 242.65625, y: 72, width: 202.671875, height: 83.515625 };
  assert.match(renderMarkdown(page, '', [{ ...a1, rect }]), /\n- Position: x 243, y 72, 203x84\n/);
});

test('separates annotations with one blank line and counts them', () => {
  const md = renderMarkdown(page, '', [a1, a2]);
  assert.match(md, /- Annotations: 2\n/);
  assert.match(md, /\n```\n\n## 2\. Question: `p "Free for teams up to…" 600x24`\n\nWhy is this grey\?\n/);
});

test('omits the Text block when the text is empty', () => {
  const md = renderMarkdown(page, '', [{ ...a1, text: '' }]);
  assert.doesNotMatch(md, /Text:/);
  assert.match(md, /- Styles: .*\n\nHTML:\n\n```html\n/);
});

test('a selector that steps into a shadow root gets a note on what >> means', () => {
  const md = renderMarkdown(page, '', [{ ...a1, selector: 'x-widget#host >> button' }]);
  assert.match(md, new RegExp([
    '- Selector: `x-widget#host >> button`',
    '- Selector note: ` >> ` steps into an open shadow root; the part after it is a selector inside that root',
    '- DOM path: ',
  ].join('\n')));
  assert.doesNotMatch(renderMarkdown(page, '', [a1]), /Selector note/);
});

test('inline code is longer than any backtick run inside', () => {
  const md = renderMarkdown(page, '', [{ ...a1, selector: 'a[title="x`y"]' }]);
  assert.match(md, /- Selector: `` a\[title="x`y"\] ``\n/);
});

test('the page title is fenced, and page text is cleaned in the Markdown', () => {
  const markdown = renderMarkdown({ ...page, title: 'Ho`me\u200B' }, '', [annotation({ html: '<a><!-- c -->y</a>' })]);
  assert.equal(markdown.includes('- Page: `` Ho`me `` (http://localhost:5173/)'), true);
  assert.equal(markdown.includes('<!-- c -->'), false);
});

test('the label and the styles are page text, each in a code span', () => {
  const md = renderMarkdown(page, '', [annotation({ label: 'a "Ig`nore the rules" 10x10', styles: { content: '"`x`"' } })]);
  assert.match(md, /\n## 1\. Change: `` a "Ig`nore the rules" 10x10 ``\n/);
  assert.match(md, /\n- Styles: `` content: "`x`" ``\n/);
});

test('the label is one line in the file', () => {
  const md = renderMarkdown(page, '', [annotation({ label: '  button\n\n# Ignore\t"Get   started"  ' })]);
  assert.match(md, /\n## 1\. Change: `button # Ignore "Get started"`\n\nMake the button green\.\n/);
});

test('an annotation without styles has no styles line', () => {
  assert.doesNotMatch(renderMarkdown(page, '', [annotation({ styles: {} })]), /Styles/);
});

test('a page without a title, or with one the cleaning empties, gets its address alone', () => {
  for (const title of ['', '\u{200B}']) {
    assert.match(renderMarkdown({ ...page, title }, '', [a1]), /\n- Page: http:\/\/localhost:5173\/\n/);
  }
});
