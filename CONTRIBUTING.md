# Contributing

## Build and test

```sh
npm install
npm test                    # unit tests (node --test)
npm run typecheck           # tsc --noEmit
npm run bundle              # builds dist/bridge, its copy in the skill, and dist/extension
npm run test:e2e            # builds dist/extension-e2e and runs the browser tests with Playwright
npm run readme:screenshot   # builds dist/extension-e2e and makes the pictures of the look in docs/readme/
```

Before the first `npm run test:e2e` or `npm run readme:screenshot`, install Playwright's Chromium with `npx playwright install chromium`.

Clicknote itself runs on Node 22.0 or later. The tests need a newer Node: Node runs their TypeScript without a flag only from 22.18, and jsdom asks for 22.22.2 or later on Node 22, 24.15.0 or later on Node 24, or Node 26 and later.

## The tests

The bridge tests use a temporary state folder and start the bridge on a free port. The tests of the commands run them against that bridge, the way an agent does. The browser tests load a test build of the extension, `dist/extension-e2e`, in Playwright's Chromium. Most of them put a stand-in in place of the bridge; `test/e2e/roundtrip.spec.ts` and `test/e2e/link.spec.ts` run a real one, with agents that register through the commands. That build differs from the real one: it may access every page, its UI is open to the tests, and it calls the bridge on port 47824 instead of 47823, so it never reaches a bridge you run. [`docs/readme/screenshot.mjs`](docs/readme/screenshot.mjs), which `npm run readme:screenshot` runs, makes the pictures of the look the same way, from the demo page [`docs/readme/demo.html`](docs/readme/demo.html): `annotating.png`, the screenshot under How in the README, in light mode; `look-dark.png`, the same in dark mode; `look-queued.png`, the bar after a send that is queued, with its line on offer; `look-icons.png`, the four icons on a light and on a dark toolbar; and `social-preview.png`, the repository's social preview, which GitHub does not read from the repository: upload it by hand under Settings, General, Social preview.

## Build output, CI and releases

`dist/bridge` and `dist/extension` are committed, and so is the copy of the command in the skill, `skills/clicknote/scripts/clicknote.mjs`: `npx` runs Clicknote from the repository, the skill carries the command to the agent, and the release zips the extension from `dist/extension`. The build writes the command to `dist/bridge/cli.mjs` and copies it into the skill. So run `npm run bundle` and commit the result with every change to the source. CI fails when the committed build output, the copy in the skill included, differs from what the source builds.

CI runs the unit tests on macOS, Linux and Windows on Node 24, and once more on Linux on the newest Node 22, where it also runs the built command. It runs the type check, the check of the build output and the browser tests on Linux. It runs for a pull request and for a push to `main`, so a branch gets its first run when its pull request is opened. A tag `vX.Y.Z` makes the GitHub release with the extension zip, `clicknote-extension-vX.Y.Z.zip`, after checking that the tag, `package.json` and the extension's manifest carry the same version, that the unit tests pass, and that the committed build output matches the source.

The extension's icons are PNGs made from the SVG drawings in `extension/icons/`: `icon.svg` for 128 px, `icon-small.svg` for 48 and 32 px, and `icon-16.svg` for 16 px. When a drawing changes, make them again with `node extension/icons/render.mjs`, which uses Playwright's Chromium. The build only copies them.

## Trying a change

After changing the code, run `npm run bundle`, load the extension from `dist/extension` or reload it at `chrome://extensions`, and run the command from the repository with `node dist/bridge/cli.mjs` instead of the skill's copy. Stop a running bridge first, with `node dist/bridge/cli.mjs stop`. Reloading the extension drops the unsent annotations.

## What building and testing add

Building and testing leave these on your machine:

| Path | What it is | Why it is needed |
|---|---|---|
| `node_modules/` in the repository | The packages `npm install` installs: esbuild, TypeScript, Playwright's test runner, jsdom and type definitions. | Building, and running the tests. Clicknote needs none of them at run time. |
| `dist/extension-e2e/` in the repository | The test build of the extension. It is not committed. | The browser tests and the screenshot script load it. |
| `test-results/` in the repository | What Playwright leaves after the browser tests. It is not committed. | Looking into a failed browser test. |
| npm's cache | Filled by `npm install` as for any project. | npm keeps downloaded packages there. |
| Playwright's Chromium | Installed by `npx playwright install chromium`, in `~/Library/Caches/ms-playwright/` on macOS, `~/.cache/ms-playwright/` on Linux and `%LOCALAPPDATA%\ms-playwright\` on Windows. | Only for running the browser tests and the screenshot script, and for making the icons. Using Clicknote does not need it. |
