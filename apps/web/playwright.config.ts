import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against a running stack (gateway, identity, user, notification with EMAIL_PROVIDER=fake,
 * and this app). Locally it reuses the installed Chrome (PW_CHANNEL=chrome) so no browser download
 * is needed; CI installs Playwright's Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // every spec drives the whole stack on one machine: in parallel they starve each other
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    // phone size in dark mode (the design is dark-first)
    { name: 'mobile', use: { ...devices['Pixel 7'], colorScheme: 'dark' }, grep: /@mobile/ },
  ],
});
