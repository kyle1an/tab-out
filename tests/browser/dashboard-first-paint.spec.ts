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
      chipTextFadeRangeRects: 0,
      chipTextRangeRects: 0,
      chipTextRects: 0,
      domainCardRects: 0,
      historyTitleFadeRangeRects: 0,
      historyTitleRangeRects: 0,
      historyTitleRects: 0,
      pathgroupLabelSizeReads: 0,
      layoutShift: 0
    }
    const benchmarkWindow = window as typeof window & {
      __tabOutFirstPaintMeasurements: typeof counts
    }
    benchmarkWindow.__tabOutFirstPaintMeasurements = counts

    const getBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getInstrumentedBoundingClientRect() {
      if (this instanceof HTMLElement) {
        if (this.matches('[data-tabout="domain-card"]')) counts.domainCardRects += 1
        if (this.classList.contains('history-entry-title')) counts.historyTitleRects += 1
        if (this.classList.contains('chip-text') || this.classList.contains('chip-title-row')) {
          counts.chipTextRects += 1
        }
      }
      return getBoundingClientRect.call(this)
    }

    for (const property of ['clientWidth', 'scrollWidth'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property)
      const getSize = descriptor?.get
      if (!descriptor || !getSize) continue
      Object.defineProperty(Element.prototype, property, {
        ...descriptor,
        get() {
          if (this instanceof HTMLElement && this.matches('.pathgroup-header .chip-pathgroup')) {
            counts.pathgroupLabelSizeReads += 1
          }
          return getSize.call(this)
        }
      })
    }

    const getClientRects = Range.prototype.getClientRects
    Range.prototype.getClientRects = function getInstrumentedClientRects() {
      const ancestor = this.commonAncestorContainer
      const element = ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement
      const chipText = element?.closest('.chip-text, .chip-title-row') as HTMLElement | null
      const historyTitle = element?.closest('.history-entry-title') as HTMLElement | null
      if (chipText) {
        counts.chipTextRangeRects += 1
        if (this.startContainer === chipText && this.endContainer === chipText) {
          counts.chipTextFadeRangeRects += 1
        }
      }
      if (historyTitle) {
        counts.historyTitleRangeRects += 1
        if (this.startContainer === historyTitle && this.endContainer === historyTitle) {
          counts.historyTitleFadeRangeRects += 1
        }
      }
      return getClientRects.call(this)
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
        chipTextFadeRangeRects: number
        chipTextRangeRects: number
        chipTextRects: number
        domainCardRects: number
        historyTitleFadeRangeRects: number
        historyTitleRangeRects: number
        historyTitleRects: number
        pathgroupLabelSizeReads: number
        layoutShift: number
      }
    }
    return {
      ...benchmarkWindow.__tabOutFirstPaintMeasurements,
      chipCount: document.querySelectorAll('[data-tabout="page-chip"]').length,
      domainCardCount: document.querySelectorAll('[data-tabout="domain-card"]').length,
      historyTitleCount: document.querySelectorAll('.history-entry-title').length,
      pathgroupLabelCount: document.querySelectorAll('.pathgroup-header .chip-pathgroup').length
    }
  })

  expect(measurements.chipCount).toBeGreaterThan(0)
  expect(measurements.domainCardCount).toBeGreaterThan(0)
  expect(measurements.historyTitleCount).toBeGreaterThan(0)
  expect(measurements.chipTextFadeRangeRects).toBe(0)
  expect(measurements.chipTextRangeRects / measurements.chipCount).toBeLessThanOrEqual(12)
  expect(measurements.chipTextRects / measurements.chipCount).toBeLessThanOrEqual(4)
  expect(measurements.domainCardRects / measurements.domainCardCount).toBeLessThanOrEqual(2)
  expect(measurements.historyTitleFadeRangeRects).toBe(0)
  expect(measurements.historyTitleRangeRects / measurements.historyTitleCount).toBeLessThanOrEqual(12)
  expect(measurements.historyTitleRects / measurements.historyTitleCount).toBeLessThanOrEqual(3)
  expect(measurements.pathgroupLabelCount).toBeGreaterThan(0)
  expect(measurements.pathgroupLabelSizeReads / measurements.pathgroupLabelCount).toBeLessThanOrEqual(2)
  expect(measurements.layoutShift).toBe(0)
})

