import { expect, test, type Locator, type Page } from '@playwright/test'

type DashboardGeometry = {
  cardCount: number
  columns: number
  firstWidth: number
  headerControlsRight: number | null
  missionsRight: number | null
  sourceSwitchRight: number | null
}

type BookmarkTreeFixture = {
  id: string
  title: string
  url?: string
  children?: BookmarkTreeFixture[]
}

type BookmarkFetchGate = {
  callCount: number
  completedCount: number
  release: () => void
  started: boolean
}

async function installBookmarkFetchGate(
  page: Page,
  replacementTree: BookmarkTreeFixture[] | null = null,
  bookmarkCount = 1
) {
  await page.evaluate(({ nextTree, nextBookmarkCount }) => {
    const fixtureWindow = window as typeof window & {
      __tabOutSmokeSetBookmarks?: (count: number) => void
      __tabOutBookmarkFetchGate?: BookmarkFetchGate
    }
    if (!nextTree) fixtureWindow.__tabOutSmokeSetBookmarks?.(nextBookmarkCount)

    const originalGetTree = window.chrome.bookmarks.getTree.bind(window.chrome.bookmarks)
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const gate: BookmarkFetchGate = {
      callCount: 0,
      completedCount: 0,
      release,
      started: false
    }
    fixtureWindow.__tabOutBookmarkFetchGate = gate
    window.chrome.bookmarks.getTree = async () => {
      gate.callCount += 1
      gate.started = true
      await blocked
      const tree = nextTree ?? await originalGetTree()
      gate.completedCount += 1
      return tree
    }
  }, { nextTree: replacementTree, nextBookmarkCount: bookmarkCount })
}

async function releaseBookmarkFetchGate(page: Page) {
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __tabOutBookmarkFetchGate?: BookmarkFetchGate
    }
    fixtureWindow.__tabOutBookmarkFetchGate?.release()
  })
}

async function waitForBookmarkFetch(page: Page) {
  await page.waitForFunction(() => (
    (window as typeof window & { __tabOutBookmarkFetchGate?: BookmarkFetchGate })
      .__tabOutBookmarkFetchGate?.started === true
  ))
}

async function collapsedTitleFadeState(title: Locator, truncatedClass: string) {
  return title.evaluate((element, className) => {
    const titleElement = element as HTMLElement
    const fadeEnd = Number.parseFloat(titleElement.style.getPropertyValue('--title-fade-end'))
    const width = titleElement.getBoundingClientRect().width
    return {
      clamped: titleElement.querySelectorAll('.clamped-title-line').length > 1,
      fadeAtEdge: Number.isFinite(fadeEnd) && Math.abs(fadeEnd - width) <= 0.1,
      masked: getComputedStyle(titleElement).maskImage !== 'none',
      truncated: titleElement.classList.contains(className)
    }
  }, truncatedClass)
}

const RESTORED_TITLE_FADE_STATE = {
  clamped: true,
  fadeAtEdge: true,
  masked: true,
  truncated: true
}

async function expectCollapsedTitleFade(title: Locator, truncatedClass: string, message?: string) {
  await expect.poll(() => collapsedTitleFadeState(title, truncatedClass), { message }).toEqual(RESTORED_TITLE_FADE_STATE)
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

test('cardless domain headers align with their mission content', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const alignments = await page.locator('[data-tabout="domain-card"]').evaluateAll((cards) => cards.map((card) => {
    const header = card.querySelector<HTMLElement>('.domain-header')
    const headerFlow = card.querySelector<HTMLElement>('.domain-header-flow')
    const missionCard = card.querySelector<HTMLElement>('.mission-card')
    const missionPages = card.querySelector<HTMLElement>('.mission-pages')
    if (!header || !headerFlow || !missionCard || !missionPages) return null

    const headerStyle = getComputedStyle(header)
    const missionStyle = getComputedStyle(missionCard)
    const headerFlowRect = headerFlow.getBoundingClientRect()
    const missionPagesRect = missionPages.getBoundingClientRect()

    return {
      contentLeftDelta: Math.abs(headerFlowRect.left - missionPagesRect.left),
      paddingLeftDelta: Math.abs(Number.parseFloat(headerStyle.paddingLeft) - Number.parseFloat(missionStyle.paddingLeft)),
      paddingRightDelta: Math.abs(Number.parseFloat(headerStyle.paddingRight) - Number.parseFloat(missionStyle.paddingRight))
    }
  }))

  expect(alignments.length).toBeGreaterThanOrEqual(12)
  expect(alignments.every((alignment) => alignment !== null)).toBe(true)
  for (const alignment of alignments) {
    expect(alignment?.contentLeftDelta).toBeLessThanOrEqual(0.5)
    expect(alignment?.paddingLeftDelta).toBeLessThanOrEqual(0.5)
    expect(alignment?.paddingRightDelta).toBeLessThanOrEqual(0.5)
  }
})

test('ordinary dashboard renders keep masonry observers attached', async ({ page }) => {
  await page.addInitScript(() => {
    const counters = { mutationDisconnects: 0, resizeDisconnects: 0 }
    ;(window as typeof window & { __tabOutObserverDisconnects?: typeof counters }).__tabOutObserverDisconnects = counters

    const NativeResizeObserver = window.ResizeObserver
    window.ResizeObserver = class extends NativeResizeObserver {
      override disconnect() {
        counters.resizeDisconnects += 1
        super.disconnect()
      }
    }
    const NativeMutationObserver = window.MutationObserver
    window.MutationObserver = class extends NativeMutationObserver {
      override disconnect() {
        counters.mutationDisconnects += 1
        super.disconnect()
      }
    }
  })

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await expect(page.locator('.missions:not(.missions-empty)').first()).toHaveClass(/is-packed/)

  const readDisconnects = () => page.evaluate(() => (
    (window as typeof window & {
      __tabOutObserverDisconnects?: { mutationDisconnects: number; resizeDisconnects: number }
    }).__tabOutObserverDisconnects
  ))
  const before = await readDisconnects()
  const chip = page.locator('[data-tabout="page-chip"]').first()
  await chip.hover()
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  await page.locator('[data-tabout="dashboard-shell"]').hover({ position: { x: 1, y: 1 } })
  await expect(chip).not.toHaveAttribute('data-expanded', 'true')
  await page.waitForTimeout(50)

  expect(await readDisconnects()).toEqual(before)
})

test('Page Chip closes its expansion and interaction chrome as soon as the pointer leaves', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const chip = page.locator('[data-tabout="page-chip"]').first()
  const readInteractionPaint = (element: HTMLElement) => {
    const style = getComputedStyle(element)
    const expandedFill = element.querySelector<HTMLElement>('.page-chip-expanded-fill')
    return {
      root: {
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        outline: style.outline
      },
      actionFadeOpacity: getComputedStyle(element, '::after').opacity,
      expandedFillOpacity: expandedFill ? getComputedStyle(expandedFill).opacity : null
    }
  }
  const restingPaint = await chip.evaluate(readInteractionPaint)
  expect(await chip.evaluate((element) => getComputedStyle(element).transitionProperty.split(',').map((property) => property.trim()))).not.toContain('box-shadow')

  await chip.hover()
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  const expandedChipElement = await chip.elementHandle()
  expect(expandedChipElement).not.toBeNull()
  const hoveredPaint = await expandedChipElement!.evaluate(readInteractionPaint)
  expect(hoveredPaint.root).not.toEqual(restingPaint.root)
  expect(hoveredPaint.root.backgroundColor).not.toBe(restingPaint.root.backgroundColor)
  expect(hoveredPaint.root.boxShadow).not.toBe(restingPaint.root.boxShadow)
  expect(hoveredPaint.expandedFillOpacity).toBe('1')

  const expandedBounds = await expandedChipElement!.boundingBox()
  expect(expandedBounds).not.toBeNull()

  await page.mouse.move(
    (expandedBounds?.x ?? 0) + (expandedBounds?.width ?? 0) + 2,
    (expandedBounds?.y ?? 0) + (expandedBounds?.height ?? 0) / 2
  )
  expect(await chip.evaluate((element) => ({
    expanded: element.getAttribute('data-expanded'),
    hovered: element.matches(':hover')
  }))).toEqual({
    expanded: null,
    hovered: false
  })
  expect(await chip.evaluate(readInteractionPaint)).toEqual(restingPaint)
})

