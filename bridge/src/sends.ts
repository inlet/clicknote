import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanAnnotation, cleanPage } from '../../shared/clean.ts';
import { renderMarkdown } from '../../shared/markdown.ts';
import type { SendPayload } from '../../shared/types.ts';
import { stateDir } from './paths.ts';

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function sendsDir(): string {
  return resolve(stateDir(), 'sends');
}

// Writes the send's folder, sends/<YYYYMMDD-HHMMSS> in local time, with annotations.md,
// annotations.json and <number>.png for each annotation that has an image. Returns the
// absolute path of the folder. Both files hold the page and the annotations with what the page
// wrote cleaned.
export function writeSend(payload: SendPayload, now = new Date()): string {
  const { note, images } = payload;
  const page = cleanPage(payload.page);
  const folder = createFolder(sendsDir(), folderName(now));
  const annotations = payload.annotations.map(annotation => ({
    ...cleanAnnotation(annotation),
    screenshot: Object.hasOwn(images, annotation.id) ? `${annotation.number}.png` : null,
  }));
  for (const annotation of annotations) {
    if (annotation.screenshot === null) continue;
    writeFileSync(join(folder, annotation.screenshot), Buffer.from(images[annotation.id], 'base64'));
  }
  writeFileSync(join(folder, 'annotations.md'), renderMarkdown(page, note, annotations));
  writeFileSync(join(folder, 'annotations.json'), `${JSON.stringify({ page, note, annotations }, null, 2)}\n`);
  return folder;
}

// Removes the send folders last modified more than 7 days before now.
export function pruneSends(now = new Date()): void {
  const base = sendsDir();
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const cutoff = now.getTime() - KEEP_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(base, entry.name);
    const stats = statSync(folder, { throwIfNoEntry: false });
    if (stats && stats.mtimeMs < cutoff) rmSync(folder, { recursive: true, force: true });
  }
}

// The folder name for a send at this moment: YYYYMMDD-HHMMSS in local time.
function folderName(now: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  return `${date}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

// Creates base/name, or base/name-2, name-3 and so on when that folder exists already.
function createFolder(base: string, name: string): string {
  mkdirSync(base, { recursive: true });
  for (let count = 1; ; count++) {
    const folder = join(base, count === 1 ? name : `${name}-${count}`);
    try {
      mkdirSync(folder);
      return folder;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
