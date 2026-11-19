// The look of the UI as data: the colours of light and dark mode, the pairs of a text and its
// ground that must stay readable, and the icon's drawing for the bar's title. ui.ts turns the
// colours into the custom properties its stylesheet uses, `--cn-` and the token's name. Nothing
// here touches the page, so the unit tests load it in Node.

// The colours that are the same in both modes. A marker and a badge sit on the page or stand for
// what does, so they do not follow the mode; nor does the filled pill of Send and Add.
const BOTH = {
  fill: '#A9B5FF',                    // Send and Add
  'on-fill': '#1B1B1F',
  'fill-hover': '#BAC4FF',
  marker: '#FFFFFF',                  // the disc of a marker and of a badge in the list
  'marker-ink': '#1B1B1F',            // its outline and its number
  'marker-focus': '#6C74E8',          // a marker's focus ring: light mode's focus, also on a dark system
  change: '#B9F27C',                  // the hard shadow of a Change
  question: '#A9B5FF',                // and of a Question
  'icon-bar': '#A9B5FF',              // the icon: the title bar of its window,
  'icon-bubble': '#FFD08A',           // its speech bubble,
  'icon-prompt': '#1B1B1F',           // and the prompt in that bubble
};

export const LIGHT = {
  ...BOTH,
  surface: '#FFFFFF',                 // the bar and the popup
  text: '#1B1B1F',
  muted: '#55555F',
  'panel-ring': 'rgba(108, 99, 255, 0.14)',
  'panel-shadow': 'rgba(108, 99, 255, 0.22)',
  hover: '#F0F1FF',                   // a row or a button under the pointer
  footer: '#FAFAFF',                  // the bar's lower part: the comment, the dropdown, the buttons
  'footer-line': 'rgba(108, 99, 255, 0.14)',
  field: '#FFFFFF',                   // the general comment and the dropdown
  well: '#F5F5FF',                    // the popup's comment and a text on offer
  'field-ring': 'rgba(27, 27, 31, 0.14)',
  focus: '#6C74E8',
  count: '#EEF0FF',                   // the count in the bar's title
  'count-text': '#2F3490',
  pressed: '#E4E7FF',                 // Pick while it is on
  segment: '#EEF0FF',                 // the Change and Question switch
  'segment-on': '#FFFFFF',
  'segment-text': '#55555F',
  'segment-shadow': 'rgba(27, 27, 31, 0.15)',
  'outline-ground': '#FFFFFF',        // Copy, an outlined pill
  'off-ground': '#ECECF1',            // a filled pill that is off
  'off-text': '#5E5E68',              // the text of any button that is off
  'off-line': '#C9C9D2',              // the outline of an outlined pill that is off
  'good-ground': '#ECF9DD',           // the status line when something worked
  'bad-ground': '#FFEFEC',            // the status line when the user has to act
  bad: '#A3271B',
  'pick-line': '#6C74E8',             // the outline of the element under the pointer
  'pick-fill': 'rgba(169, 181, 255, 0.22)',
  'icon-ink': '#1B1B1F',              // the icon's lines
  'icon-paper': '#FFFFFF',            // and the window's body
};

export type Token = keyof typeof LIGHT;

export const DARK: Record<Token, string> = {
  ...BOTH,
  surface: '#1F1F26',
  text: '#F2F2F4',
  muted: '#A9A9B4',
  'panel-ring': 'rgba(169, 181, 255, 0.22)',
  'panel-shadow': 'rgba(0, 0, 0, 0.55)',
  hover: '#2A2A33',
  footer: '#1A1A20',
  'footer-line': 'rgba(169, 181, 255, 0.18)',
  field: '#16161C',
  well: '#16161C',
  'field-ring': 'rgba(255, 255, 255, 0.16)',
  focus: '#8C94F5',
  count: '#2F3360',
  'count-text': '#C9CEFF',
  pressed: '#33365C',
  segment: '#2A2A33',
  'segment-on': '#45454F',
  'segment-text': '#B4B4BE',
  'segment-shadow': 'rgba(0, 0, 0, 0)',
  'outline-ground': '#1A1A20',
  'off-ground': '#2A2A33',
  'off-text': '#9C9CA7',
  'off-line': '#4A4A55',
  'good-ground': '#25311E',
  'bad-ground': '#3A2226',
  bad: '#FFB4A8',
  'pick-line': '#8C94F5',
  'pick-fill': 'rgba(169, 181, 255, 0.16)',
  'icon-ink': '#F2F2F4',
  'icon-paper': '#2A2A33',
};

