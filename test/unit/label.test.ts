import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentLabel, listedAs } from '../../shared/label.ts';

const AGENT = { folder: 'my-site', about: 'landing page copy', harness: 'claude-code', number: null };

test('the label leaves out an empty part and puts the number last', () => {
  assert.equal(agentLabel(AGENT), 'my-site · landing page copy · claude-code');
  assert.equal(agentLabel({ ...AGENT, number: 2 }), 'my-site · landing page copy · claude-code · 2');
  assert.equal(agentLabel({ ...AGENT, about: '' }), 'my-site · claude-code');
  assert.equal(agentLabel({ ...AGENT, about: '', harness: '', number: 3 }), 'my-site · 3');
});

test('an agent that waits is listed with a full dot and says so, one that does not with an open dot', () => {
  assert.equal(listedAs({ ...AGENT, waiting: true }), '● my-site · landing page copy · claude-code · waiting');
  assert.equal(listedAs({ ...AGENT, waiting: false }), '○ my-site · landing page copy · claude-code');
  assert.equal(listedAs({ folder: 'my-site', about: '', harness: '', number: null, waiting: false }), '○ my-site');
  assert.equal(listedAs({ ...AGENT, waiting: true }).codePointAt(0), 0x25cf);
  assert.equal(listedAs({ ...AGENT, waiting: false }).codePointAt(0), 0x25cb);
  assert.equal(listedAs({ ...AGENT, number: 2, waiting: false }), '○ my-site · landing page copy · claude-code · 2');
});

// The dots and the separator are written in the source as the characters themselves, in UTF-8.
test('the source holds the dots U+25CF and U+25CB and the separator U+00B7 as characters', () => {
  const source = readFileSync(join(import.meta.dirname, '../../shared/label.ts'));
  for (const [name, bytes] of [['U+25CF', [0xe2, 0x97, 0x8f]], ['U+25CB', [0xe2, 0x97, 0x8b]], ['U+00B7', [0xc2, 0xb7]]] as const) {
    assert.equal(source.includes(Buffer.from(bytes)), true, name);
  }
  assert.equal(/\\u|\\x/.test(source.toString('utf8')), false);
});