test('Page Chip keeps hydrated title details and interaction chrome in one expansion state', async ({ page }) => {
  const targetLabel = 'Tooltip Boundary Alpha'
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const chip = page.locator('[data-tabout="page-chip"]').filter({ hasText: targetLabel }).first()
  await expect(chip).toBeVisible()
  await chip.scrollIntoViewIfNeeded()
  await chip.evaluate((element) => {
    const text = element.querySelector<HTMLElement>('.chip-text')
    if (!text) throw new Error('Hydrated-title Page Chip fixture is unavailable')
    text.style.flex = '0 0 130px'
    text.style.maxWidth = '130px'
    text.style.maxHeight = 'calc(1lh)'
  })

  const readExpansionState = (surface: HTMLElement) => {
    const style = getComputedStyle(surface)
    const indicator = surface.querySelector<HTMLElement>('.chip-strip-indicator')
    const indicatorLabel = indicator?.querySelector<HTMLElement>('.chip-strip-indicator-label')
    const indicatorGlyph = indicator?.querySelector<HTMLElement>('.chip-strip-indicator-glyph')
    const markers = Array.from(surface.querySelectorAll<HTMLElement>('.chip-title-suppression-marker'))
    const expandedFill = surface.querySelector<HTMLElement>('.page-chip-expanded-fill')
    return {
      expanded: surface.getAttribute('data-expanded'),
      hovered: surface.matches(':hover'),
      indicatorText: indicator?.innerText ?? '',
      indicatorLabelDisplay: indicatorLabel ? getComputedStyle(indicatorLabel).display : null,
      indicatorGlyphDisplay: indicatorGlyph ? getComputedStyle(indicatorGlyph).display : null,
      markerTexts: markers.map((marker) => marker.innerText),
      markerLabelDisplays: markers.map((marker) => {
        const label = marker.querySelector<HTMLElement>('.chip-title-suppression-label')
        return label ? getComputedStyle(label).display : null
      }),
      markerGlyphDisplays: markers.map((marker) => {
        const glyph = marker.querySelector<HTMLElement>('.chip-title-suppression-glyph')
        return glyph ? getComputedStyle(glyph).display : null
      }),
      paint: {
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        outline: style.outline,
        expandedFillOpacity: expandedFill ? getComputedStyle(expandedFill).opacity : null
      }
    }
  }
  const restingState = await chip.evaluate(readExpansionState)
  expect(restingState.expanded).toBeNull()
  expect(restingState.indicatorText).not.toBe('')
  expect(restingState.indicatorLabelDisplay).toBe('none')
  expect(restingState.indicatorGlyphDisplay).not.toBe('none')
  expect(restingState.markerTexts.length).toBeGreaterThan(0)
  expect(restingState.markerTexts.every((text) => text === '')).toBe(true)
  expect(restingState.markerLabelDisplays.every((display) => display === 'none')).toBe(true)
  expect(restingState.markerGlyphDisplays.every((display) => display !== 'none')).toBe(true)

  await chip.hover({ position: { x: 36, y: 8 } })
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  await page.waitForTimeout(120)
  const expandedState = await chip.evaluate(readExpansionState)
  expect(expandedState.hovered).toBe(true)
  expect(expandedState.indicatorText).not.toBe(restingState.indicatorText)
  expect(expandedState.markerTexts.some((text) => text !== '')).toBe(true)
  expect(expandedState.paint).not.toEqual(restingState.paint)

  const nonHoverPoint = await chip.evaluate((surface) => {
    const rect = surface.getBoundingClientRect()
    const offsets = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1]
    for (const offset of offsets) {
      for (const [x, y] of [
        [rect.left + offset, rect.top + offset],
        [rect.right - offset, rect.top + offset],
        [rect.left + offset, rect.bottom - offset],
        [rect.right - offset, rect.bottom - offset]
      ]) {
        const hit = document.elementFromPoint(x, y)
        if (!hit || !surface.contains(hit)) return { x, y }
      }
    }
    return null
  })
  expect(nonHoverPoint).not.toBeNull()
  await page.mouse.move(nonHoverPoint?.x ?? 0, nonHoverPoint?.y ?? 0)
  await page.waitForTimeout(120)

  await expect(chip).toHaveAttribute('data-expanded', 'true')
  const retainedState = await chip.evaluate(readExpansionState)
  expect(retainedState.hovered).toBe(false)
  expect(retainedState).toEqual({ ...expandedState, hovered: false })

  await page.mouse.move(2, 2)
  await expect(chip).not.toHaveAttribute('data-expanded', 'true')
  await page.waitForTimeout(120)
  expect(await chip.evaluate(readExpansionState)).toEqual(restingState)

  await chip.evaluate((surface) => {
    surface.focus({ focusVisible: true } as FocusOptions & { focusVisible: boolean })
  })
  await expect.poll(() => chip.evaluate((surface) => surface.matches(':focus-visible'))).toBe(true)
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  const focusedOutline = await chip.evaluate((surface) => {
    const style = getComputedStyle(surface)
    const colorProbe = document.createElement('span')
    colorProbe.style.color = 'var(--accent-amber)'
    document.body.append(colorProbe)
    const accentColor = getComputedStyle(colorProbe).color
    colorProbe.remove()
    return {
      color: style.outlineColor,
      offset: style.outlineOffset,
      width: style.outlineWidth,
      accentColor
    }
  })
  expect({
    color: focusedOutline.color,
    offset: focusedOutline.offset,
    width: focusedOutline.width
  }).toEqual({
    color: focusedOutline.accentColor,
    offset: '2px',
    width: '2px'
  })
})

test('Page Chip preserves tall first-line glyph ink without changing its layout box', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?tallGlyphTitle=1')
  const chip = page.locator('[data-tabout="page-chip"]').filter({ hasText: '⬆️ Tall glyph title' }).first()
  const title = chip.locator('.chip-text')
  await expect(title).toBeVisible()

  const geometry = await title.evaluate((element) => {
    const content = element.querySelector<HTMLElement>('.captured-title-content-root')
    if (!content) throw new Error('Tall-glyph Page Chip fixture is unavailable')

    const baselineProbe = document.createElement('span')
    baselineProbe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline'
    content.prepend(baselineProbe)

    const titleRect = element.getBoundingClientRect()
    const chipRect = element.closest<HTMLElement>('[data-tabout="page-chip"]')?.getBoundingClientRect()
    const baselineRect = baselineProbe.getBoundingClientRect()
    const style = getComputedStyle(element)
    const context = document.createElement('canvas').getContext('2d')
    if (!chipRect || !context) throw new Error('Tall-glyph Page Chip geometry is unavailable')
    context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ')
    const glyphMetrics = context.measureText('⬆️')

    return {
      chipHeight: chipRect.height,
      titleHeight: titleRect.height,
      titleLeft: titleRect.left,
      titleTop: titleRect.top,
      inkTop: baselineRect.top - glyphMetrics.actualBoundingBoxAscent
    }
  })
  expect(geometry.inkTop).toBeLessThan(geometry.titleTop - 0.5)

  const screenshotClip = {
    x: Math.floor(geometry.titleLeft - 2),
    y: Math.floor(geometry.titleTop - 4),
    width: 52,
    height: Math.ceil(geometry.titleHeight + 8)
  }
  const clippedScreenshot = await page.screenshot({ clip: screenshotClip, animations: 'disabled' })
  await title.evaluate((element) => {
    element.style.overflow = 'visible'
  })
  const visibleScreenshot = await page.screenshot({ clip: screenshotClip, animations: 'disabled' })

  const changedPixelsAboveTitle = await page.evaluate(async ({ clippedPng, visiblePng, boundaryY }) => {
    const decode = async (encoded: string) => {
      const response = await fetch(`data:image/png;base64,${encoded}`)
      const bitmap = await createImageBitmap(await response.blob())
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Screenshot canvas is unavailable')
      context.drawImage(bitmap, 0, 0)
      return context.getImageData(0, 0, bitmap.width, bitmap.height)
    }

    const [clipped, visible] = await Promise.all([decode(clippedPng), decode(visiblePng)])
    let changedPixels = 0
    for (let index = 0; index < clipped.data.length; index += 4) {
      const delta =
        Math.abs(clipped.data[index] - visible.data[index]) +
        Math.abs(clipped.data[index + 1] - visible.data[index + 1]) +
        Math.abs(clipped.data[index + 2] - visible.data[index + 2]) +
        Math.abs(clipped.data[index + 3] - visible.data[index + 3])
      if (delta > 8 && Math.floor(index / 4 / clipped.width) < boundaryY) changedPixels += 1
    }
    return changedPixels
  }, {
    clippedPng: clippedScreenshot.toString('base64'),
    visiblePng: visibleScreenshot.toString('base64'),
    boundaryY: Math.round(geometry.titleTop - screenshotClip.y)
  })

  expect(changedPixelsAboveTitle).toBe(0)
  await expect.poll(() => chip.evaluate((element) => element.getBoundingClientRect().height)).toBe(geometry.chipHeight)
  await expect.poll(() => title.evaluate((element) => element.getBoundingClientRect().height)).toBe(geometry.titleHeight)
})

test('measured dashboard titles share one document font listener', async ({ page }) => {
  await page.addInitScript(() => {
    const counts = { loadingdone: 0, loadingerror: 0 }
    ;(window as typeof window & { __tabOutFontListenerCounts?: typeof counts }).__tabOutFontListenerCounts = counts
    const nativeAddEventListener = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
      if (this === document.fonts && (type === 'loadingdone' || type === 'loadingerror')) {
        counts[type] += 1
      }
      return nativeAddEventListener.call(this, type, listener, options)
    }
  })

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="page-chip"]').count()).toBeGreaterThan(20)

  const counts = await page.evaluate(() => (
    (window as typeof window & {
      __tabOutFontListenerCounts?: { loadingdone: number; loadingerror: number }
    }).__tabOutFontListenerCounts
  ))
  expect(counts).toEqual({ loadingdone: 1, loadingerror: 1 })
})

test('Path Group tooltip follows observer-driven label truncation', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const label = page.locator('.pathgroup-header .chip-pathgroup').first()
  const labelText = (await label.textContent())?.trim() || ''
  expect(labelText).not.toBe('')

  await page.addStyleTag({
    content: '.pathgroup-header .chip-pathgroup { width: 20px !important; max-width: 20px !important; flex: 0 0 20px !important; }'
  })
  await expect.poll(() => label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)

  await label.hover()
  await expect(page.locator('[data-slot="tooltip-content"]:visible')).toHaveText(labelText)
})

test('Activation History restores its title fade after hover expansion closes', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const title = page.locator('.history-entry-title').filter({
    hasText: 'Low score history item with enough tooltip text'
  }).first()
  await title.scrollIntoViewIfNeeded()
  await expectCollapsedTitleFade(title, 'history-entry-title-truncated')

  await title.hover()
  await expect(page.locator('.history-entry-expanded')).toHaveCount(1)
  await page.mouse.move(2, 2)
  await expect(page.locator('.history-entry-expanded')).toHaveCount(0)

  await expectCollapsedTitleFade(
    title,
    'history-entry-title-truncated',
    'collapsed Activation History title should restore its clamp and fade'
  )
})

