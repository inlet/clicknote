import { defineConfig } from '@playwright/test';

// The browser tests. Each spec file launches its own Chromium with the e2e build of the
// extension (see test/e2e/helpers.ts), so Playwright's own browser fixtures are not used.
export default defineConfig({
  testDir: 'test/e2e',
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
});
