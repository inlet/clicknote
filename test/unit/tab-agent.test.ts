import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAgent, isOpenAddress } from '../../extension/src/tab-agent.ts';

const CODE = '0123456789abcdef0123456789abcdef';

test('the tab\'s agent is chosen when it is listed, ahead of the agent of the site', () => {
  assert.deepEqual(chooseAgent('t8s', ['t6m', 't8s'], 't6m'), { preselect: 't8s', forget: false });
});

test('a tab without an agent gets what the bridge chose', () => {
  assert.deepEqual(chooseAgent(null, ['t6m'], 't6m'), { preselect: 't6m', forget: false });
});

test('a tab\'s agent that is no longer listed is forgotten, and the bridge\'s choice holds', () => {
  assert.deepEqual(chooseAgent('t8s', ['t6m'], 't6m'), { preselect: 't6m', forget: true });
  assert.deepEqual(chooseAgent('t8s', [], null), { preselect: null, forget: true });
});

// The open page of a link tells the extension its code; only that address, on the bridge's port,
// is believed.
test('the open address of the code is believed, whatever its query or hash', () => {
  for (const url of [`http://127.0.0.1:47823/open/${CODE}`, `http://127.0.0.1:47823/open/${CODE}?x=1`,
    `http://127.0.0.1:47823/open/${CODE}#y`]) {
    assert.equal(isOpenAddress(url, CODE, 47823), true, url);
  }
});

test('any other address is not believed', () => {
  const other = 'fedcba9876543210fedcba9876543210';
  for (const url of [`http://127.0.0.1:47824/open/${CODE}`, `http://localhost:47823/open/${CODE}`,
    `https://127.0.0.1:47823/open/${CODE}`, `http://127.0.0.1:47823/open/${other}`,
    `http://127.0.0.1:47823/open/${CODE}/x`, `http://127.0.0.1:47823/open/${CODE}/`, 'http://127.0.0.1:47823/open/',
    undefined, '', 'not a url']) {
    assert.equal(isOpenAddress(url, CODE, 47823), false, String(url));
  }
});

// Chrome has URL.parse only from version 126 on.
test('isOpenAddress is false for a URL that does not parse, also in a browser without URL.parse', () => {
  const parse = URL.parse;
  Reflect.deleteProperty(URL, 'parse');
  try {
    for (const url of ['not a url', '', `http://127.0.0.1:99999/open/${CODE}`, `http://[127.0.0.1]:47823/open/${CODE}`]) {
      assert.equal(isOpenAddress(url, CODE, 47823), false, url);
    }
    assert.equal(isOpenAddress(`http://127.0.0.1:47823/open/${CODE}`, CODE, 47823), true);
  } finally {
    URL.parse = parse;
  }
});
