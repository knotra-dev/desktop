import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:1420',
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://127.0.0.1:1420',
          localStorage: [{ name: 'knotra.tour.v1', value: 'dismissed' }],
        },
      ],
    },
    viewport: { width: 1440, height: 940 },
    trace: 'retain-on-failure',
    launchOptions: process.env.KNOTRA_CHROMIUM
      ? { executablePath: process.env.KNOTRA_CHROMIUM }
      : {},
  },
  webServer: {
    command: 'bun run dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
});
