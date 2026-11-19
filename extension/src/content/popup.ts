import type { Intent } from '../../../shared/types.ts';
import { addHint } from './keys.ts';
import { clamp, h, icon, placeAt, trusted } from './ui.ts';
import type { Ui } from './ui.ts';

// The popup next to an element: its label, a comment box, Change / Question, and Add (⌘↵ or
// Ctrl+↵) or Cancel (Esc). Opened for an annotation that exists, it shows Delete, and Save instead
// of Add.

export interface PopupRequest {
  label: string;
  anchor: () => Element | null;           // the element to sit next to; null centres the popup
  comment?: string;
  intent?: Intent;
  editing: boolean;
  onSubmit(comment: string, intent: Intent): Promise<void> | void;
  onDelete?(): void;
  onClose(): void;                        // after Add, Save, Delete and Cancel alike
}

export interface Popup {
  open(request: PopupRequest): void;
  close(): void;
  isOpen(): boolean;
  follow(): void;                         // moves along with its element after a scroll
  setLocked(on: boolean): void;           // Add, Save and Delete off; what is typed stays
}

const GAP = 12;                           // between the element and the popup
const MARGIN = 8;

export function createPopup(ui: Ui): Popup {
  const label = h('div', { part: 'popup-label', class: 'popup-label' });
  const comment = h('textarea', {
    part: 'comment',
    class: 'comment',
    attrs: { rows: '3', 'aria-label': 'Comment', placeholder: 'What should change, or what do you want to know?' },
  });
  const change = h('button', { part: 'intent-change', text: 'Change' });
  const question = h('button', { part: 'intent-question', text: 'Question' });
  const remove = h('button', {
    part: 'delete',
    class: 'pill round small danger',
    attrs: { 'aria-label': 'Delete annotation', title: 'Delete' },
  }, icon('trash'));
  const cancel = h('button', { part: 'cancel', class: 'pill', text: 'Cancel', attrs: { title: 'Esc' } });
  const addText = document.createTextNode('Add');
  const add = h('button', { part: 'add', class: 'pill filled' },
    addText, h('span', { class: 'kbd', text: addHint(navigator.platform), attrs: { 'aria-hidden': 'true' } }));
  // Focus starts in the comment, and Tab goes on to Change and Question, Delete, Cancel and Add or
  // Save, in that order on the screen too, so Shift+Tab from the comment never lands on Delete.
  // While editing, the buttons take a row of their own under the switch: with Delete they do not
  // fit beside it.
  const popup = h('div', { part: 'popup', class: 'panel popup', attrs: { role: 'dialog', 'aria-label': 'Annotation' } },
    label,
    comment,
    h('div', { class: 'popup-actions' },
      h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Intent' } }, change, question),
      h('div', { class: 'popup-buttons' }, remove, cancel, add)));
  popup.hidden = true;
  ui.root.append(popup);

  let current: PopupRequest | null = null;
  let intent: Intent = 'change';
  let submitting = false;
  let locked = false;

  const setIntent = (next: Intent) => {
    intent = next;
    change.setAttribute('aria-pressed', String(next === 'change'));
    question.setAttribute('aria-pressed', String(next === 'question'));
  };
  const updateAdd = () => {
    add.disabled = locked || submitting || comment.value.trim() === '';
    remove.disabled = locked;
  };

  function close(): void {
    const request = current;
    if (!request) return;
    current = null;
    popup.hidden = true;
    request.onClose();
  }

  // The popup stays open until the annotation is in, so a test or a user that waits for it
  // to close finds the annotation there. A failure leaves it open with the comment intact.
  async function submit(): Promise<void> {
    const request = current;
    if (!request || add.disabled) return;
    submitting = true;
    updateAdd();
    try {
      await request.onSubmit(comment.value.trim(), intent);
      if (current === request) close();
    } catch (error) {
      console.warn('[clicknote] Adding the annotation failed:', error);
    } finally {
      submitting = false;
      updateAdd();
    }
  }

  function follow(): void {
    if (!current) return;
    const { width: vw, height: vh } = ui.viewport();
    const { offsetWidth: width, offsetHeight: height } = popup;
    const rect = current.anchor()?.getBoundingClientRect();
    let left = (vw - width) / 2;
    let top = (vh - height) / 2;
    if (rect && (rect.width > 0 || rect.height > 0)) {
      left = rect.left;
      if (rect.bottom + GAP + height <= vh - MARGIN) top = rect.bottom + GAP;          // below
      else if (rect.top - GAP - height >= MARGIN) top = rect.top - GAP - height;       // above
      else top = rect.top + GAP;                                                        // inside, at the top
    }
    placeAt(popup, clamp(left, MARGIN, vw - width - MARGIN), clamp(top, MARGIN, vh - height - MARGIN));
  }

  change.addEventListener('click', () => setIntent('change'));
  question.addEventListener('click', () => setIntent('question'));
  comment.addEventListener('input', updateAdd);
  comment.addEventListener('keydown', trusted((event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void submit();
  }));
  add.addEventListener('click', trusted(() => void submit()));
  cancel.addEventListener('click', close);
  remove.addEventListener('click', trusted(() => {
    current?.onDelete?.();
    close();
  }));

  return {
    open(request) {
      close();
      current = request;
      label.textContent = request.label;
      label.title = request.label;
      comment.value = request.comment ?? '';
      setIntent(request.intent ?? 'change');
      remove.hidden = !request.editing;
      addText.data = request.editing ? 'Save' : 'Add';
      updateAdd();
      popup.hidden = false;
      follow();
      comment.focus({ preventScroll: true });
    },
    close,
    isOpen: () => current !== null,
    follow,
    setLocked(on) {
      locked = on;
      updateAdd();
    },
  };
}
