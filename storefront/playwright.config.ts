import { defineConfig, devices } from '@playwright/test';

// Smoke tests run against tests/e2e/mock-server.mjs (static export + faked API), so they need no
// Supabase, Stripe or Cloudflare. Build the export first: npm run test:e2e does both.
// They drive the Google Chrome already installed on the machine (channel "chrome"), so no browser
// download is needed. Set PW_CHANNEL= (empty) to use Playwright's bundled Chromium instead.
const channel = process.env.PW_CHANNEL === undefined ? 'chrome' : process.env.PW_CHANNEL || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,       // the mock server holds one in-memory application at a time
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3111', trace: 'retain-on-failure', channel },
  webServer: {
    command: 'node tests/e2e/mock-server.mjs',
    url: 'http://localhost:3111/get-started/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel } },
  ],
});
