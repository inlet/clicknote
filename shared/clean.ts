import type { Annotation, PageInfo } from './types.ts';

// Characters a reader of the page does not see, and an agent reading its text does: the tag
// characters, the controls that set the direction of text, and the zero-width characters.
const HIDDEN_CHARACTERS =
  /[\u{E0000}-\u{E007F}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/gu;

// An HTML comment; or the opening tag of a script or style element, in group 1, and what the
// element holds. Each runs to the end of the HTML when it is not closed there.
const HIDDEN_HTML = /<!--[\s\S]*?(?:-->|$)|(<(script|style)(?=[\s/>])[^>]*>)[\s\S]*?(?=<\/\2[\s/>]|$)/gi;

// The text without the characters a reader cannot see. Everything else stays, line breaks too.
export function cleanText(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, '');
}

// cleanText, and the HTML without its comments and without what its script and style elements
// hold; the tags of those elements stay. It repeats until nothing is left to remove, because
// taking one comment out can join the text around it into another.
export function cleanHtml(html: string): string {
  let cleaned = cleanText(html);
  for (let before = ''; cleaned !== before;) {
    before = cleaned;
    cleaned = cleaned.replace(HIDDEN_HTML, (_match, openingTag: string | undefined) => openingTag ?? '');
  }
  return cleaned;
}

// A run of white space, line breaks included.
const SPACE = /\p{White_Space}+/gu;

// cleanText, on one line: each run of white space, a line break too, becomes one space, and the
// ends are trimmed.
function cleanLine(text: string): string {
  return cleanText(text).replace(SPACE, ' ').trim();
}

// A copy of the annotation with what the page wrote cleaned: the label, the selector, the DOM
// path, the text, the HTML and the value of each style. The label is made one line. The comment,
// the intent and the id stay as they are.
export function cleanAnnotation<T extends Annotation>(annotation: T): T {
  return {
    ...annotation,
    label: cleanLine(annotation.label),
    selector: cleanText(annotation.selector),
    domPath: cleanText(annotation.domPath),
    text: cleanText(annotation.text),
    html: cleanHtml(annotation.html),
    styles: Object.fromEntries(Object.entries(annotation.styles).map(([prop, value]) => [prop, cleanText(value)])),
  };
}

// A copy of the page with its title cleaned. The URL stays as it is.
export function cleanPage(page: PageInfo): PageInfo {
  return { ...page, title: cleanText(page.title) };
}
