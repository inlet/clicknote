import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendLine } from '../../shared/line.ts';

test('sendLine is the exact prompt', () => {
  assert.equal(sendLine(3, 'http://localhost:3000/', '/Users/you/.local/state/clicknote/sends/20261112-153012/annotations.md'),
    'Browser annotations (3) on http://localhost:3000/: read /Users/you/.local/state/clicknote/sends/20261112-153012/annotations.md, carry out the Change items and answer the Question items.');
});

// Without the quotes an agent may read the path as two words and look for a file that is not there.
test('a path with a space goes in double quotes', () => {
  assert.equal(sendLine(1, 'http://localhost:3000/', 'C:\\Users\\Jan de Vries\\AppData\\Local\\clicknote\\sends\\20261113-101500\\annotations.md'),
    'Browser annotations (1) on http://localhost:3000/: read "C:\\Users\\Jan de Vries\\AppData\\Local\\clicknote\\sends\\20261113-101500\\annotations.md", carry out the Change items and answer the Question items.');
});
