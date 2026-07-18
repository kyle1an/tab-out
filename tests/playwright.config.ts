import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:8765',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1420, height: 900 }
  },
  webServer: {
    command: 'pnpm serve',
    url: 'http://127.0.0.1:8765/tests/fixtures/dashboard-resize.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
})
