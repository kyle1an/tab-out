import { expect, test, type Page } from '@playwright/test'

type DashboardGeometry = {
  cardCount: number
  columns: number
  firstWidth: number
  headerControlsRight: number | null
  missionsRight: number | null
  sourceSwitchRight: number | null
}

async function measureDashboard(page: Page, width: number): Promise<DashboardGeometry> {
  await page.setViewportSize({ width, height: 900 })
  await expect.poll(() => page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('.missions:not(.missions-empty)')
    const cards = Array.from(container?.querySelectorAll<HTMLElement>('[data-tabout="domain-card"]') || [])
    if (!container || cards.length < 12 || !container.classList.contains('is-packed')) return false

    const columnIndexes = cards.map((card) => Number(card.dataset.masonryCol))
    if (columnIndexes.some((column) => !Number.isInteger(column) || column < 0)) return false

    const style = getComputedStyle(container)
    const gap = Number.parseFloat(style.getPropertyValue('--masonry-gap')) || 10
    const columnCount = Math.max(...columnIndexes) + 1
    const expectedWidth = (container.clientWidth - gap * (columnCount - 1)) / columnCount
    const widthsMatch = cards.every((card) => Math.abs(Number.parseFloat(card.style.width) - expectedWidth) <= 1)
    const movementFinished = !container.querySelector('.layout-moving')
    return widthsMatch && movementFinished
  }), {
    message: `masonry should finish repacking at ${width}px`,
    timeout: 5_000,
    intervals: [50, 100, 150]
  }).toBe(true)

  const readGeometry = () => page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-tabout="domain-card"]'))
    const rects = cards.map((card) => card.getBoundingClientRect()).filter((rect) => rect.width > 0)
    const sourceSwitchRect = document.querySelector('[data-tabout="source-switch"]')?.getBoundingClientRect()
    const headerControlsRect = document.querySelector('.header-controls')?.getBoundingClientRect()
    const missionsRect = document.querySelector('.missions:not(.missions-empty)')?.getBoundingClientRect()
    const round = (value: number) => Math.round(value * 100) / 100

    return {
      cardCount: rects.length,
      columns: new Set(rects.map((rect) => Math.round(rect.left))).size,
      firstWidth: Math.round(rects[0]?.width || 0),
      headerControlsRight: headerControlsRect ? round(headerControlsRect.right) : null,
      missionsRight: missionsRect ? round(missionsRect.right) : null,
      sourceSwitchRight: sourceSwitchRect ? round(sourceSwitchRect.right) : null
    }
  })

  let previous = ''
  let latest: DashboardGeometry | null = null
  await expect.poll(async () => {
    latest = await readGeometry()
    const serialized = JSON.stringify(latest)
    const stable = serialized === previous && latest.cardCount >= 12
    previous = serialized
    return stable
  }, {
    message: `dashboard geometry should settle at ${width}px`,
    timeout: 5_000,
    intervals: [50, 100, 150]
  }).toBe(true)

  return latest as DashboardGeometry
}

test('dashboard repacks across viewport sizes', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const wide = await measureDashboard(page, 1420)
  const narrow = await measureDashboard(page, 760)

  expect(wide.columns).toBeGreaterThan(narrow.columns)
  expect(wide.firstWidth).not.toBe(narrow.firstWidth)
  expect(Math.abs((wide.headerControlsRight ?? 0) - (wide.missionsRight ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((wide.sourceSwitchRight ?? 0) - (wide.missionsRight ?? 0))).toBeLessThanOrEqual(1)
  expect(pageErrors).toEqual([])
})
