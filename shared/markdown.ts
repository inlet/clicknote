import { cleanAnnotation, cleanPage } from './clean.ts';
import type { Annotation, Intent, PageInfo, Rect } from './types.ts';

const INTENT_HEADING: Record<Intent, string> = { change: 'Change', question: 'Question' };
const SHADOW_SEPARATOR = ' >> ';
const SELECTOR_NOTE = '- Selector note: ` >> ` steps into an open shadow root; the part after it is a selector inside that root';

// The annotations.md file the agent reads. Lines and blocks without a value are left out. What
// the page wrote is cleaned first, and the page's title, the label of an annotation and the
// values of its styles go in a code span, as the selector and the DOM path do; a page without a
// title gets its address alone, and an annotation without styles no styles line.
export function renderMarkdown(rawPage: PageInfo, note: string, annotations: Annotation[]): string {
  const page = cleanPage(rawPage);
  const blocks = [
    '# Browser annotations',
    lines([
      page.title ? `- Page: ${code(page.title)} (${page.url})` : `- Page: ${page.url}`,
      page.sourceFile && `- Source file: ${code(page.sourceFile)}`,
      `- Viewport: ${page.viewport.width}x${page.viewport.height} at ${page.devicePixelRatio}x`,
      `- Annotations: ${annotations.length}`,
    ]),
  ];
  const generalComment = note.trim();
  if (generalComment) blocks.push('## General comment', generalComment);
  for (const annotation of annotations) blocks.push(...annotationBlocks(cleanAnnotation(annotation)));
  return `${blocks.filter((block) => block !== '').join('\n\n')}\n`;
}

function annotationBlocks(annotation: Annotation): string[] {
  // In whole pixels, for reading; annotations.json has the exact values.
  const { x, y, width, height } = roundRect(annotation.rect);
  const styles = Object.entries(annotation.styles)
    .map(([prop, value]) => `${prop}: ${value}`)
    .join('; ');
  return [
    `## ${annotation.number}. ${INTENT_HEADING[annotation.intent]}: ${code(annotation.label)}`,
    annotation.comment.trim(),
    lines([
      `- ID: ${code(annotation.id)}`,
      `- Selector: ${code(annotation.selector)}`,
      annotation.selector.includes(SHADOW_SEPARATOR) ? SELECTOR_NOTE : null,
      `- DOM path: ${code(annotation.domPath)}`,
      `- Position: x ${x}, y ${y}, ${width}x${height}`,
      annotation.screenshot && `- Screenshot: ${code(annotation.screenshot)}`,
      styles && `- Styles: ${code(styles)}`,
    ]),
    ...(annotation.text ? ['Text:', fence(annotation.text)] : []),
    'HTML:',
    fence(annotation.html, 'html'),
  ];
}

function roundRect({ x, y, width, height }: Rect): Rect {
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

function lines(items: (string | null)[]): string {
  return items.filter((item) => item).join('\n');
}

// A fenced code block: three backticks, or one more than the longest backtick run inside.
function fence(content: string, info = ''): string {
  const ticks = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${ticks}${info}\n${content}\n${ticks}`;
}

// An inline code span, by the same rule; the spaces keep a backtick at either end apart
// from the delimiters and are dropped by Markdown renderers.
function code(content: string): string {
  const run = longestBacktickRun(content);
  if (run === 0) return `\`${content}\``;
  const ticks = '`'.repeat(run + 1);
  return `${ticks} ${content} ${ticks}`;
}

function longestBacktickRun(content: string): number {
  return (content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
}
