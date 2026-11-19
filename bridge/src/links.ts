import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLinkable } from '../../shared/url.ts';
import { stateDir } from './paths.ts';

// The number of the form of a link file; a file of another form is not read as a link. The open
// command writes a link only while a bridge of its own version runs, which reads this form.
export const LINK_FORMAT = 1;

// How long a link holds from when it was made: one hour. It can be used more than once in it.
export const LINK_TTL_MS = 3_600_000;

// The form of a code: 32 lower-case hexadecimal characters, 128 bits from the system's random
// source. It names the link's file, and it is the only key to the open page.
export const LINK_CODE = /^[0-9a-f]{32}$/;

// A link: the page an agent opens, the agent's id and how the bar lists the agent, when the link
// was made, and whether the bridge has bound the page's site to the agent for it.
export interface Link { url: string; agent: string; label: string; at: number; bound: boolean }

// Writes a new link, made now, in the folder links in the state folder, readable by the user
// only where the system has such a setting. Gives its code.
export function writeLink(link: { url: string; agent: string; label: string }, now = Date.now()): string {
  const code = randomBytes(16).toString('hex');
  mkdirSync(linksDir(), { recursive: true, mode: 0o700 });
  writeLinkFile(code, { url: link.url, agent: link.agent, label: link.label, at: now, bound: false });
  return code;
}

// The link with this code. Null for a code of another form, for a file that is missing or not a
// link of this form, which includes a URL the open command would not take, and for a link older
// than LINK_TTL_MS.
export function readLink(code: string, now = Date.now()): Link | null {
  const link = readLinkFile(code);
  return link && now - link.at <= LINK_TTL_MS ? link : null;
}

// Marks the link with this code as bound, so a later request for its code does not bind the site
// again. A code of another form, and a file that is missing or not a link of this form, are left
// as they are.
export function markBound(code: string): void {
  const link = readLinkFile(code);
  if (link) writeLinkFile(code, { ...link, bound: true });
}

// Removes every file in the folder links that readLink would not give: old links, and files that
// are not links. Does nothing when there is no such folder.
export function pruneLinks(now = Date.now()): void {
  let entries;
  try {
    entries = readdirSync(linksDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const code = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : '';
    if (readLink(code, now) === null) rmSync(join(linksDir(), entry.name), { force: true });
  }
}

function linksDir(): string {
  return join(stateDir(), 'links');
}

function linkPath(code: string): string {
  return join(linksDir(), `${code}.json`);
}

// The link in the file of this code, whatever its age. Null for a code of another form, and for
// a file that is missing, is not a regular file (a link, which is not followed, or a folder),
// cannot be read, or is not a link of this form. The file is read here and not as a record of the
// store: the URL the open command is given has no bound on its length, so a link may be larger
// than the largest record the store reads.
function readLinkFile(code: string): Link | null {
  if (!LINK_CODE.test(code)) return null;
  const path = linkPath(code);
  try {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return null;
    return asLink(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

// The link in a parsed file, or null when a field is missing or of the wrong type, or the URL is
// not one the open command would take.
function asLink(raw: unknown): Link | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { format, url, agent, label, at, bound } = raw as Record<string, unknown>;
  if (format !== LINK_FORMAT || typeof url !== 'string' || typeof agent !== 'string' || typeof label !== 'string'
    || typeof at !== 'number' || typeof bound !== 'boolean' || !isLinkable(url)) return null;
  return { url, agent, label, at, bound };
}

// Writes the link's file through a temporary file and a rename, so a reader never sees half a
// file, readable by the user only. The temporary file is in the state folder, next to the folder
// links, so a prune, which removes every file in links that is not a link, cannot remove a link
// that is being written; it is the same file system, so the rename is still whole. It is named
// after the process, not the code: the code is a secret of the user, and others can often list
// the state folder. When the write or the rename fails, the temporary file is removed and the
// error thrown on.
function writeLinkFile(code: string, link: Link): void {
  const path = linkPath(code);
  const temp = join(stateDir(), `link-${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ format: LINK_FORMAT, ...link }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The error of the write or the rename is the one to give.
    }
    throw error;
  }
}
