import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHint } from '../../extension/src/content/keys.ts';

test('the hint for Add follows the keyboard of the system', () => {
  assert.equal(addHint('MacIntel'), '⌘↵');
  assert.equal(addHint('Win32'), 'Ctrl+↵');
  assert.equal(addHint('Linux x86_64'), 'Ctrl+↵');
  assert.equal(addHint(''), 'Ctrl+↵');
});