test('Activation History closes its title expansion as soon as the pointer leaves', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const row = page.locator('[data-tabout="activation-history-entry"]').filter({
    hasText: 'Low score history item with enough tooltip text'
  }).first()
  const title = row.locator('.history-entry-title').first()
  await title.scrollIntoViewIfNeeded()
  await title.hover()
  await expect(row.locator('.history-entry-expanded')).toHaveCount(1)

  const collapsedByNextFrame = await row.evaluate(async (element) => {
    const collapsedSurface = element.querySelector<HTMLElement>('.history-entry:not(.history-entry-expanded)')
    const outsideTarget = document.querySelector<HTMLElement>('[data-tabout="dashboard-shell"]')
    if (!collapsedSurface || !outsideTarget) throw new Error('History pointer-leave fixtures are unavailable')
    collapsedSurface.dispatchEvent(new PointerEvent('pointerout', {
      bubbles: true,
      pointerType: 'mouse',
      relatedTarget: outsideTarget
    }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return element.querySelector('.history-entry-expanded') === null
  })
  expect(collapsedByNextFrame).toBe(true)
})

test('Activation History expands a faded two-line title on hover', async ({ page }) => {
  await page.setViewportSize({ width: 920, height: 900 })
  await page.goto('/tests/fixtures/dashboard-resize.html?shortHistoryTitle=1')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const row = page.locator('[data-tabout="activation-history-entry"]').filter({
    hasText: 'Shop Glasses Accessories | Fast Shipping | Zenon Optical'
  }).first()
  const title = row.locator('.history-entry-title')
  await title.scrollIntoViewIfNeeded()
  await expectCollapsedTitleFade(title, 'history-entry-title-truncated')

  await title.hover()
  await expect(row.locator('.history-entry-expanded')).toHaveCount(1)
})

test('Activation History marker stays aligned with the favicon and first title line', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const row = page.locator('[data-tabout="activation-history-entry"]').filter({
    hasText: 'Low score history item with enough tooltip text'
  }).first()
  const title = row.locator('.history-entry-title')
  await expect(row).toBeVisible()

  const geometry = await row.evaluate((element) => {
    const marker = element.querySelector<HTMLElement>('[data-tabout-part="history-entry-marker"]')
    const favicon = element.querySelector<HTMLElement>('.history-entry-favicon-frame')
    const main = element.querySelector<HTMLElement>('.history-entry-main')
    if (!marker || !favicon || !main) return null

    const markerRect = marker.getBoundingClientRect()
    const faviconRect = favicon.getBoundingClientRect()
    const mainRect = main.getBoundingClientRect()
    const contentTop = mainRect.top + Number.parseFloat(getComputedStyle(main).paddingTop)
    return {
      faviconOffset: faviconRect.top - contentTop,
      markerOffset: markerRect.top - contentTop,
      markerTop: markerRect.top
    }
  })

  expect(geometry).not.toBeNull()
  expect(Math.abs(geometry?.faviconOffset ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(geometry?.markerOffset ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(0.5)

  await title.hover()
  await expect(page.locator('.history-entry-expanded')).toHaveCount(1)
  const expandedMarkerTop = await row.locator('[data-tabout-part="history-entry-marker"]').evaluate((element) => (
    element.getBoundingClientRect().top
  ))
  expect(Math.abs(expandedMarkerTop - (geometry?.markerTop ?? Number.POSITIVE_INFINITY))).toBeLessThanOrEqual(0.5)
})

test('Activation History scrollbar follows filtered row content', async ({ page }) => {
  await page.setViewportSize({ width: 1420, height: 360 })
  await page.goto('/tests/fixtures/dashboard-resize.html')

  const rows = page.locator('[data-tabout="activation-history-entry"]')
  const scrollbar = page.locator('[data-tabout-part="history-scrollbar"]')
  await expect.poll(() => rows.count()).toBeGreaterThan(0)
  await expect(scrollbar).toHaveCount(1)

  await page.locator('[data-tabout="filter-query"] input').fill('no-history-row-matches-this')
  await expect(rows).toHaveCount(0)
  await expect(scrollbar).toHaveCount(0)

  await page.locator('[data-tabout="filter-query"] input').fill('')
  await expect.poll(() => rows.count()).toBeGreaterThan(0)
  await expect(scrollbar).toHaveCount(1)
})

test('lazy context-menu arming preserves keyboard focus on chips and history entries', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  for (const trigger of [
    page.locator('[data-tabout="page-chip"][tabindex="0"]').first(),
    page.locator('[data-tabout="activation-history-entry"] [data-tabout-part="focus-button"][tabindex="0"]').first()
  ]) {
    await trigger.focus()
    await page.waitForTimeout(300)
    await expect.poll(() => trigger.evaluate((element) => (
      element === document.activeElement || element.contains(document.activeElement)
    ))).toBe(true)
  }
})

test('keyboard focus reveals section actions and lifts unmatched-card dimming', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await page.evaluate(async () => {
    await (window as typeof window & {
      __tabOutSmokeAddPathGroupPlaceholderTabs?: () => Promise<void>
    }).__tabOutSmokeAddPathGroupPlaceholderTabs?.()
  })

  for (const selector of [
    '.section-pin-btn:not(.is-pinned)',
    '.subdomain-close-btn',
    '.website-path-section-close-btn',
    '.pathgroup-close-btn'
  ]) {
    const control = page.locator(selector).first()
    if (await control.count() === 0) continue
    await control.evaluate((element) => {
      (element as HTMLElement).focus({ focusVisible: true } as FocusOptions & { focusVisible: boolean })
    })
    await expect.poll(() => control.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  }

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Example')
  const unmatchedFocusTarget = page.locator('.card-unmatched [data-tabout="page-chip"][tabindex="0"]').first()
  await expect(unmatchedFocusTarget).toHaveCount(1)
  await unmatchedFocusTarget.evaluate((element) => {
    (element as HTMLElement).focus({ focusVisible: true } as FocusOptions & { focusVisible: boolean })
  })
  await expect.poll(() => unmatchedFocusTarget.evaluate((element) => (
    element.closest('.card-unmatched')
      ? getComputedStyle(element.closest('.card-unmatched') as HTMLElement).opacity
      : null
  ))).toBe('1')
})

test('meaningful secondary text avoids opacity layering and the dashboard exposes a main landmark', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')
  await page.evaluate(async () => {
    await (window as typeof window & {
      __tabOutSmokeAddPathGroupPlaceholderTabs?: () => Promise<void>
    }).__tabOutSmokeAddPathGroupPlaceholderTabs?.()
  })

  await expect(page.getByRole('main', { name: 'Dashboard' })).toHaveCount(1)
  await expect(page.locator('.pathgroup-header-count').first()).toBeVisible()

  const secondaryText = await page.evaluate(() => {
    const selectors = [
      '.domain-title-subdomain',
      '.domain-title-suffix',
      '.tab-count-badge-total',
      '.subdomain-header-count',
      '.website-path-section-header-count',
      '.pathgroup-header-count',
      '.chip-path'
    ]

    return selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector)
      return {
        opacity: element ? getComputedStyle(element).opacity : null,
        selector
      }
    })
  })

  for (const requiredSelector of ['.domain-title-suffix', '.pathgroup-header-count']) {
    expect(secondaryText.find(({ selector }) => selector === requiredSelector)?.opacity).not.toBeNull()
  }
  expect(secondaryText.filter(({ opacity }) => opacity !== null && opacity !== '1')).toEqual([])

  await page.locator('[data-tabout="filter-query"] input').fill('Gamma')
  const filteredTotal = page.locator('.tab-count-badge-total').first()
  await expect(filteredTotal).toBeVisible()
  await expect.poll(() => filteredTotal.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
})

test('a favicon recovers after the same image node receives a valid source', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const chip = page.locator('[data-tabout="page-chip"]').filter({
    hasText: 'Short title'
  }).first()
  const setFavicon = async (faviconUrl: string) => {
    await page.evaluate(async (url) => {
      await (window as typeof window & {
        __tabOutSmokeSetTabFavicon?: (tabId: number, faviconUrl: string) => Promise<void>
      }).__tabOutSmokeSetTabFavicon?.(1, url)
    }, faviconUrl)
  }

  await setFavicon('/missing-favicon-for-recovery-test.svg')
  const favicon = chip.locator('img.chip-favicon')
  await expect.poll(async () => {
    if (await favicon.count() === 0) return true
    return favicon.evaluate((image) => (
      (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth === 0
    ))
  }).toBe(true)

  await setFavicon('data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="16"%3E%3Crect width="16" height="16" fill="%2300a86b"/%3E%3C/svg%3E')
  await expect.poll(() => favicon.evaluate((image) => ({
    display: getComputedStyle(image).display,
    naturalWidth: (image as HTMLImageElement).naturalWidth
  }))).toEqual({ display: 'block', naturalWidth: 16 })
})

test('filter keyboard navigation selects the first true match and moves without leaving the input', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Example')

  const matchedCandidates = page.locator('#openTabsMissions [data-tabout-filter-result]')
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/)
  await expect.poll(() => matchedCandidates.count()).toBeGreaterThan(1)
  const firstId = await matchedCandidates.nth(0).getAttribute('id')
  const secondId = await matchedCandidates.nth(1).getAttribute('id')

  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('aria-activedescendant', firstId ?? '')
  await expect(page.locator('[data-tabout-filter-result-selected="true"]')).toHaveCount(1)
  const selectedResult = page.locator('[data-tabout-filter-result-selected="true"]')
  await expect(selectedResult).toHaveCSS('outline-width', '1px')
  const selectedPalette = await selectedResult.evaluate((element) => {
    const paletteProbe = document.createElement('span')
    paletteProbe.style.backgroundColor = 'var(--chip-interaction-bg)'
    paletteProbe.style.outlineColor = 'var(--accent-amber)'
    element.append(paletteProbe)

    const selectedStyle = getComputedStyle(element)
    const paletteStyle = getComputedStyle(paletteProbe)
    const palette = {
      selectedBackground: selectedStyle.backgroundColor,
      selectedOutline: selectedStyle.outlineColor,
      hoverBackground: paletteStyle.backgroundColor,
      originalOutline: paletteStyle.outlineColor
    }
    paletteProbe.remove()
    return palette
  })
  expect(selectedPalette.selectedBackground).toBe(selectedPalette.hoverBackground)
  expect(selectedPalette.selectedOutline).toBe(selectedPalette.originalOutline)
  await expect(page.locator('#openTabsMissionsUnmatched [data-tabout-filter-result-selected="true"]')).toHaveCount(0)

  await input.press('ArrowDown')
  await expect(input).toBeFocused()
  await expect(input).toHaveAttribute('aria-activedescendant', secondId ?? '')

  await input.press('ArrowUp')
  await expect(input).toHaveAttribute('aria-activedescendant', firstId ?? '')
  await input.press('ArrowUp')
  await expect(input).toHaveAttribute('aria-activedescendant', firstId ?? '')

  await expect(page.locator('.layout-moving')).toHaveCount(0)
  const selectedCandidate = selectedResult
  const firstBounds = await selectedCandidate.boundingBox()
  if (!firstBounds) throw new Error('expected the first selected result to have rendered bounds')

  await input.press('ArrowRight')
  await expect(input).toBeFocused()
  await expect(input).not.toHaveAttribute('aria-activedescendant', firstId ?? '')
  const rightId = await input.getAttribute('aria-activedescendant')
  const rightBounds = await selectedCandidate.boundingBox()
  if (!rightBounds) throw new Error('expected the right-selected result to have rendered bounds')
  expect(rightBounds.x).toBeGreaterThanOrEqual(firstBounds.x + firstBounds.width - 1)

  await input.press('ArrowLeft')
  await expect(input).not.toHaveAttribute('aria-activedescendant', rightId ?? '')
  const leftBounds = await selectedCandidate.boundingBox()
  if (!leftBounds) throw new Error('expected the left-selected result to have rendered bounds')
  expect(leftBounds.x + leftBounds.width).toBeLessThanOrEqual(rightBounds.x + 1)
})

test('filter result ownership exposes a labelled accessibility group', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Example')

  await expect(input).toHaveAttribute('aria-controls', 'dashboardMissions')
  await expect(page.locator('#dashboardMissions')).toHaveAttribute('role', 'group')
  await expect(page.locator('#dashboardMissions')).toHaveAccessibleName('Filter results')
})

test('filter Enter activates the current query and primary-modifier Shift Enter brings the tab here', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('https://tab-out-smoke-02.com/docs/2')
  await input.press('Enter')
  await expect.poll(() => page.evaluate(async () => (await window.chrome.tabs.get(2)).active)).toBe(true)
  await expect(input).toBeFocused()

  await page.evaluate(async () => {
    await (window as typeof window & {
      __tabOutSmokeSetActiveTab: (tabId: number, windowId?: number) => Promise<void>
    }).__tabOutSmokeSetActiveTab(3, 2)
  })
  await input.fill('https://tab-out-smoke-03.com/docs/3')
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/)
  const primaryModifier = await page.evaluate(() => (
    /mac|iphone|ipad|ipod/i.test(navigator.platform) ? 'Meta' : 'Control'
  ))
  await input.press(`${primaryModifier}+Shift+Enter`)

  await expect.poll(() => page.evaluate(async () => {
    const tab = await window.chrome.tabs.get(3)
    return { active: tab.active, windowId: tab.windowId }
  })).toEqual({ active: true, windowId: 1 })
})

