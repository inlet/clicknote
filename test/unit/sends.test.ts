import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneSends, writeSend } from '../../bridge/src/sends.ts';
import { stateDir } from '../../bridge/src/paths.ts';
import type { Annotation, SendPayload } from '../../shared/types.ts';

// A 1x1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
    screenshot: null,
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
});

function payload(fields: Partial<SendPayload> = {}): SendPayload {
  return {
    page: {
      url: 'http://localhost:5173/',
      title: 'Home',
      viewport: { width: 1440, height: 900 },
      devicePixelRatio: 2,
      sourceFile: null,
    },
    note: 'Make it calmer.',
    annotations: [a1, a2],
    images: {},
    ...fields,
  };
}

// Every variable a test may set; each is cleared before a test and restored after it.
const ENV_KEYS = ['CLICKNOTE_STATE_DIR'];
let savedEnv: Record<string, string | undefined> = {};
let dir = '';

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'clicknote-sends-test-'));
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

test('writeSend writes markdown, json and one png per image', () => {
  const folder = writeSend(payload({ images: { [a1.id]: PNG_BASE64 } }), new Date(2026, 10, 12, 15, 2, 0));
  assert.equal(folder, join(stateDir(), 'sends', '20261112-150200'));
  assert.deepEqual(readdirSync(folder).sort(), ['1.png', 'annotations.json', 'annotations.md']);
  assert.match(readFileSync(join(folder, 'annotations.md'), 'utf8'), /- Screenshot: `1\.png`/);
  const json = JSON.parse(readFileSync(join(folder, 'annotations.json'), 'utf8'));
  assert.equal(json.annotations[0].screenshot, '1.png');
  assert.equal(json.annotations[1].screenshot, null);       // a2 has no image
  assert.equal('images' in json, false);
  assert.equal(readFileSync(join(folder, '1.png')).subarray(1, 4).toString(), 'PNG');
});

test('a second send in the same second gets a suffix', () => {
  const now = new Date(2026, 10, 12, 15, 2, 0);
  writeSend(payload(), now);
  assert.match(writeSend(payload(), now), /20261112-150200-2$/);
});

test('pruneSends removes folders older than 7 days only', () => {
  const old = writeSend(payload(), new Date(2026, 10, 1, 9, 0, 0));
  const fresh = writeSend(payload(), new Date(2026, 10, 10, 9, 0, 0));
  utimesSync(old, new Date(2026, 10, 1), new Date(2026, 10, 1));
  utimesSync(fresh, new Date(2026, 10, 10), new Date(2026, 10, 10));
  pruneSends(new Date(2026, 10, 12));
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});

test('annotations.json holds the page, the note and the annotations', () => {
  const folder = writeSend(payload(), new Date(2026, 10, 12, 15, 2, 0));
  const json = JSON.parse(readFileSync(join(folder, 'annotations.json'), 'utf8'));
  assert.deepEqual(json, { page: payload().page, note: 'Make it calmer.', annotations: [a1, a2] });
});

test('annotations.json keeps the exact position, which annotations.md rounds', () => {
  const rect = { x: 242.65625, y: 72, width: 202.671875, height: 83.515625 };
  const folder = writeSend(payload({ annotations: [{ ...a1, rect }] }), new Date(2026, 10, 12, 15, 2, 0));
  const json = JSON.parse(readFileSync(join(folder, 'annotations.json'), 'utf8'));
  assert.deepEqual(json.annotations[0].rect, rect);
  assert.match(readFileSync(join(folder, 'annotations.md'), 'utf8'), /\n- Position: x 243, y 72, 203x84\n/);
});

test('a screenshot name in the payload is replaced by what images holds', () => {
  const stale = payload({ annotations: [{ ...a1, screenshot: '9.png' }], images: {} });
  const folder = writeSend(stale, new Date(2026, 10, 12, 15, 2, 0));
  const json = JSON.parse(readFileSync(join(folder, 'annotations.json'), 'utf8'));
  assert.equal(json.annotations[0].screenshot, null);
  assert.doesNotMatch(readFileSync(join(folder, 'annotations.md'), 'utf8'), /Screenshot/);
});

test('annotations.json holds the cleaned page text', () => {
  const folder = writeSend({ ...payload(), annotations: [annotation({ html: '<a><!-- c -->y</a>' })] });
  const stored = JSON.parse(readFileSync(join(folder, 'annotations.json'), 'utf8'));
  assert.equal(stored.annotations[0].html, '<a>y</a>');
});

test('pruneSends ignores a missing sends folder', () => {
  assert.doesNotThrow(() => pruneSends(new Date(2026, 10, 12)));
});
