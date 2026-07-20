import { expect, test, type Locator, type Page } from '@playwright/test'

type DashboardGeometry = {
  cardCount: number
  columns: number
  firstWidth: number
  headerControlsRight: number | null
  missionsRight: number | null
  sourceSwitchRight: number | null
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
  await expect(chip).toHaveClass(/page-chip-expanded/)
  await page.mouse.move(2, 2)
  await expect(chip).not.toHaveClass(/page-chip-expanded/)

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
  await input.fill('Example')
  await expect(historyCards).toHaveCount(2)

  await input.fill('Example 20')
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __nextHistorySearchStarted: boolean }).__nextHistorySearchStarted
  ))).toBe(true)
  await expect(historyCards).toHaveCount(0, { timeout: 300 })
  await expect(historyCards).toHaveCount(1)
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
  await expect(historyCards).toHaveCount(1)
  await expect(historyCards).toContainText('Scope result day')

  await page.getByRole('combobox', { name: 'History search range' }).click()
  await page.getByRole('option', { name: 'Last week' }).click()
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __historyRangeSearchStarted: boolean }).__historyRangeSearchStarted
  ))).toBe(true)
  await expect(historyCards).toHaveCount(1, { timeout: 300 })
  await expect(historyCards).toContainText('Scope result day')
  await expect(historyCards).toHaveCount(2)
  await expect(historyCards.filter({ hasText: 'Scope result week one' })).toHaveCount(1)
  await expect(historyCards.filter({ hasText: 'Scope result week two' })).toHaveCount(1)
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
  await expect(openCard).toHaveCount(1)
  await expect(historyCard).toHaveCount(0)

  const openChip = openCard.locator('[data-tabout="page-chip"]')
  await openChip.hover()
  await openChip.locator('[data-tabout-part="close-button"]').click({ force: true })
  await expect(openCard).toHaveCount(0)
  await expect(historyCard).toHaveCount(1)
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
  const renderedSlotIndexes = await slots.evaluateAll((items) => items.flatMap((item, index) => (
    item.getClientRects().length > 0 ? [index] : []
  )))
  expect(renderedSlotIndexes.length).toBeGreaterThan(0)
  expect(renderedSlotIndexes.length).toBeLessThan(await slots.count())

  const slot = slots.nth(renderedSlotIndexes.at(-1) ?? -1)
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
