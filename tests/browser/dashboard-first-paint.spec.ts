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

test('dashboard coalesces collapsed-title layout reads during startup', async ({ page }) => {
  await page.addInitScript(() => {
    const counts = {
      chipTextRects: 0,
      historyTitleRects: 0,
      layoutShift: 0
    }
    const benchmarkWindow = window as typeof window & {
      __tabOutFirstPaintMeasurements: typeof counts
    }
    benchmarkWindow.__tabOutFirstPaintMeasurements = counts

    const getBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getInstrumentedBoundingClientRect() {
      if (this instanceof HTMLElement) {
        if (this.classList.contains('history-entry-title')) counts.historyTitleRects += 1
        if (this.classList.contains('chip-text') || this.classList.contains('chip-title-row')) {
          counts.chipTextRects += 1
        }
      }
      return getBoundingClientRect.call(this)
    }

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<PerformanceEntry & {
        hadRecentInput: boolean
        value: number
      }>) {
        if (!entry.hadRecentInput) counts.layoutShift += entry.value
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await expect(page.locator('.missions.is-packed')).toHaveCount(1)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  const measurements = await page.evaluate(() => {
    const benchmarkWindow = window as typeof window & {
      __tabOutFirstPaintMeasurements: {
        chipTextRects: number
        historyTitleRects: number
        layoutShift: number
      }
    }
    return {
      ...benchmarkWindow.__tabOutFirstPaintMeasurements,
      chipCount: document.querySelectorAll('[data-tabout="page-chip"]').length,
      historyTitleCount: document.querySelectorAll('.history-entry-title').length
    }
  })

  expect(measurements.chipCount).toBeGreaterThan(0)
  expect(measurements.historyTitleCount).toBeGreaterThan(0)
  expect(measurements.chipTextRects / measurements.chipCount).toBeLessThanOrEqual(20)
  expect(measurements.historyTitleRects / measurements.historyTitleCount).toBeLessThanOrEqual(10)
  expect(measurements.layoutShift).toBe(0)
})

test('long Page Chip paints its final truncation treatment on the first refresh frame', async ({ page }) => {
  const targetTitle = 'Example 2 with enough tooltip text to prove viewport-edge collision flipping keeps the popup visible'
  await page.addInitScript((title) => {
    const paintWindow = window as typeof window & {
      __tabOutTitlePaintFrames: Array<{
        hasFade: boolean
        maskImage: string
        verticalOverflow: number
      }>
    }
    paintWindow.__tabOutTitlePaintFrames = []

    let frameCount = 0
    const captureFrame = () => {
      frameCount += 1
      const chip = Array.from(document.querySelectorAll<HTMLElement>('[data-tabout="page-chip"]'))
        .find((element) => element.textContent?.includes(title))
      const text = chip?.querySelector<HTMLElement>('.chip-text')
      if (text) {
        paintWindow.__tabOutTitlePaintFrames.push({
          hasFade: text.classList.contains('chip-text-truncated'),
          maskImage: getComputedStyle(text).maskImage,
          verticalOverflow: text.scrollHeight - text.clientHeight
        })
      }
      if (frameCount < 120) requestAnimationFrame(captureFrame)
    }
    requestAnimationFrame(captureFrame)
  }, targetTitle)

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutTitlePaintFrames: unknown[]
    }
    return paintWindow.__tabOutTitlePaintFrames.length
  })).toBeGreaterThan(1)

  const firstTitleFrame = await page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutTitlePaintFrames: Array<{
        hasFade: boolean
        maskImage: string
        verticalOverflow: number
      }>
    }
    return paintWindow.__tabOutTitlePaintFrames[0]
  })

  expect(firstTitleFrame.hasFade).toBe(true)
  expect(firstTitleFrame.maskImage).not.toBe('none')
  expect(firstTitleFrame.verticalOverflow).toBeLessThanOrEqual(1)
})
