import { parseUrl } from '../../shared/url.ts';

// The pages the bridge serves to the browser itself, at the open address, as text, and the
// headers to send them with. No server and no files here.

const TITLE = 'Clicknote';
const EXPIRED = 'This link has expired. Ask your agent to open the page again.';
const FILE_HELP = 'This page cannot open a local file by itself. The Clicknote extension opens it '
  + 'when "Allow access to file URLs" is switched on for it at chrome://extensions. Switch it on, then ask your agent '
  + 'to open the page again.';
const NO_EXTENSION = 'This page cannot open a local file by itself. The Clicknote extension does that, '
  + 'and it is not in this browser. Install it, then ask your agent to open the page '
  + 'again. Or copy the address below into the address bar.';

const STYLE = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { max-width: 40rem; margin: 4rem auto; padding: 0 1rem; overflow-wrap: anywhere; }
code { font-size: 0.9em; }
`;

// The page's one script, the same for every page: it reads the URL and its kind from the body's
// data attributes, and builds nothing from the link. The extension's content script, when the
// extension is there, sets the attribute data-clicknote on the root element before this script
// runs, and sends the event clicknote:linked once the extension has the tab. Without the
// extension, the script passes the tab on to a web page at once, and for a local file shows at
// once that the extension is missing. With it, the script waits for clicknote:linked, or 2000 ms
// at most, before it passes the tab on; and shows the help for a local file after 2000 ms, unless
// the extension has sent the tab on to the file by then.
// A load that comes from Back or Forward passes nothing on and says which page the tab was
// opened for; so does a page the browser brings back from its back/forward cache, where this
// script does not run again and a timer it set may still be waiting.
const SCRIPT = `
(() => {
  const { target, kind } = document.body.dataset;
  let restored = false;
  const show = shown => {
    for (const id of ['opening', 'opened', 'file-help', 'no-extension']) {
      const block = document.getElementById(id);
      if (block) block.hidden = id !== shown;
    }
  };
  const fresh = performance.getEntriesByType('navigation')[0]?.type !== 'back_forward';
  if (!fresh) {
    show('opened');
    return;
  }
  addEventListener('pageshow', event => {
    if (!event.persisted) return;
    restored = true;
    show('opened');
  });
  const watched = document.documentElement.hasAttribute('data-clicknote');
  if (kind === 'web') {
    let gone = false;
    const go = () => {
      if (gone || restored) return;
      gone = true;
      location.replace(target);
    };
    if (!watched) return go();
    document.addEventListener('clicknote:linked', go, { once: true });
    setTimeout(go, 2000);
  } else if (kind === 'file') {
    if (!watched) return show('no-extension');
    setTimeout(() => {
      if (!restored) show('file-help');
    }, 2000);
  }
})();
`;

// The open page for a link: it says which page it opens for which agent, and its script passes
// the tab on. For a web page it carries the page as a plain link, so the page can be reached
// without the script; for a local file, which a page on http cannot open, it carries the URL as
// text and two helps for the script to show: one for when the extension does not open the file,
// and one for a browser without the extension. The URL and the label are escaped wherever they
// appear.
export function openPage(link: { url: string; label: string }, nonce: string): string {
  const kind = parseUrl(link.url)?.protocol === 'file:' ? 'file' : 'web';
  const url = escapeHtml(link.url);
  const label = escapeHtml(link.label);
  const own = escapeHtml(nonce);
  const page = kind === 'web' ? `<a href="${url}" rel="noreferrer">${url}</a>` : `<code>${url}</code>`;
  const blocks = [
    `<p id="opening">Opening ${page} for ${label} …</p>`,
    `<p id="opened" hidden>This tab was opened for ${label}. The page is ${page}.</p>`,
  ];
  if (kind === 'file') {
    blocks.push(`<div id="file-help" hidden><p>${escapeHtml(FILE_HELP)}</p><p><code>${url}</code></p></div>`);
    blocks.push(`<div id="no-extension" hidden><p>${escapeHtml(NO_EXTENSION)}</p><p><code>${url}</code></p></div>`);
  }
  return htmlPage(`<style nonce="${own}">${STYLE}</style>`, `<body data-target="${url}" data-kind="${kind}">
${blocks.join('\n')}
<script nonce="${own}">${SCRIPT}</script>
</body>`);
}

// The page for a code the bridge does not know, of another form, or of an old link. It has no
// script and no style.
export function expiredPage(): string {
  return htmlPage('', `<body>
<p>${escapeHtml(EXPIRED)}</p>
</body>`);
}

// The headers of a page: no referrer for the page it passes the tab on to, not stored, its type
// not guessed, and a content security policy that allows only the script and the style that carry
// the nonce. Without a nonce, the page may have neither.
export function pageHeaders(nonce?: string): Record<string, string> {
  const own = nonce === undefined ? [] : [`script-src 'nonce-${nonce}'`, `style-src 'nonce-${nonce}'`];
  const policy = ["default-src 'none'", ...own, 'img-src data:', "base-uri 'none'", "form-action 'none'",
    "frame-ancestors 'none'"];
  return {
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': policy.join('; '),
  };
}

// A whole page with this in its head after the title, and this body. The icon is an empty data
// URL, so the browser does not ask the bridge for /favicon.ico.
function htmlPage(head: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<link rel="icon" href="data:,">${head}
</head>
${body}
</html>
`;
}

// Text as HTML that shows it as it is, in an element and in a quoted attribute.
function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
