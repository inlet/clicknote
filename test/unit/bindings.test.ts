import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindingKey, preselect, recordBinding } from '../../bridge/src/bindings.ts';
import { stateDir } from '../../bridge/src/paths.ts';
import type { AgentInfo } from '../../shared/types.ts';

// Every variable a test may set; each is cleared before a test and restored after it.
const ENV_KEYS = ['CLICKNOTE_STATE_DIR'];
let savedEnv: Record<string, string | undefined> = {};
let dir = '';

// Living agents with these ids, as listAgents gives them.
function agents(...ids: string[]): AgentInfo[] {
  return ids.map(id => ({ id, folder: 'w', about: '', harness: 'claude-code', number: null, waiting: false }));
}

function readStore(): unknown {
  return JSON.parse(readFileSync(join(stateDir(), 'bindings.json'), 'utf8'));
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'clicknote-bindings-test-'));
  process.env.CLICKNOTE_STATE_DIR = dir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('bindingKey: origin for http, folder for file, null otherwise', () => {
  assert.equal(bindingKey('http://localhost:5173/a/b?x#y'), 'http://localhost:5173');
  assert.equal(bindingKey('https://example.com/'), 'https://example.com');
  assert.equal(bindingKey('file:///Users/me/My%20Site/index.html'), 'file:///Users/me/My Site/');
  assert.equal(bindingKey('chrome://version'), null);
  assert.equal(bindingKey('nonsense'), null);
});

// The key keeps the form of the URL, with its host, so a folder covers the folders below it on
// Windows too and two hosts with the same path are never mixed.
test('a file page on Windows is bound by its folder', () => {
  assert.equal(bindingKey('file:///C:/Users/you/site/index.html'), 'file:///C:/Users/you/site/');
  assert.equal(bindingKey('file://nas/share/site/index.html'), 'file://nas/share/site/');
  assert.equal(bindingKey('file:///Users/you/site/index.html'), 'file:///Users/you/site/');
  recordBinding('file:///C:/Users/you/site/index.html', 't6m', 'send');
  assert.equal(preselect('file:///C:/Users/you/site/about/team.html', agents('t6m')), 't6m');
  assert.equal(preselect('file:///C:/Users/you/other/index.html', agents('t6m')), null);
});

test('the most recent binding for a site wins', () => {
  recordBinding('http://localhost:5173/', 't1', 'send', 100);
  recordBinding('http://localhost:5173/x', 't2', 'send', 200);
  assert.equal(preselect('http://localhost:5173/y', agents('t1', 't2')), 't2');
});

test('a binding whose agent is gone is ignored', () => {
  recordBinding('http://localhost:5173/', 't1', 'send', 100);
  assert.equal(preselect('http://localhost:5173/', agents('t2')), null);
});

test('file pages match the deepest bound folder with a living agent', () => {
  recordBinding('file:///w/site/index.html', 't1', 'send', 100);
  recordBinding('file:///w/site/docs/a.html', 't2', 'send', 50);
  assert.equal(preselect('file:///w/site/docs/deep/b.html', agents('t1', 't2')), 't2');
  assert.equal(preselect('file:///w/site/docs/deep/b.html', agents('t1')), 't1');
  assert.equal(preselect('file:///w/other/c.html', agents('t1', 't2')), null);
});

test('a missing or corrupt store behaves as empty', () => {
  assert.equal(preselect('http://localhost:5173/', agents('t1')), null);
  writeFileSync(join(stateDir(), 'bindings.json'), '{oops');
  assert.equal(preselect('http://localhost:5173/', agents('t1')), null);
  recordBinding('http://localhost:5173/', 't1', 'send', 1);   // overwrites the corrupt file
  assert.equal(preselect('http://localhost:5173/', agents('t1')), 't1');
});

const LINKS = { skip: process.platform === 'win32' && 'making a link on Windows needs a privilege the tests may not have' };

test('a store that is a link is not followed', LINKS, () => {
  const outside = mkdtempSync(join(tmpdir(), 'clicknote-bindings-outside-'));
  try {
    const bindings = { 'http://localhost:5173': { agent: 't1', at: 1, source: 'send' } };
    writeFileSync(join(outside, 'bindings.json'), JSON.stringify(bindings));
    symlinkSync(join(outside, 'bindings.json'), join(dir, 'bindings.json'));
    assert.equal(preselect('http://localhost:5173/', agents('t1')), null);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the store keeps one entry per key with the agent, the time and the source', () => {
  recordBinding('http://localhost:5173/a', 't1', 'send', 100);
  recordBinding('http://localhost:5173/b', 't2', 'send', 200);
  recordBinding('file:///w/site/index.html', 't3', 'send', 300);
  assert.deepEqual(readStore(), {
    'http://localhost:5173': { agent: 't2', at: 200, source: 'send' },
    'file:///w/site/': { agent: 't3', at: 300, source: 'send' },
  });
});

test('a binding stored with the source link is still read', () => {
  writeFileSync(join(stateDir(), 'bindings.json'),
    JSON.stringify({ 'http://localhost:5173': { agent: 't1', at: 100, source: 'link' } }));
  assert.equal(preselect('http://localhost:5173/x', agents('t1')), 't1');
});

test('a site binding does not reach another port, scheme or a file page', () => {
  recordBinding('http://localhost:5173/', 't1', 'send', 100);
  assert.equal(preselect('http://localhost:51730/', agents('t1')), null);
  assert.equal(preselect('https://localhost:5173/', agents('t1')), null);
  assert.equal(preselect('file:///w/site/index.html', agents('t1')), null);
});

test('recordBinding ignores pages without a key and creates the state folder', () => {
  process.env.CLICKNOTE_STATE_DIR = join(dir, 'new', 'state');
  recordBinding('chrome://version', 't1', 'send', 100);
  assert.equal(existsSync(join(stateDir(), 'bindings.json')), false);
  recordBinding('https://example.com/', 't1', 'send', 100);
  assert.equal(preselect('https://example.com/x', agents('t1')), 't1');
});
