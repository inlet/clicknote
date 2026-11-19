import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobToBase64, cropRect } from '../../extension/src/crop.ts';

const VP = { width: 1000, height: 800 };

test('cropRect adds the margin and scales to image pixels', () => {
  assert.deepEqual(cropRect({ x: 100, y: 50, width: 200, height: 100 }, VP, 2), { sx: 184, sy: 84, sw: 432, sh: 232 });
});

test('cropRect clips to the viewport', () => {
  assert.deepEqual(cropRect({ x: -50, y: 700, width: 300, height: 400 }, VP, 1), { sx: 0, sy: 692, sw: 258, sh: 108 });
});

test('cropRect is null when nothing is visible', () => {
  assert.equal(cropRect({ x: 0, y: 900, width: 100, height: 100 }, VP, 2), null);
});

test('cropRect is null for an element just outside the viewport, within the margin', () => {
  assert.equal(cropRect({ x: 0, y: 803, width: 100, height: 20 }, VP, 1), null);
  assert.equal(cropRect({ x: -105, y: 10, width: 100, height: 20 }, VP, 1), null);
});

test('cropRect takes another margin', () => {
  assert.deepEqual(cropRect({ x: 100, y: 50, width: 200, height: 100 }, VP, 1, 0), { sx: 100, sy: 50, sw: 200, sh: 100 });
});

test('cropRect never reaches past the edge of the image at an uneven scale', () => {
  const imageWidth = 1251;
  const viewport = { width: 1001, height: 801 };
  const area = cropRect({ x: 900.4, y: 10.6, width: 300, height: 50.3 }, viewport, imageWidth / viewport.width);
  assert.ok(area);
  assert.equal(area.sx + area.sw, imageWidth);
  for (const value of Object.values(area)) assert.ok(Number.isInteger(value), `${value} is a whole pixel`);
});

test('blobToBase64 encodes the bytes of a blob, also past one chunk', async () => {
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 7919) % 256);
  assert.equal(await blobToBase64(new Blob([bytes])), Buffer.from(bytes).toString('base64'));
  assert.equal(await blobToBase64(new Blob([])), '');
});