test('filter Enter waits for the first matching companion result to mount', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await installBookmarkFetchGate(page)

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Bookmark')
  await input.press('Enter')
  await waitForBookmarkFetch(page)
  await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/)

  await releaseBookmarkFetchGate(page)
  await expect.poll(() => page.evaluate(async () => {
    const target = (await window.chrome.tabs.query({})).find(
      (tab) => tab.url === 'https://bookmark-smoke-0001.test/docs/1'
    )
    return target ? { active: target.active, url: target.url } : null
  })).toEqual({ active: true, url: 'https://bookmark-smoke-0001.test/docs/1' })
  await expect(input).toBeFocused()
})

test('filter Arrow Down waits for companion hydration before moving from the first result', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await installBookmarkFetchGate(page, null, 3)

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Bookmark')
  await input.press('ArrowDown')
  await waitForBookmarkFetch(page)
  await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/)

  await releaseBookmarkFetchGate(page)
  const candidates = page.locator('#bookmarkMatchesMissions [data-tabout-filter-result]')
  await expect(candidates).toHaveCount(3)
  const secondId = await candidates.nth(1).getAttribute('id')
  await expect(input).toHaveAttribute('aria-activedescendant', secondId ?? '')
  await expect(candidates.nth(1)).toHaveAttribute('data-tabout-filter-result-selected', 'true')
})

test('filter navigation only selects progressive bookmark results after they mount', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      value: undefined
    })
    const idleCallbacks = new Map<number, IdleRequestCallback>()
    let nextIdleId = 1
    window.requestIdleCallback = (callback) => {
      const idleId = nextIdleId
      nextIdleId += 1
      idleCallbacks.set(idleId, callback)
      return idleId
    }
    window.cancelIdleCallback = (idleId) => {
      idleCallbacks.delete(idleId)
    }
    ;(window as typeof window & { __tabOutRunNextIdle?: () => boolean }).__tabOutRunNextIdle = () => {
      const next = idleCallbacks.entries().next().value
      if (!next) return false
      const [idleId, callback] = next
      idleCallbacks.delete(idleId)
      callback({ didTimeout: false, timeRemaining: () => 50 })
      return true
    }
  })

  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await page.evaluate(() => {
    ;(window as typeof window & { __tabOutSmokeSetBookmarks: (count: number) => void })
      .__tabOutSmokeSetBookmarks(100)
  })
  await page.getByRole('tab', { name: 'Bookmarks' }).click()

  const cards = page.locator('#openTabsMissions [data-tabout="domain-card"]')
  await expect(cards).toHaveCount(24)
  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Bookmark')
  const candidates = page.locator('#openTabsMissions [data-tabout-filter-result]')
  await expect(candidates).toHaveCount(24)
  const lastInitiallyMountedId = await candidates.nth(23).getAttribute('id')

  for (let step = 0; step < 24; step += 1) {
    await input.press('ArrowDown')
  }
  await expect(input).toHaveAttribute('aria-activedescendant', lastInitiallyMountedId ?? '')
  await expect(candidates.nth(23)).toHaveAttribute('data-tabout-filter-result-selected', 'true')
  await expect.poll(() => input.evaluate((element) => {
    const activeDescendant = element.getAttribute('aria-activedescendant')
    return !!activeDescendant && !!document.getElementById(activeDescendant)
  })).toBe(true)

  expect(await page.evaluate(() => (
    (window as typeof window & { __tabOutRunNextIdle?: () => boolean }).__tabOutRunNextIdle?.()
  ))).toBe(true)
  await expect(candidates).toHaveCount(48)
  const firstNewlyMountedId = await candidates.nth(24).getAttribute('id')
  await input.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-activedescendant', firstNewlyMountedId ?? '')
  await expect(candidates.nth(24)).toHaveAttribute('data-tabout-filter-result-selected', 'true')
})

test('large bookmark rendering stays bounded at the top and hydrates on scroll demand', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await page.evaluate(() => {
    ;(window as typeof window & { __tabOutSmokeSetBookmarks: (count: number) => void })
      .__tabOutSmokeSetBookmarks(200)
  })
  await page.getByRole('tab', { name: 'Bookmarks' }).click()

  const cards = page.locator('#openTabsMissions [data-tabout="domain-card"]')
  await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(24)
  await page.waitForTimeout(1_200)
  expect(await cards.count()).toBeLessThanOrEqual(96)
  expect(await page.locator('#openTabsMissions *').count()).toBeLessThanOrEqual(3_500)

  const scrollRegion = page.locator('[data-tabout-part="scroll-region"]')
  for (let pass = 0; pass < 20 && await cards.count() < 200; pass += 1) {
    await scrollRegion.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.waitForTimeout(100)
  }
  await expect(cards).toHaveCount(200)
})

test('filter keyboard selection keeps its identity when a higher-priority companion result arrives', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await page.evaluate(() => {
    ;(window as typeof window & {
      __tabOutSmokeSetBookmarks: (count: number) => void
    }).__tabOutSmokeSetBookmarks(1)
    window.chrome.history.search = async () => []
  })

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Bookmark')
  const bookmarkCandidate = page.locator('#bookmarkMatchesMissions [data-tabout-filter-result]').first()
  await expect(bookmarkCandidate).toHaveCount(1)
  const bookmarkId = await bookmarkCandidate.getAttribute('id')
  await expect(input).toHaveAttribute('aria-activedescendant', bookmarkId ?? '')
  const expectClosedSelectionPalette = async (candidate: Locator) => {
    await expect(candidate).toHaveAttribute('data-tabout-filter-result-selected', 'true')
    await expect.poll(() => candidate.evaluate((element) => {
      const closedProbe = document.createElement('span')
      const openProbe = document.createElement('span')
      const outlineProbe = document.createElement('span')
      closedProbe.style.backgroundColor = 'color-mix(in srgb, var(--card-bg) 96.5%, var(--color-neutral-600) 3.5%)'
      openProbe.style.backgroundColor = 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)'
      outlineProbe.style.outlineColor = 'var(--accent-amber)'
      element.append(closedProbe, openProbe, outlineProbe)

      const selectedStyle = getComputedStyle(element)
      const selectedBackground = selectedStyle.backgroundColor
      const palette = {
        backgroundMatchesClosed: selectedBackground === getComputedStyle(closedProbe).backgroundColor,
        backgroundMatchesOpen: selectedBackground === getComputedStyle(openProbe).backgroundColor,
        outlineMatchesOriginal: selectedStyle.outlineColor === getComputedStyle(outlineProbe).outlineColor,
        outlineWidth: selectedStyle.outlineWidth
      }
      closedProbe.remove()
      openProbe.remove()
      outlineProbe.remove()
      return palette
    })).toEqual({
      backgroundMatchesClosed: true,
      backgroundMatchesOpen: false,
      outlineMatchesOriginal: true,
      outlineWidth: '1px'
    })
  }
  await expectClosedSelectionPalette(bookmarkCandidate)

  await page.evaluate(() => {
    window.chrome.history.search = async () => [{
      id: 'history-keyboard-result',
      title: 'Bookmark history candidate',
      url: 'https://history-keyboard-result.test/docs'
    }]
  })
  await page.getByRole('combobox', { name: 'History search range' }).click()
  await page.getByRole('option', { name: 'Last week' }).click()
  await expect(page.locator('#historyMatchesMissions [data-tabout-filter-result]')).toHaveCount(1)
  await expect(input).toHaveAttribute('aria-activedescendant', bookmarkId ?? '')
  await expect(bookmarkCandidate).toHaveAttribute('data-tabout-filter-result-selected', 'true')
  await expectClosedSelectionPalette(bookmarkCandidate)

  const historyCandidate = page.locator('#historyMatchesMissions [data-tabout-filter-result]').first()
  const historyId = await historyCandidate.getAttribute('id')
  await input.press('ArrowUp')
  await expect(input).toHaveAttribute('aria-activedescendant', historyId ?? '')
  await expectClosedSelectionPalette(historyCandidate)
})

test('a slow Tabs startup refresh cannot overwrite a completed Bookmarks switch', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?slowStartupRefresh=1')
  await page.evaluate(() => {
    const fixtureWindow = window as typeof window & {
      __tabOutSmokeSetBookmarks?: (count: number) => void
    }
    fixtureWindow.__tabOutSmokeSetBookmarks?.(1)
  })
  await page.waitForFunction(() => (
    (window as typeof window & { __tabOutSmokeStartupRefreshStarted?: boolean })
      .__tabOutSmokeStartupRefreshStarted === true
  ))

  await page.getByRole('tab', { name: 'Bookmarks' }).click()
  await expect(page.getByRole('tab', { name: 'Bookmarks' })).toHaveAttribute('data-active', '')
  const bookmarkCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]')
  await expect(bookmarkCard).toHaveCount(1)

  await page.waitForTimeout(600)
  await expect(bookmarkCard).toHaveCount(1)
  await expect(page.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-03.com"]')).toHaveCount(0)
})

test('a replaced Chrome tab refreshes an already-open dashboard', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const previousCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-02.com"]')
  await expect(previousCard).toHaveCount(1)

  await page.evaluate(async () => {
    const replacedTab = await window.chrome.tabs.get(2)
    Object.assign(replacedTab, {
      id: 2002,
      title: 'Prerender replacement',
      url: 'https://prerender-replacement.test/ready'
    })
    ;(window.chrome.tabs.onReplaced as unknown as {
      dispatch: (addedTabId: number, removedTabId: number) => void
    }).dispatch(2002, 2)
  })

  await expect(page.locator(
    '[data-tabout="domain-card"][data-tabout-domain="prerender-replacement.test"]'
  )).toHaveCount(1)
  await expect(previousCard).toHaveCount(0)
})

test('returning to Tabs cancels a pending Bookmarks source switch', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await installBookmarkFetchGate(page)

  const tabsSource = page.getByRole('tab', { name: 'Tabs' })
  const bookmarksSource = page.getByRole('tab', { name: 'Bookmarks' })
  await bookmarksSource.click()
  await waitForBookmarkFetch(page)
  await expect(bookmarksSource).toHaveAttribute('data-active', '')

  await tabsSource.click()
  await expect(tabsSource).toHaveAttribute('data-active', '')
  await releaseBookmarkFetchGate(page)
  await page.waitForFunction(() => (
    (window as typeof window & { __tabOutBookmarkFetchGate?: BookmarkFetchGate })
      .__tabOutBookmarkFetchGate?.completedCount === 1
  ))
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  await expect(tabsSource).toHaveAttribute('data-active', '')
  await expect(bookmarksSource).not.toHaveAttribute('data-active', '')
  await expect(page.locator('[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]')).toHaveCount(0)
  await expect(page.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-03.com"]')).toHaveCount(1)
})

