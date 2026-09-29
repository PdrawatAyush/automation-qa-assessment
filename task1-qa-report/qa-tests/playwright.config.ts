import { defineConfig } from '@playwright/test';

// Runs against the locally started Conduit app (see ../../setup/start-realworld.ps1).
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  workers: 1, // one shared local database -> keep runs deterministic
  reporter: [['list'], ['json', { outputFile: '../evidence/playwright-results.json' }]],
  outputDir: './test-results',
  use: {
    baseURL: process.env.APP_URL ?? 'http://localhost:4200',
    channel: 'chrome', // uses the installed Google Chrome, no browser download needed
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
