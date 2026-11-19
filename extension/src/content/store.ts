import type { Annotation } from '../../../shared/types.ts';
import type { Draft, Sent, ToBackground } from '../messages.ts';

// The annotations of this page and the general note, as the content script holds them. The
// service worker keeps a copy as the tab's draft, so they survive a reload: every change
// sends `draft:save`, under the page's URL at that moment.

export interface Store {
  annotations(): Annotation[];
  note(): string;
  setNote(note: string): void;
  add(annotation: Omit<Annotation, 'number' | 'screenshot'>): void;
  update(id: string, patch: Partial<Annotation>): void;
  remove(id: string): void;                // also deletes its crop
  clear(): void;
  // Removes the annotations that a send carried, by id, and empties the general note when it still
  // reads what was sent; saves what is left.
  removeSent(sent: Sent): void;
  restore(draft: Draft): void;             // takes over a loaded draft, without saving it again
  save(): Promise<void>;                   // saves the draft again, under the page's URL as it is now
  subscribe(listener: () => void): void;
}

// A message to the service worker and its answer. Rejects when the extension has been
// reloaded or removed since this script was injected.
export async function toBackground<T>(message: ToBackground): Promise<T> {
  return chrome.runtime.sendMessage<ToBackground, T>(message);
}

// `post` sends a message to the service worker; save() waits for what it returns.
export function createStore(
  post: (message: ToBackground) => unknown = postToBackground,
  pageUrl: () => string = () => location.href,
): Store {
  let annotations: Annotation[] = [];
  let note = '';
  const listeners: (() => void)[] = [];

  // Numbers are always the 1-based position in the list.
  const renumber = (list: Annotation[]) => list.map((annotation, index) =>
    annotation.number === index + 1 ? annotation : { ...annotation, number: index + 1 });

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const save = async () => {
    await post({ type: 'draft:save', draft: { url: pageUrl(), note, annotations } });
  };

  const changed = (next: Annotation[]) => {
    annotations = renumber(next);
    void save();
    notify();
  };

  return {
    annotations: () => annotations,
    note: () => note,
    setNote(next) {
      note = next;
      changed(annotations);
    },
    add(annotation) {
      changed([...annotations, { ...annotation, number: 0, screenshot: null }]);
    },
    update(id, patch) {
      changed(annotations.map(annotation => annotation.id === id ? { ...annotation, ...patch, id } : annotation));
    },
    remove(id) {
      changed(annotations.filter(annotation => annotation.id !== id));
      post({ type: 'crop:delete', id });
    },
    clear() {
      note = '';
      changed([]);
    },
    removeSent(sent) {
      const ids = new Set(sent.annotations.map(annotation => annotation.id));
      if (note === sent.note) note = '';
      changed(annotations.filter(annotation => !ids.has(annotation.id)));
    },
    restore(draft) {
      annotations = renumber(draft.annotations);
      note = draft.note;
      notify();
    },
    save,
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}

// Never rejects: a failure is logged.
function postToBackground(message: ToBackground): Promise<void> {
  return toBackground(message).then(
    () => undefined,
    error => console.warn(`[clicknote] ${message.type} failed:`, error),
  );
}