test('filter Enter cannot activate stale Tabs results during a Bookmarks switch', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('https://tab-out-smoke-02.com/docs/2')
  await expect(input).toHaveAttribute('aria-activedescendant', /.+/)
  await installBookmarkFetchGate(page)

  await page.getByRole('tab', { name: 'Bookmarks' }).click()
  await waitForBookmarkFetch(page)
  await expect(input).not.toHaveAttribute('aria-activedescendant', /.+/)
  await input.focus()
  await input.press('Enter')

  await expect.poll(() => page.evaluate(async () => (await window.chrome.tabs.get(2)).active)).toBe(false)
  await releaseBookmarkFetchGate(page)
  await expect(input).toHaveAttribute('aria-label', 'Filter bookmarks…')
  await expect.poll(() => page.evaluate(async () => (await window.chrome.tabs.get(2)).active)).toBe(false)
})

test('a pending filter Enter is cancelled when the selected source changes', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await installBookmarkFetchGate(page)

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Bookmark')
  await input.press('Enter')
  await waitForBookmarkFetch(page)
  await page.getByRole('tab', { name: 'Bookmarks' }).click()
  await releaseBookmarkFetchGate(page)

  await expect(page.locator('[data-tabout="domain-card"][data-tabout-domain="bookmark-smoke-0001.test"]')).toHaveCount(1)
  await expect.poll(() => page.evaluate(async () => (
    (await window.chrome.tabs.query({})).filter(
      (tab) => tab.url === 'https://bookmark-smoke-0001.test/docs/1'
    ).length
  ))).toBe(0)
})

test('a pending source switch rebuilds with the latest domain pins', async ({ page }) => {
  await page.route('**/extension/dist/assets/CardActionsMenuLoaded-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250))
    await route.continue()
  })
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await installBookmarkFetchGate(page, [{
    id: 'root',
    title: '',
    children: [{
      id: 'bar',
      title: 'Bookmarks Bar',
      children: [{
        id: 'same-domain-bookmark',
        title: 'Same domain bookmark',
        url: 'https://tab-out-smoke-02.com/bookmark'
      }]
    }]
  }])

  const bookmarksSource = page.getByRole('tab', { name: 'Bookmarks' })
  await bookmarksSource.click()
  await waitForBookmarkFetch(page)
  await expect(bookmarksSource).toHaveAttribute('data-active', '')

  const tabsCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-02.com"]')
  const cardMenu = tabsCard.locator('[data-tabout-part="card-menu"]')
  await tabsCard.hover()
  await cardMenu.click()
  await expect(page.getByRole('menuitem', { name: 'Pin card' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Pin card' }).click()
  await expect(tabsCard).toHaveAttribute('data-tabout-domain-pinned', 'true')
  await expect(tabsCard.locator('[data-tabout-part="pin-indicator"]')).toHaveCount(1)

  await releaseBookmarkFetchGate(page)
  const bookmarkCard = page.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-02.com"]')
  await expect(bookmarkCard).toHaveCount(1)
  await expect(bookmarkCard).toContainText('Same domain bookmark')
  await expect(bookmarkCard).toHaveAttribute('data-tabout-domain-pinned', 'true')
  await expect(bookmarkCard.locator('[data-tabout-part="pin-indicator"]')).toHaveCount(1)
})

test('a slow unfiltered startup snapshot still hydrates after the filter changes', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?slowStartupRefresh=1')
  await page.waitForFunction(() => (
    (window as typeof window & { __tabOutSmokeStartupRefreshStarted?: boolean })
      .__tabOutSmokeStartupRefreshStarted === true
  ))

  await page.locator('[data-tabout="filter-query"] input').fill('Example 2')

  const matchedGrid = page.locator('#openTabsMissions')
  const otherTabsGrid = page.locator('#openTabsMissionsUnmatched')
  await expect(matchedGrid.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-02.com"]')).toHaveCount(1)
  await expect(matchedGrid.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-03.com"]')).toHaveCount(0)
  await expect(otherTabsGrid.locator('[data-tabout="domain-card"][data-tabout-domain="tab-out-smoke-03.com"]')).toHaveCount(1)
})

test('Page Chip restores its title fade after hover expansion closes', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  const chip = page.locator('[data-tabout="page-chip"]').filter({
    hasText: 'Example 2 with enough tooltip text'
  }).first()
  const title = chip.locator('.chip-text')
  await chip.scrollIntoViewIfNeeded()
  await expectCollapsedTitleFade(title, 'chip-text-truncated')

  await chip.hover()
  await expect(chip).toHaveAttribute('data-expanded', 'true')
  await page.mouse.move(2, 2)
  await expect(chip).not.toHaveAttribute('data-expanded', 'true')

  await expectCollapsedTitleFade(
    title,
    'chip-text-truncated',
    'collapsed Page Chip title should restore its clamp and fade'
  )
})

test('filter result cards finish one move while companion results hydrate', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await expect(page.locator('.layout-moving')).toHaveCount(0)
  await page.evaluate(() => {
    return (window as unknown as {
      __tabOutSmokeSetBookmarks: (count: number) => void
    }).__tabOutSmokeSetBookmarks(12)
  })

  await page.evaluate(() => {
    const targetDomain = 'tab-out-smoke-20.com'
    const moveEvents: Array<{ active: boolean; moving: boolean; time: number }> = []
    const states = new WeakMap<HTMLElement, { active: boolean; moving: boolean }>()
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target
        if (!(target instanceof HTMLElement) || target.dataset.taboutDomain !== targetDomain) continue
        const active = target.classList.contains('layout-moving-active')
        const moving = target.classList.contains('layout-moving')
        const previous = states.get(target)
        if (!previous || previous.active !== active || previous.moving !== moving) {
          moveEvents.push({ active, moving, time: performance.now() })
        }
        states.set(target, { active, moving })
      }
    })
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      subtree: true
    })
    ;(window as unknown as {
      __filterMoveProbe: {
        events: typeof moveEvents
        observer: MutationObserver
      }
    }).__filterMoveProbe = { events: moveEvents, observer }
  })

  await page.locator('[data-tabout="filter-query"] input').fill('Bookmark')
  await expect(page.locator('#bookmarkMatchesMissions [data-tabout="domain-card"]')).toHaveCount(12)
  await expect.poll(() => page.evaluate(() => {
    const events = (window as unknown as {
      __filterMoveProbe: {
        events: Array<{ active: boolean; moving: boolean; time: number }>
      }
    }).__filterMoveProbe.events
    const firstStart = events.find((event) => event.active)
    return !!firstStart && events.some((event) => event.time > firstStart.time && !event.moving)
  })).toBe(true)

  const move = await page.evaluate(() => {
    const probe = (window as unknown as {
      __filterMoveProbe: {
        events: Array<{ active: boolean; moving: boolean; time: number }>
        observer: MutationObserver
      }
    }).__filterMoveProbe
    probe.observer.disconnect()
    const starts = probe.events.filter((event) => event.active)
    const firstStart = starts[0]
    const firstEnd = firstStart
      ? probe.events.find((event) => event.time > firstStart.time && !event.moving)
      : undefined
    return {
      activeDuration: firstStart && firstEnd ? firstEnd.time - firstStart.time : 0,
      starts: starts.length
    }
  })

  expect(move.starts).toBe(1)
  expect(move.activeDuration).toBeGreaterThanOrEqual(240)
})

test('history results do not show a previous query while the next query loads', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await page.evaluate(() => {
    const state = window as unknown as {
      __nextHistorySearchStarted: boolean
    }
    state.__nextHistorySearchStarted = false
    window.chrome.history.search = async ({ text }) => {
      if (text === 'Example 20') {
        state.__nextHistorySearchStarted = true
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        return [{
          id: 'history-example-20',
          title: 'Example 20 History',
          url: 'https://history-example-20.test/docs/20'
        }]
      }
      if (text === 'Example') {
        return [
          {
            id: 'history-example-1',
            title: 'Example History One',
            url: 'https://history-example-1.test/docs/1'
          },
          {
            id: 'history-example-2',
            title: 'Example History Two',
            url: 'https://history-example-2.test/docs/2'
          }
        ]
      }
      return []
    }
  })

  const input = page.locator('[data-tabout="filter-query"] input')
  const historyCards = page.locator('#historyMatchesMissions [data-tabout="domain-card"]')
  const historyStatus = page.locator('[data-tabout="history-search-status"]')
  await input.fill('Example')
  await expect(historyCards).toHaveCount(2)
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'ready')
  await expect.poll(() => historyStatus.locator('[data-tabout-part="summary-title"], [data-tabout-part="summary-detail"]').evaluateAll((elements) => (
    elements.map((element) => getComputedStyle(element).fontSize)
  ))).toEqual(['13px', '13px'])
  await expect.poll(() => historyStatus.locator('[data-tabout-part="summary-title"], [data-tabout-part="summary-detail"]').evaluateAll((elements) => (
    elements.map((element) => getComputedStyle(element).textAlign)
  ))).toEqual(['right', 'right'])

  const readyStatusHeight = await historyStatus.evaluate((element) => element.getBoundingClientRect().height)
  const layout = await page.locator('#historyMatchesSection').evaluate((element) => {
    const status = element.querySelector<HTMLElement>('[data-tabout="history-search-status"]')
    const grid = element.querySelector<HTMLElement>('#historyMatchesMissions')
    const card = grid?.querySelector<HTMLElement>('[data-tabout="domain-card"]')
    const rule = element.querySelector<HTMLElement>('.missions-divider-rule')
    const title = status?.querySelector<HTMLElement>('[data-tabout-part="summary-title"]')
    const detail = status?.querySelector<HTMLElement>('[data-tabout-part="summary-detail"]')
    const ruleBounds = rule?.getBoundingClientRect()
    return {
      cardLeft: card?.getBoundingClientRect().left ?? 0,
      cardWidth: card?.getBoundingClientRect().width ?? 0,
      detailTop: detail?.getBoundingClientRect().top ?? 0,
      gridLeft: grid?.getBoundingClientRect().left ?? 0,
      ruleBottom: ruleBounds?.bottom ?? 0,
      ruleTop: ruleBounds?.top ?? 0,
      statusBorderWidth: status ? getComputedStyle(status).borderWidth : '',
      statusInGrid: !!grid?.contains(status ?? null),
      statusWidth: status?.getBoundingClientRect().width ?? 0,
      titleBottom: title?.getBoundingClientRect().bottom ?? 0
    }
  })
  expect(layout.statusInGrid).toBe(false)
  expect(Math.abs(layout.cardLeft - layout.gridLeft)).toBeLessThanOrEqual(1)
  expect(layout.statusWidth).toBeLessThan(layout.cardWidth)
  expect(layout.statusBorderWidth).toBe('0px')
  expect(layout.titleBottom).toBeLessThan(layout.ruleTop)
  expect(layout.detailTop).toBeGreaterThan(layout.ruleBottom)

  await input.fill('Example 20')
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __nextHistorySearchStarted: boolean }).__nextHistorySearchStarted
  ))).toBe(true)
  await expect(historyCards).toHaveCount(0, { timeout: 300 })
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'searching')
  await expect.poll(() => historyStatus.evaluate((element) => element.getBoundingClientRect().height)).toBe(readyStatusHeight)
  await expect(historyCards).toHaveCount(1)
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'ready')
  await expect(historyCards).toContainText('Example 20 History')
})

