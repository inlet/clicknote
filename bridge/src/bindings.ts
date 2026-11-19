import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentInfo } from '../../shared/types.ts';
import { filePath, parseUrl } from '../../shared/url.ts';
import { stateDir } from './paths.ts';

// A binding as stored. A send makes it, and so does the bridge when the open address of a link,
// which the open command writes, is first requested. The source says which one; both are read
// alike.
interface Binding { agent: string; at: number; source: 'link' | 'send' }
type Bindings = Record<string, Binding>;

// The key a page is bound under: the origin for http and https pages, file:// with the host
// and the folder of the file for file pages (decoded, as the URL writes it, ending in a slash:
// file:///Users/you/site/, file:///C:/Users/you/site/, file://nas/share/site/), and null for
// any other URL.
export function bindingKey(url: string): string | null {
  const parsed = parseUrl(url);
  if (parsed?.protocol === 'http:' || parsed?.protocol === 'https:') return parsed.origin;
  const path = filePath(url);
  if (!parsed || path === null) return null;
  return `file://${parsed.host}${path.slice(0, path.lastIndexOf('/') + 1)}`;
}

// Binds the page's site to the agent, replacing the site's earlier binding. A page
// without a key is not bound.
export function recordBinding(url: string, agent: string, source: 'link' | 'send', now = Date.now()): void {
  const key = bindingKey(url);
  if (key === null) return;
  const bindings = readBindings();
  bindings[key] = { agent, at: now, source };
  writeBindings(bindings);
}

// The agent to preselect for the page: the agent of the site's binding when it is still
// among the agents. A file page is covered by bindings for its folder and the folders
// above it; the deepest one whose agent is still there wins.
export function preselect(url: string, agents: AgentInfo[]): string | null {
  const key = bindingKey(url);
  if (key === null) return null;
  const living = new Set(agents.map(agent => agent.id));
  let best: { key: string; agent: string } | null = null;
  for (const [boundKey, binding] of Object.entries(readBindings())) {
    if (!covers(boundKey, key) || !living.has(binding.agent)) continue;
    if (!best || boundKey.length > best.key.length) best = { key: boundKey, agent: binding.agent };
  }
  return best?.agent ?? null;
}

// Whether a binding under boundKey applies to a page under pageKey. File keys end in a
// slash, so a prefix is the same folder or one above it.
function covers(boundKey: string, pageKey: string): boolean {
  if (boundKey === pageKey) return true;
  return boundKey.startsWith('file://') && boundKey.endsWith('/') && pageKey.startsWith(boundKey);
}

function storePath(): string {
  return join(stateDir(), 'bindings.json');
}

// The stored bindings. A missing or unreadable store is empty, and so is one that is not a regular
// file (a link, which is not followed, or a folder); entries of the wrong shape are left out. The
// store is read here and not as a record of the store module: it keeps an entry for every site
// ever bound, so nothing bounds its size below the largest record that module reads.
function readBindings(): Bindings {
  const path = storePath();
  let raw: unknown;
  try {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) return {};
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  const bindings: Bindings = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bindings;
  for (const [key, value] of Object.entries(raw)) {
    if (isBinding(value)) bindings[key] = value;
  }
  return bindings;
}

function isBinding(value: unknown): value is Binding {
  if (typeof value !== 'object' || value === null) return false;
  const { agent, at, source } = value as Record<string, unknown>;
  return typeof agent === 'string' && typeof at === 'number' && (source === 'link' || source === 'send');
}

// Writes the store through a temporary file and a rename, so a reader never sees half a file.
// When the write or the rename fails, the temporary file is removed and the error thrown on:
// each run has its own process id, so each failing run would leave one more behind.
function writeBindings(bindings: Bindings): void {
  mkdirSync(stateDir(), { recursive: true });
  const path = storePath();
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(bindings, null, 2)}\n`);
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
