import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  draftFor, forgetRecord, isWhatWasSent, newSendId, readRecord, saveRecord, updateRecord, whatWasSent,
} from '../../extension/src/drafts.ts';
import type { Draft, SendRecord } from '../../extension/src/messages.ts';
import type { Annotation, Intent } from '../../shared/types.ts';

const draft = (url: string): Draft => ({ url, note: 'Keep it calm.', annotations: [] });

test('draftFor gives the draft of the same page, whatever the hash', () => {
  const stored = draft('http://localhost:5173/app?tab=2#top');
  assert.equal(draftFor(stored, 'http://localhost:5173/app?tab=2'), stored);
  assert.equal(draftFor(stored, 'http://localhost:5173/app?tab=2#bottom'), stored);
});

test('draftFor is null for another page or no draft', () => {
  assert.equal(draftFor(draft('http://localhost:5173/app?tab=2'), 'http://localhost:5173/app?tab=3'), null);
  assert.equal(draftFor(draft('http://localhost:5173/app'), 'http://localhost:5174/app'), null);
  assert.equal(draftFor(null, 'http://localhost:5173/app'), null);
});

const NOTE = 'Keep it calm.';
const made = (id: string, comment = 'Bigger', intent: Intent = 'change'): Annotation => ({
  id, number: 1, intent, comment, label: 'button', selector: '#cta', domPath: 'body', text: '', html: '<button></button>',
  rect: { x: 0, y: 0, width: 1, height: 1 }, styles: {}, screenshot: null,
});
const holding = (annotations: Annotation[], note = NOTE): Draft => ({ url: 'http://localhost:5173/app', note, annotations });

test('whatWasSent keeps the id, the comment and the intent of each annotation, and the note', () => {
  assert.deepEqual(whatWasSent(holding([made('a1'), made('b2', 'Why?', 'question')])), {
    note: NOTE,
    annotations: [{ id: 'a1', comment: 'Bigger', intent: 'change' }, { id: 'b2', comment: 'Why?', intent: 'question' }],
  });
});

test('a draft is what was sent with the same annotations in any order and the same note', () => {
  const sent = whatWasSent(holding([made('a1'), made('b2', 'Why?', 'question')]));
  assert.equal(isWhatWasSent(holding([made('a1'), made('b2', 'Why?', 'question')]), sent), true);
  assert.equal(isWhatWasSent(holding([made('b2', 'Why?', 'question'), made('a1')]), sent), true);
  assert.equal(isWhatWasSent({ ...holding([made('a1'), made('b2', 'Why?', 'question')]), url: 'http://localhost:5173/other' }, sent), true);
});

test('a draft that has changed in any way is not what was sent', () => {
  const sent = whatWasSent(holding([made('a1'), made('b2')]));
  for (const [what, draft] of [
    ['one more', holding([made('a1'), made('b2'), made('c3')])],
    ['one fewer', holding([made('a1')])],
    ['another', holding([made('a1'), made('c3')])],
    ['one twice', holding([made('a1'), made('a1')])],
    ['a changed comment', holding([made('a1'), made('b2', 'Smaller')])],
    ['a changed intent', holding([made('a1'), made('b2', 'Bigger', 'question')])],
    ['a changed note', holding([made('a1'), made('b2')], 'Make it loud.')],
    ['nothing', holding([])]] as [string, Draft][]) {
    assert.equal(isWhatWasSent(draft, sent), false, what);
  }
});

test('newSendId gives 16 lower-case hexadecimal characters, and another each time', () => {
  const ids = Array.from({ length: 20 }, newSendId);
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(new Set(ids).size, 20);
});

// chrome.storage.session in memory, for the parts of drafts.ts that keep the record of a send.
// Each value is copied on the way in and out, as Chrome does.
const surroundings = globalThis as unknown as { chrome?: unknown };
function session(): Map<string, unknown> {
  const items = new Map<string, unknown>();
  surroundings.chrome = {
    storage: {
      session: {
        get: async (key: string) => (items.has(key) ? { [key]: structuredClone(items.get(key)) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) items.set(key, structuredClone(value));
        },
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) items.delete(key);
        },
      },
    },
  };
  return items;
}

afterEach(() => {
  delete surroundings.chrome;
});

const RECORD: SendRecord = {
  id: '0123456789abcdef',
  startedAt: 1_700_000_000_000,
  agent: { id: 'a1b2c3d4e5f6', folder: 'site', about: 'checkout form', harness: 'codex', number: null, waiting: false },
  sent: { note: NOTE, annotations: [{ id: 'a1', comment: 'Bigger', intent: 'change' }] },
  line: null,
  kept: false,
  status: null,
};
const QUEUED: SendRecord = { ...RECORD, line: 'Browser annotations (1) on …', kept: true, status: 'queued' };

test('a record read back has its line, whether the list was kept, and its state', async () => {
  session();
  await saveRecord(7, RECORD);
  assert.deepEqual(await readRecord(7), RECORD);
  await saveRecord(7, QUEUED);
  assert.deepEqual(await readRecord(7), QUEUED);
  assert.equal(await readRecord(8), null);
});

test('a stored record of another shape, without line, kept or status, is read as no record', async () => {
  const items = session();
  const { id, startedAt, agent, sent } = RECORD;
  items.set('send:7', { id, startedAt, agent, sent });
  assert.equal(await readRecord(7), null);
  for (const broken of [
    { ...RECORD, line: 7 }, { ...RECORD, kept: 'no' }, { ...RECORD, status: 'waiting' }, { ...RECORD, kept: undefined },
  ]) {
    items.set('send:7', broken);
    assert.equal(await readRecord(7), null, JSON.stringify(broken));
  }
});

test('updateRecord writes over the record of the same send only', async () => {
  session();
  await updateRecord(7, QUEUED);
  assert.equal(await readRecord(7), null);              // no record: none is made
  await saveRecord(7, RECORD);
  await updateRecord(7, QUEUED);
  assert.deepEqual(await readRecord(7), QUEUED);
  await updateRecord(7, { ...QUEUED, id: 'fedcba9876543210', status: 'picked_up' });
  assert.deepEqual(await readRecord(7), QUEUED);        // a record of another send stays
});

test('forgetRecord removes the record of the send with that id only', async () => {
  session();
  await saveRecord(7, RECORD);
  await forgetRecord(7, 'fedcba9876543210');
  assert.deepEqual(await readRecord(7), RECORD);
  await forgetRecord(7, RECORD.id);
  assert.equal(await readRecord(7), null);
});