test('history results stay visible while a new range loads for the same query', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await page.evaluate(() => {
    const state = window as unknown as {
      __historyRangeSearchStarted: boolean
    }
    state.__historyRangeSearchStarted = false
    window.chrome.history.search = async (query) => {
      const searchAge = Date.now() - Number(query.startTime ?? Date.now())
      if (searchAge > 2 * 24 * 60 * 60 * 1000) {
        state.__historyRangeSearchStarted = true
        await new Promise((resolve) => setTimeout(resolve, 1_200))
        return [
          {
            id: 'history-scope-week-one',
            title: 'Scope result week one',
            url: 'https://history-scope-week-one.test/docs'
          },
          {
            id: 'history-scope-week-two',
            title: 'Scope result week two',
            url: 'https://history-scope-week-two.test/docs'
          }
        ]
      }
      return [{
        id: 'history-scope-day',
        title: 'Scope result day',
        url: 'https://history-scope-day.test/docs'
      }]
    }
  })

  await page.locator('[data-tabout="filter-query"] input').fill('Scope result')
  const historyCards = page.locator('#historyMatchesMissions [data-tabout="domain-card"]')
  const historyStatus = page.locator('[data-tabout="history-search-status"]')
  await expect(historyCards).toHaveCount(1)
  await expect(historyCards).toContainText('Scope result day')
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'ready')
  const readyStatusHeight = await historyStatus.evaluate((element) => element.getBoundingClientRect().height)

  await page.getByRole('combobox', { name: 'History search range' }).click()
  await page.getByRole('option', { name: 'Last week' }).click()
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __historyRangeSearchStarted: boolean }).__historyRangeSearchStarted
  ))).toBe(true)
  await expect(historyCards).toHaveCount(1, { timeout: 300 })
  await expect(historyCards).toContainText('Scope result day')
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'updating')
  await expect(historyStatus).toContainText('Updating…')
  await expect.poll(() => historyStatus.evaluate((element) => element.getBoundingClientRect().height)).toBe(readyStatusHeight)
  await expect(historyCards).toHaveCount(2)
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'ready')
  await expect(historyCards.filter({ hasText: 'Scope result week one' })).toHaveCount(1)
  await expect(historyCards.filter({ hasText: 'Scope result week two' })).toHaveCount(1)
})

test('failed history searches show a retryable status without becoming no matches', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await page.evaluate(() => {
    const state = window as unknown as { __historyRetryEnabled: boolean }
    state.__historyRetryEnabled = false
    window.chrome.history.search = async () => {
      if (!state.__historyRetryEnabled) throw new Error('History unavailable')
      await new Promise((resolve) => setTimeout(resolve, 800))
      return [{
        id: 'history-retry-result',
        title: 'Retryable History result',
        url: 'https://history-retry-result.test/docs'
      }]
    }
  })

  await page.locator('[data-tabout="filter-query"] input').fill('Retryable History result')
  const historyStatus = page.locator('[data-tabout="history-search-status"]')
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'error')
  await expect(historyStatus).toContainText('History update failed')
  await expect(historyStatus).not.toContainText('No History matches')
  await expect.poll(() => historyStatus.locator('[data-tabout-part="retry-button"]').evaluate((element) => (
    getComputedStyle(element).fontSize
  ))).toBe('13px')

  await page.evaluate(() => {
    (window as unknown as { __historyRetryEnabled: boolean }).__historyRetryEnabled = true
  })
  await historyStatus.locator('[data-tabout-part="retry-button"]').click()
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'searching')
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'ready')
  const historyCard = page.locator('#historyMatchesMissions [data-tabout="domain-card"]')
  await expect(historyCard).toContainText('Retryable History result')

  await page.evaluate(() => {
    (window as unknown as { __historyRetryEnabled: boolean }).__historyRetryEnabled = false
  })
  await page.getByRole('combobox', { name: 'History search range' }).click()
  await page.getByRole('option', { name: 'Last week' }).click()
  await expect(historyStatus).toHaveAttribute('data-tabout-history-phase', 'error')
  await expect(historyStatus).toContainText('Previous results remain below')
  await expect(historyCard).toContainText('Retryable History result')
})

test('history range starts from the remembered preference', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?filter=Example&rememberedHistoryRange=90d')

  await expect.poll(async () => page.evaluate(async () => {
    const stored = await window.chrome.storage.local.get('tabOutHistoryRangeV1')
    return stored.tabOutHistoryRangeV1
  })).toBe('90d')
  await expect(
    page.getByRole('combobox', { name: 'History search range' })
  ).toContainText('Last 3 months')
})

test('history range remembers a new selection', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?filter=Example')

  await page.getByRole('combobox', { name: 'History search range' }).click()
  await page.getByRole('option', { name: 'Last 6 months' }).click()

  await expect.poll(async () => page.evaluate(async () => {
    const stored = await window.chrome.storage.local.get('tabOutHistoryRangeV1')
    return stored.tabOutHistoryRangeV1
  })).toBe('180d')
})

test('history results stay cleared when re-enabled with a new range', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await page.evaluate(() => {
    const state = window as unknown as {
      __historyDaySearchCount: number
      __historyDaySearchStarted: boolean
    }
    state.__historyDaySearchCount = 0
    state.__historyDaySearchStarted = false
    window.chrome.history.search = async (query) => {
      const searchAge = Date.now() - Number(query.startTime ?? Date.now())
      if (searchAge > 2 * 24 * 60 * 60 * 1000) {
        return [{
          id: 'history-scope-week',
          title: 'Scope result week',
          url: 'https://history-scope-week.test/docs'
        }]
      }

      state.__historyDaySearchCount += 1
      if (state.__historyDaySearchCount > 1) {
        state.__historyDaySearchStarted = true
        await new Promise((resolve) => setTimeout(resolve, 1_200))
      }
      return [{
        id: 'history-scope-day',
        title: 'Scope result day',
        url: 'https://history-scope-day.test/docs'
      }]
    }
  })

  await page.locator('[data-tabout="filter-query"] input').fill('Scope result')
  const historyCards = page.locator('#historyMatchesMissions [data-tabout="domain-card"]')
  const range = page.getByRole('combobox', { name: 'History search range' })
  await expect(historyCards).toHaveCount(1)
  await expect(historyCards).toContainText('Scope result day')

  await range.click()
  await page.getByRole('option', { name: 'Last week' }).click()
  await expect(historyCards).toHaveCount(1)
  await expect(historyCards).toContainText('Scope result week')

  await range.click()
  await page.getByRole('option', { name: 'History off' }).click()
  await expect(historyCards).toHaveCount(0)

  await range.click()
  await page.getByRole('option', { name: 'Last day' }).click()
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __historyDaySearchStarted: boolean }).__historyDaySearchStarted
  ))).toBe(true)
  await expect(historyCards).toHaveCount(0, { timeout: 300 })
  await expect(historyCards).toHaveCount(1)
  await expect(historyCards).toContainText('Scope result day')
})

test('history layout collapses while off and restores its prior card width', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await page.evaluate(() => {
    return (window as unknown as {
      __tabOutSmokeSetBookmarks: (count: number) => void
    }).__tabOutSmokeSetBookmarks(1)
  })
  await page.evaluate(() => {
    window.chrome.history.search = async () => [{
      id: 'history-layout-result',
      title: 'Bookmark history result',
      url: 'https://history-layout-result.test/docs'
    }]
  })

  await page.locator('[data-tabout="filter-query"] input').fill('Bookmark')
  const historyMissions = page.locator('#historyMatchesMissions')
  const historyCards = historyMissions.locator('[data-tabout="domain-card"]')
  await expect(historyCards).toHaveCount(1)
  await expect(page.locator('#bookmarkMatchesMissions [data-tabout="domain-card"]')).toHaveCount(1)
  await expect(page.locator('.layout-moving')).toHaveCount(0)

  const initialGeometry = await historyMissions.evaluate((element) => {
    const card = element.querySelector<HTMLElement>('[data-tabout="domain-card"]')
    return {
      cardWidth: card?.getBoundingClientRect().width ?? 0,
      containerWidth: element.getBoundingClientRect().width
    }
  })

  const range = page.getByRole('combobox', { name: 'History search range' })
  await range.click()
  await page.getByRole('option', { name: 'History off' }).click()
  await expect(historyCards).toHaveCount(0)
  await page.waitForTimeout(300)
  const offHeight = await page.evaluate(() => (
    document.querySelector<HTMLElement>('#historyMatchesMissions')?.getBoundingClientRect().height ?? 0
  ))

  await range.click()
  await page.getByRole('option', { name: 'Last day' }).click()
  await expect(historyCards).toHaveCount(1)
  await expect(page.locator('.layout-moving')).toHaveCount(0)
  const restoredGeometry = await historyMissions.evaluate((element) => {
    const card = element.querySelector<HTMLElement>('[data-tabout="domain-card"]')
    return {
      cardWidth: card?.getBoundingClientRect().width ?? 0,
      containerWidth: element.getBoundingClientRect().width
    }
  })

  expect.soft(
    offHeight,
    `History missions should collapse while disabled; measured ${offHeight}px`
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(restoredGeometry.cardWidth - initialGeometry.cardWidth),
    JSON.stringify({ initialGeometry, restoredGeometry }, null, 2)
  ).toBeLessThanOrEqual(1)
})

test('closing an open search match promotes its matching history result', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)

  await page.evaluate(() => {
    window.chrome.history.search = async () => [{
      id: 'history-example-2',
      title: 'Example 2 with enough tooltip text',
      url: 'https://tab-out-smoke-02.com/docs/2'
    }]
  })

  await page.locator('[data-tabout="filter-query"] input').fill('https://tab-out-smoke-02.com/docs/2')
  const openCard = page.locator('#openTabsMissions [data-tabout-domain="tab-out-smoke-02.com"]')
  const historyCard = page.locator('#historyMatchesMissions [data-tabout-domain="tab-out-smoke-02.com"]')
  const historyStatus = page.locator('[data-tabout="history-search-status"]')
  await expect(openCard).toHaveCount(1)
  await expect(historyCard).toHaveCount(0)
  await expect(historyStatus).toContainText('1 shown in Tabs')

  const openChip = openCard.locator('[data-tabout="page-chip"]')
  await openChip.hover()
  await openChip.locator('[data-tabout-part="close-button"]').click({ force: true })
  await expect(openCard).toHaveCount(0)
  await expect(historyCard).toHaveCount(1)
  await expect(historyStatus).toContainText('1 History match')
  await expect(historyStatus).toContainText('All appear below')
  await expect(historyCard).toContainText('Example 2 with enough tooltip text')
})

