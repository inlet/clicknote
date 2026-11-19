import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindingKey } from '../../bridge/src/bindings.ts';
import { openPage } from '../../bridge/src/open-page.ts';
import { filePath, isLinkable, samePage, sourceFile } from '../../shared/url.ts';

// Node 22.0 has no URL.parse, and the bridge runs on it.
test('the URL functions of the bridge work without URL.parse', () => {
  const parse = URL.parse;
  Reflect.deleteProperty(URL, 'parse');
  try {
    assert.equal(filePath('file:///Users/you/site/index.html'), '/Users/you/site/index.html');
    assert.equal(sourceFile('file://nas/share/site/index.html'), '\\\\nas\\share\\site\\index.html');
    assert.deepEqual([isLinkable('http://localhost:5173/'), isLinkable('http:localhost')], [true, false]);
    assert.deepEqual([samePage('http://a.test/x#one', 'http://a.test/x'), samePage('not a url', 'not a url')], [true, false]);
    assert.equal(bindingKey('http://localhost:5173/a?b'), 'http://localhost:5173');
    assert.equal(bindingKey('file:///Users/you/site/index.html'), 'file:///Users/you/site/');
    assert.match(openPage({ url: 'file:///Users/you/site/index.html', label: 'site' }, 'n'), /data-kind="file"/);
  } finally {
    URL.parse = parse;
  }
});

test('sourceFile decodes file URLs and is null elsewhere', () => {
  assert.equal(sourceFile('file:///Users/me/My%20Site/index.html'), '/Users/me/My Site/index.html');
  assert.equal(sourceFile('http://localhost:5173/'), null);
});

test('sourceFile writes a Windows path as Windows does', () => {
  assert.equal(sourceFile('file:///C:/Users/you/My%20Site/index.html'), 'C:\\Users\\you\\My Site\\index.html');
  assert.equal(sourceFile('file:///c:/Users/you/site/index.html'), 'c:\\Users\\you\\site\\index.html');
  assert.equal(sourceFile('file://nas/share/site/index.html'), '\\\\nas\\share\\site\\index.html');
  assert.equal(sourceFile('file:///Users/you/site/index.html'), '/Users/you/site/index.html');
});

test('filePath is the path as the URL writes it', () => {
  assert.equal(filePath('file:///C:/Users/you/My%20Site/index.html'), '/C:/Users/you/My Site/index.html');
  assert.equal(filePath('file:///Users/you/site/index.html?x#y'), '/Users/you/site/index.html');
  assert.equal(filePath('http://localhost:3000/'), null);
});

test('sourceFile ignores the query and hash of a file URL', () => {
  assert.equal(sourceFile('file:///Users/me/site/index.html?x=1#top'), '/Users/me/site/index.html');
});

test('sourceFile is null for something that is not a URL', () => {
  assert.equal(sourceFile('not a url'), null);
});

test('samePage ignores the hash only', () => {
  assert.equal(samePage('http://a.test/x?q=1#top', 'http://a.test/x?q=1#end'), true);
  assert.equal(samePage('http://a.test/x?q=1', 'http://a.test/x?q=2'), false);
  assert.equal(samePage('http://a.test/x', 'not a url'), false);
});

test('samePage treats a page with and without a hash as the same', () => {
  assert.equal(samePage('http://a.test/x', 'http://a.test/x#top'), true);
  assert.equal(samePage('http://a.test/x', 'http://a.test/y'), false);
});

const LINKABLE = ['http://localhost:3000/', 'HTTPS://Example.com/a', 'file:///Users/me/site/index.html',
  'file://nas/share/a.html'];

test('isLinkable takes a full http, https or file URL on one line', () => {
  for (const url of LINKABLE) assert.equal(isLinkable(url), true, url);
  for (const url of ['localhost:3000', 'http:localhost:3000', 'file:index.html', 'javascript:alert(1)',
    'chrome://version', 'http://a b/', 'http://a/\n', '']) {
    assert.equal(isLinkable(url), false, JSON.stringify(url));
  }
});

// isLinkable cannot ask bindingKey: shared/url.ts is built into the extension, and bindings.ts
// reads files. This test holds the two rules together.
test('every URL isLinkable takes has a site to bind', () => {
  for (const url of LINKABLE) assert.notEqual(bindingKey(url), null, url);
});
