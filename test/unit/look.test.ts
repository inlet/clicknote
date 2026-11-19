import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, DARK, LIGHT, PAIRS } from '../../extension/src/content/look.ts';

test('the contrast of two colours is the ratio of their lightness, the lighter one first', () => {
  assert.equal(contrast('#000000', '#FFFFFF'), 21);
  assert.equal(contrast('#FFFFFF', '#000000'), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrast('#767676', '#FFFFFF') - 4.54) < 0.01);
  assert.equal(contrast('#fff', '#000'), 21);
});

test('the contrast is only for opaque colours', () => {
  assert.throws(() => contrast('rgba(0, 0, 0, 0.5)', '#FFFFFF'), /opaque/);
  assert.throws(() => contrast('#FFFFFF', 'transparent'), /opaque/);
});

test('every text colour has a contrast of at least 4.5 against its ground, in light and in dark', () => {
  assert.ok(PAIRS.length > 0);
  for (const [mode, tokens] of [['light', LIGHT], ['dark', DARK]] as const) {
    for (const [text, ground] of PAIRS) {
      const ratio = contrast(tokens[text], tokens[ground]);
      assert.ok(ratio >= 4.5, `In ${mode} mode, ${text} on ${ground} has a contrast of ${ratio.toFixed(2)}.`);
    }
  }
});

test('the filled pill is the same in both modes', () => {
  assert.equal(LIGHT.fill, '#A9B5FF');
  assert.equal(LIGHT['on-fill'], '#1B1B1F');
  assert.equal(DARK.fill, LIGHT.fill);
  assert.equal(DARK['on-fill'], LIGHT['on-fill']);
});

test('a marker is the same in both modes, with a green shadow for a Change and a lilac one for a Question', () => {
  for (const tokens of [LIGHT, DARK]) {
    assert.equal(tokens.marker, '#FFFFFF');
    assert.equal(tokens['marker-ink'], '#1B1B1F');
    assert.equal(tokens.change, '#B9F27C');
    assert.equal(tokens.question, '#A9B5FF');
  }
});

// WCAG asks 3 to 1 of a focus ring against what it borders: the page around the marker, often
// white, and the marker's dark outline.
test('the focus ring of a marker is the light mode\'s in both modes, with 3 to 1 against white and against the outline', () => {
  for (const tokens of [LIGHT, DARK]) {
    assert.equal(tokens['marker-focus'], LIGHT.focus);
    assert.ok(contrast(tokens['marker-focus'], '#FFFFFF') >= 3);
    assert.ok(contrast(tokens['marker-focus'], tokens['marker-ink']) >= 3);
  }
});

test('the bar and the popup are white in light mode and dark grey in dark mode', () => {
  assert.equal(LIGHT.surface, '#FFFFFF');
  assert.equal(DARK.surface, '#1F1F26');
});