test('a Tab Out filter URL update does not restart the current result-card move', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  await expect.poll(() => page.locator('[data-tabout="domain-card"]').count()).toBeGreaterThanOrEqual(12)
  await expect(page.locator('.layout-moving')).toHaveCount(0)

  await page.evaluate(() => {
    const historyItems = (count: number, title: string) => Array.from({ length: count }, (_, index) => ({
      id: `history-example-${index + 1}`,
      title: `${title} ${index + 1}`,
      url: `https://history-example-${index + 1}.test/docs/${index + 1}`
    }))
    window.chrome.history.search = async ({ text }) => {
      if (text === 'Example 20') {
        await new Promise((resolve) => setTimeout(resolve, 800))
        return historyItems(2, 'Example 20 History')
      }
      return historyItems(8, 'Example History')
    }
  })

  const input = page.locator('[data-tabout="filter-query"] input')
  await input.fill('Example')
  await expect(page.locator('#historyMatchesMissions [data-tabout="domain-card"]')).toHaveCount(8)
  await expect(page.locator('.layout-moving')).toHaveCount(0)

  await page.evaluate(() => {
    const targetDomain = 'tab-out-smoke-19.com'
    const starts: Array<{ container: string; time: number }> = []
    const originalAdd = DOMTokenList.prototype.add
    DOMTokenList.prototype.add = function (...tokens: string[]) {
      const result = Reflect.apply(originalAdd, this, tokens)
      if (tokens.includes('layout-moving-active')) {
        const target = Array.from(document.querySelectorAll<HTMLElement>(
          `[data-tabout="domain-card"][data-tabout-domain="${targetDomain}"]`
        )).find((candidate) => candidate.classList === this)
        if (target) {
          starts.push({
            container: target.closest('.missions')?.id || '',
            time: performance.now()
          })
        }
      }
      return result
    }
    ;(window as unknown as {
      __filterSelfUrlMoveProbe: {
        restore: () => void
        starts: typeof starts
      }
    }).__filterSelfUrlMoveProbe = {
      restore: () => {
        DOMTokenList.prototype.add = originalAdd
      },
      starts
    }
  })

  await input.fill('Example 20')
  await page.waitForTimeout(620)
  await page.evaluate(() => {
    const tabOutUrl = 'chrome-extension://tab-out-fake-extension/index.html?filter=Example%2020'
    ;(window.chrome.tabs.onUpdated as unknown as {
      dispatch: (tabId: number, changeInfo: { url?: string }, tab: unknown) => void
    }).dispatch(9999, { url: tabOutUrl }, {
      id: 9999,
      url: tabOutUrl
    })
  })

  await expect(page.locator('#historyMatchesMissions [data-tabout="domain-card"]')).toHaveCount(2)
  await page.waitForTimeout(1_100)
  await expect(page.locator('.layout-moving')).toHaveCount(0)

  const starts = await page.evaluate(() => {
    const probe = (window as unknown as {
      __filterSelfUrlMoveProbe: {
        restore: () => void
        starts: Array<{ container: string; time: number }>
      }
    }).__filterSelfUrlMoveProbe
    probe.restore()
    return probe.starts
  })

  expect(starts, JSON.stringify(starts, null, 2)).toHaveLength(1)
  expect(starts[0]?.container).toBe('openTabsMissionsUnmatched')
})

test('Page Chip overflow expansion fades the expander and reveals hidden chips together', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="overflow-motion.test"]')
  const expander = card.locator('[data-tabout-part="overflow-expander"]')
  await expect(expander).toHaveCount(1)
  await expect(card.locator('.page-chips-overflow-reveal [data-tabout="page-chip"]')).toHaveCount(0)

  const motion = await expander.evaluate((button) => new Promise<{
    fadeKeyframes: Keyframe[]
    revealKeyframes: Keyframe[][]
    revealStartTimes: Array<number | null>
  }>((resolve, reject) => {
    const card = button.closest('[data-tabout="domain-card"]')
    if (!card) {
      reject(new Error('overflow card missing'))
      return
    }

    let fadeKeyframes: Keyframe[] = []
    const timeout = window.setTimeout(() => {
      observer.disconnect()
      reject(new Error('overflow reveal did not mount'))
    }, 1_000)
    const observer = new MutationObserver(() => {
      const revealed = Array.from(card.querySelectorAll<HTMLElement>('.page-chips-overflow-reveal .chip-slot'))
      if (revealed.length === 0 || button.isConnected) return
      observer.disconnect()
      window.clearTimeout(timeout)
      requestAnimationFrame(() => {
        const animations = revealed.map((chip) => chip.getAnimations().find((animation) => {
          const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []
          return frames.some((frame) => typeof frame.transform === 'string')
        }))
        resolve({
          fadeKeyframes,
          revealKeyframes: animations.map((animation) => (
            (animation?.effect as KeyframeEffect | null)?.getKeyframes() ?? []
          )),
          revealStartTimes: animations.map((animation) => (
            animation?.startTime == null ? null : Number(animation.startTime)
          ))
        })
      })
    })

    observer.observe(card, { childList: true, subtree: true })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    requestAnimationFrame(() => {
      fadeKeyframes = button.getAnimations()
        .flatMap((animation) => (
          (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []
        ))
        .filter((frame) => typeof frame.opacity === 'string' || typeof frame.opacity === 'number')
    })
  }))

  expect(motion.fadeKeyframes.some((frame) => Number(frame.opacity) === 0)).toBe(true)
  expect(motion.revealKeyframes).toHaveLength(2)
  expect(motion.revealKeyframes.every((frames) => (
    frames.some((frame) => frame.transform === 'translateY(-4px)') &&
    frames.some((frame) => frame.transform === 'translateY(0px)')
  ))).toBe(true)
  const startTimes = motion.revealStartTimes.filter((value): value is number => typeof value === 'number')
  expect(Math.max(...startTimes) - Math.min(...startTimes)).toBeLessThanOrEqual(1)
})

test('revealed Page Chips share one trim line across the overflow boundary', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')

  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="overflow-motion.test"]')
  const expander = card.locator('[data-tabout-part="overflow-expander"]')
  await expect(expander).toHaveCount(1)
  await expander.click()
  await expect(expander).toHaveCount(0)
  await card.evaluate(async (expandedCard) => {
    await Promise.all(expandedCard.getAnimations({ subtree: true }).map((animation) => (
      animation.finished.catch(() => undefined)
    )))
  })

  const seam = await card.evaluate((expandedCard) => {
    const firstRevealed = expandedCard.querySelector<HTMLElement>('.page-chips-overflow-reveal .chip-slot-row')
    if (!firstRevealed) throw new Error('first revealed Page Chip slot missing')

    const slots = Array.from(expandedCard.querySelectorAll<HTMLElement>('.chip-slot-row'))
      .filter((slot) => slot.getClientRects().length > 0)
    const revealedIndex = slots.indexOf(firstRevealed)
    const previous = slots[revealedIndex - 1]
    if (!previous) throw new Error('visible Page Chip before overflow boundary missing')

    const previousRect = previous.getBoundingClientRect()
    const revealedRect = firstRevealed.getBoundingClientRect()
    return {
      gap: revealedRect.top - previousRect.bottom,
      marginTop: getComputedStyle(firstRevealed).marginTop
    }
  })

  expect(seam.marginTop).toBe('-1px')
  expect(seam.gap).toBeCloseTo(-1, 5)
})

test('Page Chip overflow expansion repacks downstream Domain Cards without overlap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')

  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="overflow-motion.test"]')
  const expander = card.locator('[data-tabout-part="overflow-expander"]')
  await expect(expander).toHaveCount(1)
  await expander.click()
  await expect(expander).toHaveCount(0)
  await card.evaluate(async (expandedCard) => {
    await Promise.all(expandedCard.getAnimations({ subtree: true }).map((animation) => (
      animation.finished.catch(() => undefined)
    )))
  })
  await expect(page.locator('.layout-moving')).toHaveCount(0)

  const overlaps = await card.evaluate((expandedCard) => {
    const expandedRect = expandedCard.getBoundingClientRect()
    const container = expandedCard.closest('.missions')
    if (!container) throw new Error('overflow card masonry container missing')

    return Array.from(container.querySelectorAll<HTMLElement>('[data-tabout="domain-card"]'))
      .filter((candidate) => candidate !== expandedCard)
      .flatMap((candidate) => {
        const candidateRect = candidate.getBoundingClientRect()
        const horizontalOverlap = Math.min(expandedRect.right, candidateRect.right) -
          Math.max(expandedRect.left, candidateRect.left)
        const verticalOverlap = Math.min(expandedRect.bottom, candidateRect.bottom) -
          Math.max(expandedRect.top, candidateRect.top)
        if (horizontalOverlap <= 1 || verticalOverlap <= 1) return []

        return [{
          domain: candidate.dataset.taboutDomain || '',
          horizontalOverlap: Math.round(horizontalOverlap),
          verticalOverlap: Math.round(verticalOverlap)
        }]
      })
  })

  expect(overlaps, JSON.stringify(overlaps, null, 2)).toEqual([])
})

test('closing the last rendered Page Chip before overflow uses the refresh move path', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1&slowCloseRefresh=1')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="overflow-motion.test"]')
  const slots = card.locator('[data-tabout-part="slot"][data-tabout-layout-item]')
  const expander = card.locator('[data-tabout-part="overflow-expander"]')
  await expect(slots).not.toHaveCount(0)
  await expect(expander).toHaveText(/\+\d+ more/)

  const slot = slots.last()
  const scope = await slot.getAttribute('data-tabout-layout-scope')
  expect(scope).toBeTruthy()
  await slot.evaluate((element) => element.setAttribute('data-motion-target-slot', ''))
  await slot.locator('[data-tabout-part="close-button"]').evaluate((element) => element.setAttribute('data-motion-trigger', ''))

  const firstFrame = await page.evaluate(() => new Promise<{
    closing: boolean
    connected: boolean
    display: string
  }>((resolve) => {
    document.querySelector<HTMLElement>('[data-motion-trigger]')?.click()
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>('[data-motion-target-slot]')
      resolve({
        closing: !!target?.classList.contains('closing'),
        connected: !!target?.isConnected,
        display: target?.style.display ?? ''
      })
    })
  }))

  expect(firstFrame).toEqual({
    closing: true,
    connected: true,
    display: ''
  })
})

test('pinning an intra-card section keeps the moved section and its siblings continuous', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="contentful.com"]')
  const pinButton = card.getByRole('button', { name: 'Pin /env-gamma' })
  const target = pinButton.locator('xpath=ancestor::*[@data-tabout-layout-item][1]')
  const scope = await target.getAttribute('data-tabout-layout-scope')
  expect(scope).toBeTruthy()

  const beforeTop = await target.evaluate((element) => element.getBoundingClientRect().top)
  await pinButton.click()
  await expect(card.getByRole('button', { name: 'Unpin /env-gamma' })).toHaveCount(1)

  await expect.poll(() => card.evaluate((element, layoutScope) => {
    return Array.from(element.querySelectorAll<HTMLElement>('[data-tabout-layout-item]'))
      .filter((item) => item.dataset.taboutLayoutScope === layoutScope)
      .filter((item) => item.classList.contains('intra-card-layout-moving'))
      .map((item) => item.style.transform)
      .filter(Boolean)
  }, scope), {
    message: 'section pin should FLIP the local sibling scope',
    timeout: 1_000,
    intervals: [16, 32, 50]
  }).not.toEqual([])

  await expect.poll(() => target.evaluate((element) => ({
    moving: element.classList.contains('intra-card-layout-moving'),
    top: element.getBoundingClientRect().top
  })), {
    message: 'pinned section should settle at its promoted position',
    timeout: 1_000,
    intervals: [50, 100]
  }).toEqual(expect.objectContaining({ moving: false }))
  const afterTop = await target.evaluate((element) => element.getBoundingClientRect().top)
  expect(afterTop).toBeLessThan(beforeTop)
})

