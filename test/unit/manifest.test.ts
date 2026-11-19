import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { EXTENSION_ID } from '../../shared/extension-id.ts';
import { VERSION } from '../../shared/version.ts';

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../extension/manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'));

function read(file: string): string {
  return readFileSync(join(import.meta.dirname, '../..', file), 'utf8');
}

test('the extension ID is the one the key in the manifest gives', () => {
  // Chrome's ID: the first 16 bytes of the SHA-256 of the key, as hex written with a to p.
  const hex = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...hex].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
  assert.equal(EXTENSION_ID, id);
});

test('the package, the manifest and the code carry the same version', () => {
  assert.equal(VERSION, '0.4.0');
  assert.equal(packageJson.version, VERSION);
  assert.equal(manifest.version, VERSION);
});

test('the extension says Clicknote and your coding agent', () => {
  assert.equal(manifest.name, 'Clicknote');
  assert.equal(manifest.description, 'Annotate elements on a web page and send them to your coding agent.');
  assert.equal(manifest.action.default_title, 'Annotate this page for your coding agent');
});

test('the extension may reach the bridge and nothing else', () => {
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'clipboardWrite']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
});

// The one script the browser runs by itself: on the open address of the bridge's port, in the
// top frame only, before the open page's own script.
test('the extension declares one content script, for the open page of the bridge', () => {
  assert.deepEqual(manifest.content_scripts,
    [{ matches: ['http://127.0.0.1:47823/open/*'], js: ['opened.js'], run_at: 'document_start' }]);
});

// Without icons Chrome shows a grey letter in the toolbar, where most people turn the bar on.
test('the extension and its toolbar button have the icon, at every size Chrome asks for', () => {
  const sizes = (icons: Record<string, string>) => Object.keys(icons).map(Number);
  assert.deepEqual(sizes(manifest.icons), [16, 32, 48, 128]);
  assert.deepEqual(sizes(manifest.action.default_icon), [16, 32]);
  for (const [size, path] of [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)]) {
    assert.equal(path, `icons/icon-${size}.png`);
  }
});

const ICON_SIZES = [16, 32, 48, 128];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function icon(size: number): Buffer {
  return readFileSync(join(import.meta.dirname, `../../extension/icons/icon-${size}.png`));
}

// The chunks of a PNG, after its signature: each is its data's length, its type, the data and a
// checksum.
function chunks(png: Buffer): { type: string; data: Buffer }[] {
  const found = [];
  for (let at = PNG_SIGNATURE.length; at < png.length;) {
    const length = png.readUInt32BE(at);
    found.push({ type: png.toString('latin1', at + 4, at + 8), data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return found;
}

// The alpha of the PNG's top left pixel, from 0 for none to 255. The pixels are the image data
// inflated: row after row, each a filter's byte and then four bytes a pixel. No filter changes
// the first pixel of the first row, as nothing lies to its left or above it.
function firstPixelAlpha(png: Buffer): number {
  const all = chunks(png);
  const header = all.find(chunk => chunk.type === 'IHDR')!.data;
  assert.deepEqual([header[8], header[9]], [8, 6], 'eight bits a channel, in red, green, blue and alpha');
  const rows = inflateSync(Buffer.concat(all.filter(chunk => chunk.type === 'IDAT').map(chunk => chunk.data)));
  return rows[1 + 3];
}

test('each icon file is a PNG of its own size', () => {
  for (const size of ICON_SIZES) {
    const png = icon(size);
    assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE, `icon-${size}.png`);
    // The width and the height sit in the PNG's header, after the signature and the chunk's length and type.
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `icon-${size}.png`);
  }
});

// The toolbar's icons stand on the toolbar itself, light or dark, with no tile of their own: a
// ground in their corner would show as a square around them.
test('the icons of 16 and 32 have a transparent corner', () => {
  for (const size of [16, 32]) {
    assert.equal(firstPixelAlpha(icon(size)), 0, `icon-${size}.png`);
  }
});

const SHORTCUT = 'Alt+Shift+H';
const SHORTCUT_ON_MAC = '⌥⇧H';
const NAMES_THE_SHORTCUT = ['README.md', 'docs/reference.md', 'skills/clicknote/SKILL.md'];

test('the manifest suggests one shortcut, the same on every system', () => {
  const suggested = Object.values(manifest.commands._execute_action.suggested_key);
  assert.deepEqual([...new Set(suggested)], [SHORTCUT]);
});

test('the README, the reference and the skill name the shortcut the manifest suggests', () => {
  for (const file of NAMES_THE_SHORTCUT) {
    const text = read(file);
    assert.equal(text.includes(SHORTCUT), true, `${file} names ${SHORTCUT}`);
    assert.equal(text.includes(SHORTCUT_ON_MAC), true, `${file} names ${SHORTCUT_ON_MAC}`);
  }
});

test('the skill names the toolbar button, for when the shortcut does nothing', () => {
  assert.equal(read('skills/clicknote/SKILL.md').includes('toolbar button'), true);
});

// Without the extension, the open page of a local file is a dead end.
test('the skill says what to do when a local file cannot be opened', () => {
  assert.equal(read('skills/clicknote/SKILL.md').includes('open the file\'s own URL'), true);
});

test('the reference has both help texts of the open page', () => {
  const reference = read('docs/reference.md');
  for (const part of ['it is not in this browser', 'Allow access to file URLs']) {
    assert.equal(reference.includes(part), true, part);
  }
});

// Inside a sandbox the commands cannot write in the state folder or start Clicknote.
test('the skill tells a sandboxed agent to run its commands outside the sandbox', () => {
  assert.equal(read('skills/clicknote/SKILL.md').includes('In a sandboxed shell, run them outside the sandbox'), true);
});

test('the README says what the access to 127.0.0.1 is for', () => {
  const readme = read('README.md');
  const start = readme.indexOf('\n## Permissions\n');
  assert.notEqual(start, -1, 'the README has a part "Permissions"');
  const end = readme.indexOf('\n## ', start + 1);
  const permissions = readme.slice(start, end === -1 ? undefined : end);
  assert.equal(permissions.includes('recognise'), true);
});
