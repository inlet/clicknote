# Clicknote: agent guidelines

## Build output

`dist/bridge` and `dist/extension` are committed: `npx` runs Clicknote from the repository, and the release zips the extension from it. The build also writes the command into the skill, as `skills/clicknote/scripts/clicknote.mjs`, which is committed too. After a change to the source, run `npm run bundle` and commit the result with it. CI fails when the committed output differs from what the source builds.

## Checks

Run `npm test`, `npm run typecheck` and `npm run test:e2e` before a pull request. The browser tests need Playwright's Chromium, once: `npx playwright install chromium`. Clicknote runs on Node 22.0 or later, but the tests need what jsdom asks for: 22.22.2 or later on Node 22, 24.15.0 or later on Node 24, or Node 26 and later.

## Commits

Conventional Commits: `type(scope): summary`, with the types feat, fix, docs, chore, refactor, test, build, ci, perf and style. The summary is in the imperative mood, in lower case, without a full stop.

## Versions and releases

The version in `package.json` and in `extension/manifest.json` must always match. A release is an annotated tag `vX.Y.Z` on `main` with that version. It starts the release workflow, which makes the GitHub release with the extension zip.

## Pull requests

A change you can see in the extension gets a screenshot in the description, of the changed part in the state the change is about. Take it with the test build, the way `docs/readme/screenshot.mjs` does, commit the PNG under `docs/readme/`, and link it as `https://github.com/inlet/clicknote/blob/<full commit sha>/docs/readme/<name>.png?raw=true`.

Pull requests are squash-merged, with the subject `<pull request title> (#<number>)`.