test('Activation History defers hidden scrollbar geometry past its first content frame', async ({ page }) => {
  await page.setViewportSize({ width: 1420, height: 360 })
  await page.addInitScript(() => {
    type FirstHistoryContentFrame = {
      historyTitleCount: number
      scrollbarGeometryReads: number
      scrollbarMounted: boolean
    }
    const paintWindow = window as typeof window & {
      __tabOutFirstHistoryContentFrame: FirstHistoryContentFrame | null
    }
    paintWindow.__tabOutFirstHistoryContentFrame = null
    let scrollbarGeometryReads = 0

    for (const property of ['clientHeight', 'scrollHeight', 'scrollTop'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, property)
      const getSize = descriptor?.get
      if (!descriptor || !getSize) continue
      Object.defineProperty(Element.prototype, property, {
        ...descriptor,
        get() {
          if (this instanceof HTMLElement && this.classList.contains('history-entry-list')) {
            scrollbarGeometryReads += 1
          }
          return getSize.call(this)
        }
      })
    }

    let frameCount = 0
    const captureFrame = () => {
      frameCount += 1
      const historyTitleCount = document.querySelectorAll('.history-entry-title').length
      if (historyTitleCount > 0) {
        paintWindow.__tabOutFirstHistoryContentFrame = {
          historyTitleCount,
          scrollbarGeometryReads,
          scrollbarMounted: !!document.querySelector('[data-tabout-part="history-scrollbar"]')
        }
        return
      }
      if (frameCount < 120) requestAnimationFrame(captureFrame)
    }
    requestAnimationFrame(captureFrame)
  })

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutFirstHistoryContentFrame: unknown
    }
    return paintWindow.__tabOutFirstHistoryContentFrame
  })).not.toBeNull()

  const firstContentFrame = await page.evaluate(() => {
    const paintWindow = window as typeof window & {
      __tabOutFirstHistoryContentFrame: {
        historyTitleCount: number
        scrollbarGeometryReads: number
        scrollbarMounted: boolean
      }
    }
    return paintWindow.__tabOutFirstHistoryContentFrame
  })

  expect(firstContentFrame.historyTitleCount).toBeGreaterThan(0)
  expect(firstContentFrame.scrollbarGeometryReads).toBe(0)
  expect(firstContentFrame.scrollbarMounted).toBe(false)
  const scrollbar = page.locator('[data-tabout-part="history-scrollbar"]')
  await expect(scrollbar).toHaveCount(1)
  await expect(scrollbar.locator('.history-entry-scrollbar-thumb')).toHaveCSS('opacity', '0')
})

test('long Page Chip paints its final truncation treatment on the first refresh frame', async ({ page }) => {
  const targetTitle = 'Example 2 with enough tooltip text to prove viewport-edge collision flipping keeps the popup visible'
  await page.addInitScript((title) => {
    const paintWindow = window as typeof window & {
      __tabOutTitlePaintFrames: Array<{
        fadeEnd: number
        hasFade: boolean
        maskImage: string
        width: number
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
          fadeEnd: Number.parseFloat(text.style.getPropertyValue('--title-fade-end')),
          hasFade: text.classList.contains('chip-text-truncated'),
          maskImage: getComputedStyle(text).maskImage,
          width: text.getBoundingClientRect().width,
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
        fadeEnd: number
        hasFade: boolean
        maskImage: string
        width: number
        verticalOverflow: number
      }>
    }
    return paintWindow.__tabOutTitlePaintFrames[0]
  })

  expect(firstTitleFrame.hasFade).toBe(true)
  expect(firstTitleFrame.maskImage).not.toBe('none')
  expect(Math.abs(firstTitleFrame.fadeEnd - firstTitleFrame.width)).toBeLessThanOrEqual(0.1)
  expect(firstTitleFrame.verticalOverflow).toBeLessThanOrEqual(1)
})