test('closing a Page Chip leaves an exit ghost while sibling chips and cards settle', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="overflow-motion.test"]')
  const chip = card.locator('[data-tabout="page-chip"]').first()
  await chip.hover()
  await chip.locator('[data-tabout-part="close-button"]').click({ force: true })

  await expect.poll(() => page.evaluate(() => ({
    cardMoves: document.querySelectorAll('.layout-moving').length,
    chipMoves: document.querySelectorAll('.intra-card-layout-moving').length,
    ghosts: document.querySelectorAll('.page-chip-closing-ghost').length
  })), {
    message: 'Page Chip removal should bridge both local and masonry reflow',
    timeout: 1_000,
    intervals: [16, 32, 50]
  }).toEqual(expect.objectContaining({
    ghosts: 1
  }))

  const ghostMotion = await page.locator('.page-chip-closing-ghost').evaluate((ghost) => (
    ghost.getAnimations().flatMap((animation) => (
      (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []
    ))
  ))
  expect(ghostMotion.some((frame) => Number(frame.opacity) === 0)).toBe(true)
  expect(ghostMotion.some((frame) => frame.transform === 'scale(0.96)')).toBe(true)
  await expect.poll(() => page.locator('.intra-card-layout-moving').count()).toBeGreaterThan(0)
  await expect.poll(() => page.locator('.page-chip-closing-ghost').count(), {
    timeout: 1_000,
    intervals: [50, 100]
  }).toBe(0)
  await expect(card.locator('[data-tabout="page-chip"]')).toHaveCount(6)
})

test('closing the final Page Chip in a scope keeps regrouped survivors continuous', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1&slowCloseRefresh=1')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="last-scope-motion.test"]')
  const chip = card.locator('[data-tabout="page-chip"]', { hasText: 'Last Scope Only' })
  const slot = chip.locator('xpath=ancestor::*[@data-tabout-layout-item][1]')
  const scope = await slot.getAttribute('data-tabout-layout-scope')
  expect(scope).toBeTruthy()
  await expect(card.locator(`[data-tabout-layout-scope="${scope}"][data-tabout-layout-item]`)).toHaveCount(1)

  const followingChip = card.locator('[data-tabout="page-chip"]', { hasText: 'Last Scope Group One' })
  const followingSlot = followingChip.locator('xpath=ancestor::*[@data-tabout-removal-item][1]')
  await expect(followingSlot).toHaveCount(1)
  const followingRemovalKey = await followingSlot.getAttribute('data-tabout-removal-key')
  const beforeTop = await followingSlot.evaluate((element) => element.getBoundingClientRect().top)

  await chip.hover()
  const closeButton = chip.locator('[data-tabout-part="close-button"]')
  await closeButton.focus()
  await closeButton.press('Enter')
  await expect(page.locator('.page-chip-closing-ghost')).toHaveCount(1)
  await expect(page.locator('.page-chip-closing-ghost')).toHaveAttribute('inert', '')
  await expect(slot).toHaveAttribute('inert', '')
  await expect(followingSlot.locator('[data-tabout="page-chip"]')).toBeFocused()
  await expect(followingSlot).toHaveAttribute('data-tabout-removal-key', followingRemovalKey || '')
  await expect.poll(() => followingSlot.evaluate((element) => ({
    moving: element.classList.contains('intra-card-layout-moving'),
    top: element.getBoundingClientRect().top
  })), {
    message: 'the next stable chip should FLIP across the scope regroup',
    timeout: 1_000,
    intervals: [16, 32, 50]
  }).toEqual(expect.objectContaining({ moving: true }))

  await expect.poll(() => followingSlot.evaluate((element) => ({
    moving: element.classList.contains('intra-card-layout-moving'),
    top: element.getBoundingClientRect().top
  })), {
    timeout: 1_000,
    intervals: [50, 100]
  }).toEqual(expect.objectContaining({ moving: false }))
  const afterTop = await followingSlot.evaluate((element) => element.getBoundingClientRect().top)
  expect(afterTop).toBeLessThan(beforeTop)
})

test('a stalled close refresh releases the reserved Page Chip slot with a fallback move', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1&stalledCloseRefresh=1')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="last-scope-motion.test"]')
  const chip = card.locator('[data-tabout="page-chip"]', { hasText: 'Last Scope Only' })
  const slot = chip.locator('xpath=ancestor::*[@data-tabout-layout-item][1]')

  await chip.hover()
  await chip.locator('[data-tabout-part="close-button"]').click({ force: true })
  expect(await slot.evaluate((element) => element.style.display)).toBe('')
  await expect.poll(() => slot.evaluate((element) => element.style.display), {
    message: 'the fallback should release the reserved slot even while refresh is stalled',
    timeout: 1_300,
    intervals: [50, 100]
  }).toBe('none')
  await expect.poll(() => card.locator('.intra-card-layout-moving').count(), {
    timeout: 300,
    intervals: [16, 32]
  }).toBeGreaterThan(0)
})

test('closing the last Page Chip in a section moves the following section as one surface', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html?motion=1&slowCloseRefresh=1')
  const card = page.locator('[data-tabout="domain-card"][data-tabout-domain="google.com"]')
  const documentSection = card.locator('[data-tabout="website-path-section"][data-tabout-layout-key$="|/document"]')
  const spreadsheetSection = card.locator('[data-tabout="website-path-section"][data-tabout-layout-key$="|/spreadsheets"]')
  await expect(documentSection).toHaveCount(1)
  await expect(spreadsheetSection).toHaveCount(1)

  const chip = documentSection.locator('[data-tabout="page-chip"]', { hasText: 'Example Document Gamma' })
  const slot = chip.locator('xpath=ancestor::*[@data-tabout-layout-item][1]')
  const scope = await slot.getAttribute('data-tabout-layout-scope')
  expect(scope).toBeTruthy()
  const scopeItems = documentSection.locator(`[data-tabout-layout-scope="${scope}"][data-tabout-layout-item]`)
  await expect(scopeItems).toHaveCount(3)
  expect(await slot.evaluate((element, layoutScope) => {
    const items = Array.from(element.closest('[data-tabout="website-path-section"]')?.querySelectorAll<HTMLElement>(
      `[data-tabout-layout-scope="${layoutScope}"][data-tabout-layout-item]`
    ) ?? [])
    return items.at(-1) === element
  }, scope)).toBe(true)

  const beforeTop = await spreadsheetSection.evaluate((element) => element.getBoundingClientRect().top)
  await chip.hover()
  await spreadsheetSection.evaluate((element) => element.setAttribute('data-motion-probe', ''))
  await chip.locator('[data-tabout-part="close-button"]').evaluate((element) => element.setAttribute('data-motion-trigger', ''))
  const samples = await page.evaluate(async () => {
    const startedAt = performance.now()
    const frames: Array<{
      cardTop: number
      elapsed: number
      localTop: number
      moving: boolean
      nestedMovers: number
      top: number
      transform: string
    }> = []
    document.querySelector<HTMLElement>('[data-motion-trigger]')?.click()
    return new Promise<typeof frames>((resolve) => {
      function sampleFrame() {
        const section = document.querySelector<HTMLElement>('[data-motion-probe]')
        const cardElement = section?.closest<HTMLElement>('[data-tabout="domain-card"]')
        if (section && cardElement) {
          const rect = section.getBoundingClientRect()
          const cardRect = cardElement.getBoundingClientRect()
          frames.push({
            cardTop: cardRect.top,
            elapsed: performance.now() - startedAt,
            localTop: rect.top - cardRect.top,
            moving: section.classList.contains('intra-card-layout-moving'),
            nestedMovers: section.querySelectorAll('.intra-card-layout-moving').length,
            top: rect.top,
            transform: section.style.transform
          })
        }
        if (performance.now() - startedAt >= 500) resolve(frames)
        else requestAnimationFrame(sampleFrame)
      }
      requestAnimationFrame(sampleFrame)
    })
  })

  const firstUpwardFrame = samples.find((sample) => sample.top < beforeTop - 1)
  expect(firstUpwardFrame, `first upward frames: ${JSON.stringify(samples.slice(0, 12))}`).toEqual(expect.objectContaining({
    moving: true,
    nestedMovers: 0,
    transform: expect.stringMatching(/^translate/)
  }))
  const reversalFrameIndex = samples.findIndex((sample, index) => (
    index > 0 && sample.top > (samples[index - 1]?.top ?? sample.top) + 1
  ))
  expect(reversalFrameIndex, `non-monotonic frames: ${JSON.stringify(samples)}`).toBe(-1)
  const settledFrame = samples.at(-1)
  expect(settledFrame).toEqual(expect.objectContaining({ moving: false }))
  expect(settledFrame?.top).toBeLessThan(beforeTop)
})

test('closing an Activation History entry leaves an exit ghost while survivor rows fill the gap', async ({ page }) => {
  await page.goto('/tests/fixtures/dashboard-resize.html')
  const row = page.locator('[data-tabout="activation-history-entry"]').nth(2)
  await row.hover()
  await row.locator('[data-tabout-part="close-button"]').click({ force: true })

  await expect.poll(() => page.evaluate(() => ({
    ghosts: document.querySelectorAll('.history-entry-closing-ghost').length,
    hiddenRows: Array.from(document.querySelectorAll<HTMLElement>('[data-tabout="activation-history-entry"]'))
      .filter((entry) => getComputedStyle(entry).display === 'none').length
  })), {
    message: 'History removal should hide the real row and FLIP survivors immediately',
    timeout: 1_000,
    intervals: [16, 32, 50]
  }).toEqual({
    ghosts: 1,
    hiddenRows: 1
  })
  await expect.poll(() => page.locator('.history-entry-layout-moving').count()).toBeGreaterThan(0)

  const ghostMotion = await page.locator('.history-entry-closing-ghost').evaluate((ghost) => (
    ghost.getAnimations().flatMap((animation) => (
      (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? []
    ))
  ))
  expect(ghostMotion.some((frame) => Number(frame.opacity) === 0)).toBe(true)
  expect(ghostMotion.some((frame) => frame.transform === 'scale(0.96)')).toBe(true)
  await expect.poll(() => page.locator('.history-entry-closing-ghost').count(), {
    timeout: 1_000,
    intervals: [50, 100]
  }).toBe(0)
  await expect.poll(() => page.locator('.history-entry-layout-moving').count()).toBe(0)
})