// Each text colour with every ground the stylesheet sets it on, the text first. Each pair keeps
// a contrast of at least 4.5 to 1 in both modes (see test/unit/look.test.ts).
export const PAIRS: readonly (readonly [text: Token, ground: Token])[] = [
  ['text', 'surface'],                // titles, comments in the list, Pick, Collapse, Delete and Cancel
  ['text', 'hover'],                  // a row or a button under the pointer
  ['text', 'pressed'],                // Pick while it is on
  ['text', 'field'],                  // the general comment and the dropdown
  ['text', 'well'],                   // the popup's comment and a text on offer
  ['text', 'outline-ground'],         // Copy and the copy button of an offer
  ['text', 'segment-on'],             // the chosen one of Change and Question
  ['text', 'good-ground'],            // the status line when something worked
  ['muted', 'surface'],               // the popup's label, the kind of a row, the empty list's hint
  ['muted', 'hover'],                 // the kind of a row under the pointer
  ['muted', 'footer'],                // the status line while something runs
  ['muted', 'field'],                 // the general comment's placeholder and the comment while it
                                      // cannot change, the dropdown without an agent
  ['muted', 'well'],                  // the popup comment's placeholder
  ['count-text', 'count'],
  ['segment-text', 'segment'],        // the other one of Change and Question
  ['on-fill', 'fill'],                // Send and Add
  ['on-fill', 'fill-hover'],          // Send and Add under the pointer
  ['off-text', 'off-ground'],         // Send and Add while they are off
  ['off-text', 'outline-ground'],     // Copy while it is off
  ['off-text', 'surface'],            // Pick and Delete while they are off
  ['bad', 'bad-ground'],              // the status line when the user has to act
  ['bad', 'surface'],                 // "no longer found" in a row
  ['bad', 'hover'],                   // the same in a row under the pointer, and Delete under it
  ['marker-ink', 'marker'],           // the number on a marker and a badge
];

// The contrast of two opaque colours, `#rgb` or `#rrggbb`, as WCAG 2 measures it: from 1, for
// two colours alike, to 21, for black and white.
export function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(colour: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour)?.[1];
  if (hex === undefined) throw new Error(`Not an opaque colour: ${colour}`);
  const full = hex.length === 3 ? [...hex].map(digit => digit + digit).join('') : hex;
  const [r, g, b] = [0, 2, 4].map(at => {
    const channel = Number.parseInt(full.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A shape of the icon: an SVG element with its geometry, filled with a colour of the look or
// with none. Every shape is drawn with the ink's line, or with its own `stroke`.
export interface Shape {
  tag: 'rect' | 'path';
  attrs: Record<string, string>;
  fill?: Token;
  stroke?: Token;
}

// The icon's simple drawing, as the bar's title shows it at 26 pixels: a window with a lilac title
// bar, and over its lower right corner a yellow speech bubble with a prompt in it. On a 64 unit
// grid, with lines 3.6 units wide.
export const ICON: { viewBox: string; strokeWidth: number; shapes: readonly Shape[] } = {
  viewBox: '0 0 64 64',
  strokeWidth: 3.6,
  shapes: [
    { tag: 'rect', attrs: { x: '7', y: '7', width: '37', height: '33', rx: '7' }, fill: 'icon-paper' },
    { tag: 'path', attrs: { d: 'M7 14a7 7 0 0 1 7-7h23a7 7 0 0 1 7 7v4H7z' }, fill: 'icon-bar' },
    { tag: 'path', attrs: { d: 'M35 27h14a8 8 0 0 1 8 8v10a8 8 0 0 1-8 8H33a8 8 0 0 1-8-8V36l-7-10z' }, fill: 'icon-bubble' },
    { tag: 'path', attrs: { d: 'M34 35l5.5 5-5.5 5M44 45h7' }, stroke: 'icon-prompt' },
  ],
};
