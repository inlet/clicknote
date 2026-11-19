import { STYLE_PROPS } from '../../../shared/types.ts';
import type { Annotation, Rect } from '../../../shared/types.ts';

// Descriptions of a picked element: the label in the popup, a selector and a readable path
// that lead back to it, and the snapshot stored with an annotation. Plain DOM, no Node APIs.

const ELLIPSIS = '…';
const LABEL_TEXT_LENGTH = 40;
const TEXT_LIMIT = 500;
const HTML_LIMIT = 2000;
const SHADOW_SEPARATOR = ' >> ';

// `text` shortened to at most `max` characters, the ellipsis included.
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : cut(text, max - 1);
}

// `button "Get started" 120x40`: the tag, the start of the visible text and the size.
export function labelFor(el: Element, rect: Rect): string {
  const text = collapse(visibleText(el));
  const start = text.length > LABEL_TEXT_LENGTH ? cut(text, LABEL_TEXT_LENGTH) : text;
  const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  return start ? `${el.localName} "${start}" ${size}` : `${el.localName} ${size}`;
}

// A CSS selector that matches exactly `el`. For an element in an open shadow root it is
// `<selector of the host> >> <selector inside the root>`, repeated for nested roots.
export function uniqueSelector(el: Element): string {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) {
    return `${uniqueSelector(root.host)}${SHADOW_SEPARATOR}${selectorWithin(root, el)}`;
  }
  return selectorWithin(root as ParentNode, el);
}

// The element a uniqueSelector result leads to, or null when it is gone or the selector is
// invalid. Each ` >> ` continues in the open shadow root of the element found so far.
export function findBySelector(selector: string, root: Document = document): Element | null {
  const [outer, ...inner] = selector.split(SHADOW_SEPARATOR);
  try {
    let found = root.querySelector(outer);
    for (const part of inner) found = found?.shadowRoot?.querySelector(part) ?? null;
    return found;
  } catch {
    return null; // querySelector throws only on an invalid selector
  }
}

// `body > main > section#features > div.card (2 of 3) > h3`: from body down to `el`, each
// step with its tag, id, classes and position among same-tag siblings, and `#shadow-root`
// where the path enters a shadow root.
export function domPath(el: Element): string {
  const steps: string[] = [];
  let node: Element | null = el;
  while (node) {
    steps.unshift(pathStep(node));
    if (node === node.ownerDocument.body) break;
    const parent: ParentNode | null = node.parentNode;
    if (parent instanceof ShadowRoot) {
      steps.unshift('#shadow-root');
      node = parent.host;
    } else {
      node = node.parentElement;
    }
  }
  return steps.join(' > ');
}

export function snapshot(
  el: Element,
  rect: Rect,
): Pick<Annotation, 'label' | 'selector' | 'domPath' | 'text' | 'html' | 'rect' | 'styles'> {
  const computed = getComputedStyle(el);
  return {
    label: labelFor(el, rect),
    selector: uniqueSelector(el),
    domPath: domPath(el),
    text: truncate(tidyLines(visibleText(el)), TEXT_LIMIT),
    html: truncate(el.outerHTML, HTML_LIMIT),
    // A copy, so a DOMRect passed in does not bring its other fields along.
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    styles: Object.fromEntries(STYLE_PROPS.map((prop) => [prop, computed.getPropertyValue(prop)])),
  };
}

// The first `keep` characters and an ellipsis, without leaving half a surrogate pair.
function cut(text: string, keep: number): string {
  const kept = text.slice(0, keep);
  return (/[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept) + ELLIPSIS;
}

// The rendered text where the browser has it (innerText), otherwise the text content.
function visibleText(el: Element): string {
  if ('innerText' in el && typeof el.innerText === 'string') return el.innerText;
  return el.textContent ?? '';
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Each line collapsed, empty lines dropped.
function tidyLines(text: string): string {
  return text.split('\n').map(collapse).filter((line) => line !== '').join('\n');
}

// The selector of `el` within one root, a document or a shadow root: `#id` when the id is
// unique there, otherwise tag steps up to an ancestor with a unique id or to the top.
function selectorWithin(root: ParentNode, el: Element): string {
  const steps: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const id = uniqueIdSelector(root, node);
    if (id) return [id, ...steps].join(' > ');
    steps.unshift(typeStep(node));
  }
  // Steps from the top can also match deeper down, as `p > span` can in a shadow root whose
  // top-level p and a nested p both hold a span. `:not(* > *)` pins the first step to the top.
  const selector = steps.join(' > ');
  const matches = root.querySelectorAll(selector);
  if (matches.length === 1 && matches[0] === el) return selector;
  steps[0] += ':not(* > *)';
  return steps.join(' > ');
}

function uniqueIdSelector(root: ParentNode, el: Element): string | null {
  if (!el.id) return null;
  const selector = `#${escapeIdentifier(el.id)}`;
  return root.querySelectorAll(selector).length === 1 ? selector : null;
}

// `tag`, or `tag:nth-of-type(n)` when siblings share the tag.
function typeStep(el: Element): string {
  const tag = escapeIdentifier(el.localName);
  const { index, count } = typePosition(el);
  return count > 1 ? `${tag}:nth-of-type(${index})` : tag;
}

function pathStep(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const classes = Array.from(el.classList, (name) => `.${name}`).join('');
  const { index, count } = typePosition(el);
  return `${el.localName}${id}${classes}${count > 1 ? ` (${index} of ${count})` : ''}`;
}

// The 1-based position of `el` among its siblings of the same type, and how many there are.
function typePosition(el: Element): { index: number; count: number } {
  const siblings = el.parentNode ? Array.from(el.parentNode.children) : [el];
  const sameType = siblings.filter((sibling) =>
    sibling.localName === el.localName && sibling.namespaceURI === el.namespaceURI);
  return { index: sameType.indexOf(el) + 1, count: sameType.length };
}

function escapeIdentifier(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return serializeIdentifier(value);
}

// CSS.escape written out (https://drafts.csswg.org/cssom/#serialize-an-identifier), for
// environments that lack it.
function serializeIdentifier(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const code = value.charCodeAt(i);
    const isDigit = code >= 0x30 && code <= 0x39;
    if (code === 0) {
      result += '�';
    } else if (code <= 0x1f || code === 0x7f || (isDigit && (i === 0 || (i === 1 && value[0] === '-')))) {
      result += `\\${code.toString(16)} `;
    } else if (i === 0 && char === '-' && value.length === 1) {
      result += `\\${char}`;
    } else if (code >= 0x80 || /[\w-]/.test(char)) {
      result += char;
    } else {
      result += `\\${char}`;
    }
  }
  return result;
}
