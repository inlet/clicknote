import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../extension/src/content/store.ts';
import type { ToBackground } from '../../extension/src/messages.ts';
import type { Annotation } from '../../shared/types.ts';

const URL = 'http://localhost:5173/app';

function annotation(id: string, comment = `comment ${id}`): Omit<Annotation, 'number' | 'screenshot'> {
  return {
    id, intent: 'change', comment, label: 'button "Go" 80x24', selector: `#${id}`, domPath: `body > button#${id}`,
    text: 'Go', html: `<button id="${id}">Go</button>`, rect: { x: 0, y: 0, width: 80, height: 24 }, styles: {},
  };
}

function recordingStore() {
  const sent: ToBackground[] = [];
  const store = createStore(message => sent.push(message), () => URL);
  return { store, sent };
}

test('numbers are always the 1-based position', () => {
  const { store } = recordingStore();
  for (const id of ['a', 'b', 'c']) store.add(annotation(id));
  assert.deepEqual(store.annotations().map(a => [a.id, a.number]), [['a', 1], ['b', 2], ['c', 3]]);
  store.remove('a');
  assert.deepEqual(store.annotations().map(a => [a.id, a.number]), [['b', 1], ['c', 2]]);
  assert.equal(store.annotations()[0].screenshot, null);
});

test('every change saves the draft of this page', () => {
  const { store, sent } = recordingStore();
  store.add(annotation('a'));
  store.update('a', { comment: 'Bigger', id: 'other' });
  store.setNote('Keep it calm.');
  const saved = sent.filter(message => message.type === 'draft:save');
  assert.equal(saved.length, 3);
  assert.deepEqual(saved.at(-1), {
    type: 'draft:save',
    draft: { url: URL, note: 'Keep it calm.', annotations: store.annotations() },
  });
  assert.equal(store.annotations()[0].id, 'a');
  assert.equal(store.annotations()[0].comment, 'Bigger');
});

test('remove deletes the crop too, and clear empties the draft', () => {
  const { store, sent } = recordingStore();
  store.add(annotation('a'));
  store.setNote('Note');
  store.remove('a');
  assert.deepEqual(sent.at(-1), { type: 'crop:delete', id: 'a' });
  store.add(annotation('b'));
  store.clear();
  assert.deepEqual(sent.at(-1), { type: 'draft:save', draft: { url: URL, note: '', annotations: [] } });
});

test('save sends the draft again under the URL the page has now, and waits for the answer', async () => {
  const sent: ToBackground[] = [];
  let url = URL;
  let answered = false;
  const store = createStore(message => {
    sent.push(message);
    return new Promise<void>(done => setTimeout(() => { answered = true; done(); }, 10));
  }, () => url);
  store.add(annotation('a'));
  store.setNote('Note');
  url = 'http://localhost:5173/app?view=list';
  await store.save();
  assert.equal(answered, true);
  assert.deepEqual(sent.at(-1), {
    type: 'draft:save',
    draft: { url: 'http://localhost:5173/app?view=list', note: 'Note', annotations: store.annotations() },
  });
});

test('restore takes over a loaded draft without saving it, and tells the subscribers', () => {
  const { store, sent } = recordingStore();
  let told = 0;
  store.subscribe(() => { told += 1; });
  const loaded = { ...annotation('a'), number: 7, screenshot: null };
  store.restore({ url: URL, note: 'Note', annotations: [loaded] });
  assert.equal(sent.length, 0);
  assert.equal(told, 1);
  assert.equal(store.note(), 'Note');
  assert.equal(store.annotations()[0].number, 1);
});

// What a send carried: these annotations by id, with their comments, and this general comment.
function sent(ids: string[], note: string) {
  return { note, annotations: ids.map(id => ({ id, comment: `comment ${id}`, intent: 'change' as const })) };
}

test('removeSent removes what was sent and empties the general comment that was sent', () => {
  const { store, sent: posted } = recordingStore();
  for (const id of ['a', 'b']) store.add(annotation(id));
  store.setNote('Keep it calm.');
  posted.length = 0;
  store.removeSent(sent(['a', 'b'], 'Keep it calm.'));
  assert.deepEqual(store.annotations(), []);
  assert.equal(store.note(), '');
  assert.deepEqual(posted, [{ type: 'draft:save', draft: { url: URL, note: '', annotations: [] } }]);
});

test('removeSent keeps an annotation that was not sent, renumbered, and saves it', () => {
  const { store, sent: posted } = recordingStore();
  for (const id of ['a', 'b', 'c']) store.add(annotation(id));
  posted.length = 0;
  store.removeSent(sent(['a', 'b'], ''));
  assert.deepEqual(store.annotations().map(a => [a.id, a.number]), [['c', 1]]);
  assert.deepEqual(posted, [{ type: 'draft:save', draft: { url: URL, note: '', annotations: store.annotations() } }]);
});

test('removeSent keeps a general comment that changed since the send', () => {
  const { store, sent: posted } = recordingStore();
  store.add(annotation('a'));
  store.setNote('Keep it calm, and blue.');
  posted.length = 0;
  store.removeSent(sent(['a'], 'Keep it calm.'));
  assert.deepEqual(store.annotations(), []);
  assert.equal(store.note(), 'Keep it calm, and blue.');
  assert.deepEqual(posted, [{ type: 'draft:save', draft: { url: URL, note: 'Keep it calm, and blue.', annotations: [] } }]);
});
