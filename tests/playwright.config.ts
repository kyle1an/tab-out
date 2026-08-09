import { defineConfig } from '@playwright/test'

const browserTestPort = Number(process.env.TAB_OUT_PLAYWRIGHT_PORT || 8766)
const browserTestBaseUrl = `http://127.0.0.1:${browserTestPort}`

export default defineConfig({
  testDir: './browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  reporter: 'line',
  use: {
    baseURL: browserTestBaseUrl,
    browserName: 'chromium',
    channel: 'chromium',
    headless: true,
    viewport: { width: 1420, height: 900 },
  },
  webServer: {
    command: 'pnpm serve',
    env: { PORT: String(browserTestPort) },
    url: `${browserTestBaseUrl}/tests/fixtures/dashboard-resize.html`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
