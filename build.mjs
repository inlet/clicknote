// Bundles the bridge and the extension with esbuild.
//
//   node build.mjs        dist/bridge/cli.mjs with its copy in the skill,
//                         skills/clicknote/scripts/clicknote.mjs, and dist/extension/
//   node build.mjs --e2e  dist/extension-e2e/, with __E2E__ true, access to every page, and the
//                         content script of the open page on the test port
//
// Entry points that do not exist yet are skipped.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_PORT, BRIDGE_PORT_E2E } from './shared/types.ts';

const root = dirname(fileURLToPath(import.meta.url));
const e2e = process.argv.includes('--e2e');
const extensionOut = join(root, 'dist', e2e ? 'extension-e2e' : 'extension');
const define = { __E2E__: JSON.stringify(e2e) };

const bundles = [
  ...(e2e ? [] : [{
    entry: 'bridge/src/cli.ts',
    outfile: join(root, 'dist', 'bridge', 'cli.mjs'),
    platform: 'node',
    format: 'esm',
    // npx runs the bundle as the package's command, which needs the line for Node first.
    banner: { js: '#!/usr/bin/env node' },
    // The skill carries the same file, which an agent runs with Node from the skill's folder.
    copy: join(root, 'skills', 'clicknote', 'scripts', 'clicknote.mjs'),
  }]),
  {
    entry: 'extension/src/background.ts',
    outfile: join(extensionOut, 'background.js'),
    platform: 'browser',
    format: 'iife',
  },
  {
    entry: 'extension/src/content/main.ts',
    outfile: join(extensionOut, 'content.js'),
    platform: 'browser',
    format: 'iife',
  },
  {
    entry: 'extension/src/opened.ts',
    outfile: join(extensionOut, 'opened.js'),
    platform: 'browser',
    format: 'iife',
  },
];

for (const { entry, copy, ...options } of bundles) {
  const entryPath = join(root, entry);
  if (!existsSync(entryPath)) {
    console.log(`skipped ${entry}: not there yet`);
    continue;
  }
  await build({
    entryPoints: [entryPath],
    absWorkingDir: root,
    bundle: true,
    define,
    logLevel: 'warning',
    ...options,
  });
  console.log(`built ${entry} -> ${relative(root, options.outfile)}`);
  if (copy) {
    await mkdir(dirname(copy), { recursive: true });
    await copyFile(options.outfile, copy);
    console.log(`copied ${relative(root, options.outfile)} -> ${relative(root, copy)}`);
  }
}

const manifestPath = join(root, 'extension', 'manifest.json');
if (existsSync(manifestPath)) {
  await mkdir(extensionOut, { recursive: true });
  const target = join(extensionOut, 'manifest.json');
  if (e2e) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    // The bridge of the browser tests listens on the test port, and so does its open page.
    for (const script of manifest.content_scripts ?? []) {
      script.matches = script.matches.map(pattern => pattern.replace(`:${BRIDGE_PORT}/`, `:${BRIDGE_PORT_E2E}/`));
    }
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    await copyFile(manifestPath, target);
  }
  console.log(`copied extension/manifest.json -> ${relative(root, target)}`);
} else {
  console.log('skipped extension/manifest.json: not there yet');
}

// The PNG icons are made from the SVG drawings next to them by extension/icons/render.mjs, which is
// run by hand when a drawing changes; the build only copies them:
//   node extension/icons/render.mjs
const iconsDir = join(root, 'extension', 'icons');
if (existsSync(iconsDir)) {
  await mkdir(join(extensionOut, 'icons'), { recursive: true });
  for (const name of (await readdir(iconsDir)).filter(name => name.endsWith('.png')).sort()) {
    await copyFile(join(iconsDir, name), join(extensionOut, 'icons', name));
    console.log(`copied extension/icons/${name} -> ${relative(root, join(extensionOut, 'icons', name))}`);
  }
}
