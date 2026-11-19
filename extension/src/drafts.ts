import { samePage } from '../../shared/url.ts';
import { isSendStatus } from './bridge-client.ts';
import type { Draft, Sent, SendRecord } from './messages.ts';

// The unsent annotations of each tab. The draft itself is small and lives in
// chrome.storage.session under `draft:<tabId>`, and the record of the send the tab follows under
// `send:<tabId>`; the crops are PNG blobs, too large for its quota, and live in IndexedDB
// (database `clicknote`, store `crops`, keyed by annotation id).
// Chrome APIs are used inside the functions only, so the pure parts load in Node.

const DATABASE = 'clicknote';
const CROPS = 'crops';

const draftKey = (tabId: number) => `draft:${tabId}`;
const sendKey = (tabId: number) => `send:${tabId}`;

// The draft when it belongs to the page at `url`, ignoring the hash; else null.
export function draftFor(draft: Draft | null, url: string): Draft | null {
  return draft && samePage(draft.url, url) ? draft : null;
}

// What a send of this draft carries, as far as the user can change it afterwards: the note,
// and the id, the comment and the intent of each annotation.
export function whatWasSent(draft: Draft): Sent {
  return { note: draft.note, annotations: draft.annotations.map(({ id, comment, intent }) => ({ id, comment, intent })) };
}

// Whether the draft is the one that was sent: the same note and the same annotations by id,
// each with the same comment and intent. The order and the URL do not count, so a draft that
// was renumbered or moved with its page is still the one; any other change makes it another.
export function isWhatWasSent(draft: Draft, sent: Sent): boolean {
  if (draft.note !== sent.note || draft.annotations.length !== sent.annotations.length) return false;
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const held = whatWasSent(draft).annotations.sort(byId);
  return [...sent.annotations].sort(byId).every(({ id, comment, intent }, index) =>
    id === held[index].id && comment === held[index].comment && intent === held[index].intent);
}

// The id of a new send: 16 lower-case hexadecimal characters from the browser's random source,
// the form of the bridge's own ids.
export function newSendId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('');
}

// The record of the send the tab follows, whatever page it was made on. A record of another
// shape counts as none.
export async function readRecord(tabId: number): Promise<SendRecord | null> {
  const key = sendKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  return isSendRecord(stored) ? stored : null;
}

// Keeps the record of a send, in place of any earlier one in the tab. Rejects when the write
// fails, as when the storage is full.
export async function saveRecord(tabId: number, record: SendRecord): Promise<void> {
  await chrome.storage.session.set({ [sendKey(tabId)]: record });
}

// Writes the record of a send over the tab's record of the same send. When the tab's record is of
// another send, or there is none, nothing is written: a newer send has taken its place, or the
// send no longer needs one.
export async function updateRecord(tabId: number, record: SendRecord): Promise<void> {
  if ((await readRecord(tabId))?.id !== record.id) return;
  await saveRecord(tabId, record);
}

// Forgets the record of the send with this id; a record of another send in the tab stays.
export async function forgetRecord(tabId: number, id: string): Promise<void> {
  if ((await readRecord(tabId))?.id !== id) return;
  await chrome.storage.session.remove(sendKey(tabId));
}

// The tab's draft, whatever page it was made on.
export async function readDraft(tabId: number): Promise<Draft | null> {
  const key = draftKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  return isDraft(stored) ? stored : null;
}

// The tab's draft when it belongs to the page at `url`.
export async function loadDraft(tabId: number, url: string): Promise<Draft | null> {
  return draftFor(await readDraft(tabId), url);
}

export async function saveDraft(tabId: number, draft: Draft): Promise<void> {
  await chrome.storage.session.set({ [draftKey(tabId)]: draft });
}

// Removes everything the tab had: its draft, the crops of its annotations, and the record of
// its send. For a tab that was closed.
export async function deleteDraft(tabId: number): Promise<void> {
  const draft = await readDraft(tabId);
  await chrome.storage.session.remove(sendKey(tabId));
  await removeDraft(tabId, draft);
}

// After the bridge has `sent`, or a copy of it, removes the tab's draft and the crops of its
// annotations, but only while the draft is still what was sent: the draft is read once, and what
// was read is deleted. True when the draft stays. A draft made or changed since, on this page or
// another, was not sent. A draft without annotations is left in storage as it is, and the answer
// is false: nothing stays that the list would have to take over. The record of a send stays: it
// is about the send, not the draft.
export async function deleteSentDraft(tabId: number, sent: Sent): Promise<boolean> {
  const draft = await readDraft(tabId);
  if (!draft || draft.annotations.length === 0) return false;
  if (!isWhatWasSent(draft, sent)) return true;
  await removeDraft(tabId, draft);
  return false;
}

export async function putCrop(id: string, png: Blob): Promise<void> {
  await inCrops('readwrite', store => store.put(png, id));
}

export async function getCrop(id: string): Promise<Blob | null> {
  const stored: unknown = await inCrops('readonly', store => store.get(id));
  return stored instanceof Blob ? stored : null;
}

export async function deleteCrops(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await inCrops('readwrite', store => {
    for (const id of ids) store.delete(id);
    return undefined;
  });
}

// Removes every crop. For when chrome.storage.session has been emptied, so no draft is left
// to need one.
export async function clearCrops(): Promise<void> {
  await inCrops('readwrite', store => store.clear());
}

// Removes the tab's draft, and the crops of `draft`, as it was read.
async function removeDraft(tabId: number, draft: Draft | null): Promise<void> {
  await chrome.storage.session.remove(draftKey(tabId));
  if (draft) await deleteCrops(draft.annotations.map(annotation => annotation.id));
}

function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false;
  const { url, note, annotations } = value as Partial<Draft>;
  return typeof url === 'string' && typeof note === 'string' && Array.isArray(annotations);
}

function isSendRecord(value: unknown): value is SendRecord {
  if (typeof value !== 'object' || value === null) return false;
  const { id, startedAt, agent, sent, line, kept, status } = value as Partial<SendRecord>;
  return typeof id === 'string' && typeof startedAt === 'number' && typeof agent === 'object' && agent !== null
    && typeof sent === 'object' && sent !== null && typeof sent.note === 'string' && Array.isArray(sent.annotations)
    && (line === null || typeof line === 'string') && typeof kept === 'boolean'
    && (status === null || isSendStatus(status));
}

// Runs `work` in one transaction on the crops store and gives the result of the request it
// returns, once the transaction has completed. Opens and closes the database each time, so
// nothing has to outlive the service worker.
async function inCrops<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T> | undefined,
): Promise<T | undefined> {
  const database = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = database.transaction(CROPS, mode);
      const request = work(transaction.objectStore(CROPS));
      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('The crops transaction was aborted.'));
    });
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CROPS);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
