// The URL parsed, or null for text that is not a URL: what URL.parse gives, which Node has only
// from 22.1 on and Chrome from 126 on, and the bridge runs on Node 22.0.
export function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// The path of a file:// URL as the URL writes it, decoded, or null for any other URL:
// /Users/you/site/index.html, and /C:/Users/you/site/index.html for a Windows file.
export function filePath(url: string): string | null {
  const parsed = parseUrl(url);
  if (parsed?.protocol !== 'file:') return null;
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    return parsed.pathname;
  }
}

// The local file of a file:// page as its system writes it, or null for any other URL:
// C:\Users\you\site\index.html for a path that starts with a drive letter,
// \\nas\share\site\index.html for a URL with a host, and the path unchanged otherwise
// (/Users/you/site/index.html on macOS and Linux).
export function sourceFile(url: string): string | null {
  const path = filePath(url);
  if (path === null) return null;
  const host = parseUrl(url)?.host;
  if (host) return `\\\\${host}${path.replaceAll('/', '\\')}`;
  if (/^\/[A-Za-z]:(\/|$)/.test(path)) return path.slice(1).replaceAll('/', '\\');
  return path;
}

// Whether a page can be linked to an agent: a full http, https or file URL, so the page has a
// site to bind, without white space or control characters, which also keeps the URL on one line.
// It starts with the scheme and two slashes: the URL parser reads http:host as http://host and
// file:name as file:///name, which would bind every file page.
export function isLinkable(url: string): boolean {
  if (!/^(https?|file):\/\//i.test(url) || /[\s\p{Cc}]/u.test(url)) return false;
  const protocol = parseUrl(url)?.protocol;
  return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
}

// Whether two URLs are the same page: equal in everything but the hash.
export function samePage(a: string, b: string): boolean {
  const first = parseUrl(a);
  const second = parseUrl(b);
  if (!first || !second) return false;
  first.hash = '';
  second.hash = '';
  return first.href === second.href;
}
