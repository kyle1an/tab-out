import { expect, test } from '@playwright/test'

test('dashboard avoids eager tooltip measurement surfaces', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await expect(page.locator('.page-chip-tooltip-measure')).toHaveCount(0)
  await expect(page.locator('.history-entry-title-expansion-measure')).toHaveCount(0)
  await expect(page.locator('[data-slot="tooltip-content"]:visible')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
