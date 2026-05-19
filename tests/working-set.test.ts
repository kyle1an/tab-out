import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { WorkingSetPanel } from '../src/components/WorkingSetPanel.js'
import { snapshotWorkingSetItemPositions } from '../src/extension/working-set-move-animation.js'
import {
  buildWorkingSetSnapshot,
  dismissWorkingSetActivity,
  emptyWorkingSetActivity,
  pageIdentityForWorkingSet,
  recordWorkingSetActivity
} from '../src/extension/working-set.js'
import type { DashboardTab, WorkingSetActivityStore, WorkingSetItem } from '../src/extension/types'

function makeTab(overrides: Partial<DashboardTab> & { id: number; url: string; title: string }): DashboardTab {
  return {
    rawUrl: overrides.rawUrl || overrides.url,
    suspended: false,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...overrides
  }
}

function record(store: WorkingSetActivityStore, tab: DashboardTab, kind: 'activation' | 'navigation', at: number) {
  return recordWorkingSetActivity(store, {
    kind,
    at,
    tab
  })
}

function makeWorkingSetItem(index: number, overrides: Partial<WorkingSetItem> = {}): WorkingSetItem {
  return {
    key: `https://example.com/page-${index}`,
    tabId: index,
    windowId: 1,
    tabUrl: `https://example.com/page-${index}`,
    rawUrl: `https://example.com/page-${index}`,
    title: `Page ${index}`,
    displayUrl: `example.com/page-${index}`,
    faviconUrl: '',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    score: 100 - index,
    ...overrides
  }
}

test('pageIdentityForWorkingSet distinguishes meaningful paths and ignores noisy fragments', () => {
  assert.equal(
    pageIdentityForWorkingSet('https://example.com/issues/123?utm_source=mail#comments'),
    'https://example.com/issues/123'
  )
  assert.equal(
    pageIdentityForWorkingSet('https://example.com/issues/456'),
    'https://example.com/issues/456'
  )
  assert.equal(pageIdentityForWorkingSet('chrome-extension://tab-out/index.html'), '')
  assert.equal(pageIdentityForWorkingSet('https://www.google.com/search?q=example'), '')
})

test('buildWorkingSetSnapshot ranks open tabs by recency-dominant activity and folds duplicates', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
    makeTab({ id: 2, url: 'https://example.com/issues/bravo', title: 'Bravo issue' }),
    makeTab({ id: 3, url: 'https://example.com/issues/charlie', title: 'Charlie issue' }),
    makeTab({ id: 4, url: 'https://example.com/issues/bravo?utm_source=mail', title: 'Bravo duplicate' }),
    makeTab({ id: 5, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', isTabOut: true }),
    makeTab({ id: 6, url: 'https://mail.example.com/', title: 'Mail app', isApp: true })
  ]

  let store = emptyWorkingSetActivity()
  store = record(store, tabs[0], 'activation', now - 60_000)
  store = record(store, tabs[1], 'activation', now - 10 * 60_000)
  store = record(store, tabs[1], 'navigation', now - 9 * 60_000)
  store = record(store, tabs[1], 'activation', now - 8 * 60_000)
  store = record(store, tabs[2], 'activation', now - 4 * 24 * 60 * 60_000)
  store = record(store, tabs[2], 'navigation', now - 3 * 24 * 60 * 60_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    defaultLimit: 8,
    expandedLimit: 16,
    minItems: 1
  })

  assert.deepEqual(
    snapshot.items.map((item) => item.tabId),
    [1, 2, 3]
  )
  assert.equal(snapshot.items[1].dupeCount, 2)
  assert.equal(snapshot.items.some((item) => item.title === 'Tab Out'), false)
  assert.equal(snapshot.items.some((item) => item.title === 'Mail app'), false)
})

test('buildWorkingSetSnapshot keeps live tab favicons aligned with Chrome tab state', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
    makeTab({
      id: 2,
      url: 'https://example.com/issues/bravo',
      title: 'Bravo issue',
      favIconUrl: 'data:image/png;base64,abc'
    })
  ]

  let store = emptyWorkingSetActivity()
  store = record(store, tabs[0], 'activation', now - 60_000)
  store = record(store, tabs[1], 'activation', now - 120_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    minItems: 1
  })

  assert.equal(snapshot.items[0].faviconUrl, '')
  assert.equal(snapshot.items[1].faviconUrl, 'data:image/png;base64,abc')
})

test('buildWorkingSetSnapshot excludes Google Search result pages from working set items', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://www.google.com/search?q=example', title: 'example - Google Search' }),
    makeTab({ id: 2, url: 'https://example.com/issues/alpha', title: 'Alpha issue' })
  ]

  let store = emptyWorkingSetActivity()
  store = record(store, tabs[0], 'activation', now - 60_000)
  store = record(store, tabs[1], 'activation', now - 30_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    minItems: 1
  })

  assert.deepEqual(
    snapshot.items.map((item) => item.tabId),
    [2]
  )
})

test('buildWorkingSetSnapshot hides below the minimum meaningful candidate count', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
    makeTab({ id: 2, url: 'https://example.com/issues/bravo', title: 'Bravo issue' })
  ]
  let store = emptyWorkingSetActivity()
  store = record(store, tabs[0], 'activation', now - 60_000)
  store = record(store, tabs[1], 'activation', now - 120_000)

  const snapshot = buildWorkingSetSnapshot({
    tabs,
    activity: store,
    now,
    minItems: 3
  })

  assert.deepEqual(snapshot.items, [])
})

test('buildWorkingSetSnapshot excludes dismissed items until fresh activity or expiry', () => {
  const now = Date.UTC(2026, 4, 17, 12)
  const dismissedAt = now + 60_000
  const tabs = [
    makeTab({ id: 1, url: 'https://example.com/issues/alpha', title: 'Alpha issue' }),
    makeTab({ id: 2, url: 'https://example.com/issues/bravo', title: 'Bravo issue' }),
    makeTab({ id: 3, url: 'https://example.com/issues/charlie', title: 'Charlie issue' })
  ]

  let store = emptyWorkingSetActivity()
  for (const tab of tabs) store = record(store, tab, 'activation', now)
  const dismissedStore = dismissWorkingSetActivity(store, tabs[0].url, dismissedAt)

  const dismissedSnapshot = buildWorkingSetSnapshot({
    tabs,
    activity: dismissedStore,
    now: dismissedAt + 1,
    minItems: 1
  })
  assert.deepEqual(
    dismissedSnapshot.items.map((item) => item.tabId),
    [2, 3]
  )

  const reactivatedStore = record(dismissedStore, tabs[0], 'activation', dismissedAt + 1000)
  const reactivatedSnapshot = buildWorkingSetSnapshot({
    tabs,
    activity: reactivatedStore,
    now: dismissedAt + 1001,
    minItems: 1
  })
  assert.equal(reactivatedSnapshot.items.some((item) => item.tabId === 1), true)

  const navigatedTab = makeTab({
    id: 1,
    rawUrl: 'https://example.com/issues/alpha/comments',
    url: 'https://example.com/issues/alpha/comments',
    title: 'Alpha issue comments'
  })
  const navigatedStore = record(dismissedStore, navigatedTab, 'navigation', dismissedAt + 2000)
  const navigatedSnapshot = buildWorkingSetSnapshot({
    tabs: [navigatedTab, tabs[1], tabs[2]],
    activity: navigatedStore,
    now: dismissedAt + 2001,
    minItems: 1
  })
  assert.equal(navigatedSnapshot.items.some((item) => item.tabId === 1), true)

  const nextDaySnapshot = buildWorkingSetSnapshot({
    tabs,
    activity: dismissedStore,
    now: dismissedAt + 24 * 60 * 60_000,
    minItems: 1
  })
  assert.equal(nextDaySnapshot.items.some((item) => item.tabId === 1), true)
})

test('WorkingSetPanel renders a bounded switching surface without cleanup controls', () => {
  const snapshot = {
    defaultLimit: 8,
    expandedLimit: 16,
    items: Array.from({ length: 9 }, (_, index) => makeWorkingSetItem(index + 1, {
      ...(index === 0 ? { active: true } : {}),
      ...(index === 1 ? { dupeCount: 2 } : {})
    }))
  }

  const html = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      onHoverUrlChange: () => {}
    })
  )

  assert.match(html, /working-set-panel/)
  assert.doesNotMatch(html, /working-set-panel-header/)
  assert.doesNotMatch(html, />Working set</)
  assert.match(html, /working-set-grid/)
  assert.match(html, /working-set-layout-item/)
  assert.match(html, /data-working-set-layout-key="ws-[a-z0-9]+"/)
  assert.match(html, /rounded-\[18px\]/)
  assert.match(html, /min-h-12/)
  assert.match(html, /max-h-\[calc\(2lh\)\]/)
  assert.match(html, /working-set-title-truncated/)
  assert.doesNotMatch(html, /line-clamp-2/)
  assert.match(html, /minmax\(230px,1fr\)/)
  const itemClassMatch = html.match(/<button[^>]*class="([^"]*\bworking-set-item\b[^"]*)"/)
  assert.ok(itemClassMatch, 'working set item should render as a button')
  assert.match(itemClassMatch[1], /\bcursor-default\b/)
  assert.match(itemClassMatch[1], /after:bg-\[linear-gradient\(to_right,transparent,var\(--working-set-hover-fade-bg\)_50%\)\]/)
  assert.match(itemClassMatch[1], /group-hover\/working-set-item:after:opacity-100/)
  assert.doesNotMatch(itemClassMatch[1], /\bpr-8\b/)
  assert.doesNotMatch(itemClassMatch[1], /\bcursor-pointer\b/)
  assert.doesNotMatch(itemClassMatch[1], /\btransition-/)
  assert.doesNotMatch(itemClassMatch[1], /\bduration-/)
  assert.doesNotMatch(itemClassMatch[1], /\bease-/)
  const toggleClassMatch = html.match(/<button[^>]*class="([^"]*\bworking-set-toggle\b[^"]*)"/)
  assert.ok(toggleClassMatch, 'working set toggle should render as a button')
  assert.match(toggleClassMatch[1], /\bworking-set-item\b/)
  assert.match(toggleClassMatch[1], /\bworking-set-layout-item\b/)
  assert.match(toggleClassMatch[1], /\bcursor-default\b/)
  assert.match(toggleClassMatch[1], /\bmin-h-12\b/)
  assert.match(toggleClassMatch[1], /rounded-\[18px\]/)
  assert.match(html, /data-working-set-layout-key="__working-set-toggle__"/)
  assert.doesNotMatch(toggleClassMatch[1], /\bh-6\b/)
  assert.doesNotMatch(toggleClassMatch[1], /\bcursor-pointer\b/)
  assert.doesNotMatch(toggleClassMatch[1], /\btransition-/)
  assert.match(html, /working-set-item[^"]*\bis-active-working-set-item\b/)
  assert.doesNotMatch(html, /working-set-item[^"]*\bring-inset\b/)
  assert.doesNotMatch(html, /working-set-item[^"]*\bring-neutral-400\b/)
  assert.match(html, /Page 1/)
  assert.match(html, /Page 8/)
  assert.doesNotMatch(html, /Page 9/)
  assert.match(html, /default-favicon-image/)
  assert.match(html, />Show more</)
  assert.doesNotMatch(html, /title="Page 1"/)
  assert.doesNotMatch(html, /working-set-url/)
  assert.doesNotMatch(html, /example\.com\/page-1/)
  assert.doesNotMatch(html, /×2/)
  assert.match(html, /aria-label="Switch to Page 2, 2 open copies"/)
  const dupeBadgeMatch = html.match(/<span class="([^"]*\bworking-set-dupe-badge\b[^"]*)" aria-hidden="true"><span class="([^"]*)">2<\/span><\/span>/)
  assert.ok(dupeBadgeMatch, 'working set duplicate badge should render')
  assert.match(dupeBadgeMatch[1], /\bchip-dupe-badge\b/)
  assert.match(dupeBadgeMatch[1], /\babsolute\b/)
  assert.match(dupeBadgeMatch[1], /-top-\[7px\]/)
  assert.match(dupeBadgeMatch[1], /-right-\[7px\]/)
  assert.match(dupeBadgeMatch[1], /\bitems-center\b/)
  assert.doesNotMatch(dupeBadgeMatch[1], /\bitems-start\b/)
  assert.doesNotMatch(dupeBadgeMatch[1], /\bpt-px\b/)
  assert.match(dupeBadgeMatch[1], /\bbg-\[rgba\(254,243,199,0\.98\)\]/)
  assert.match(dupeBadgeMatch[1], /\btext-\[rgb\(120,53,15\)\]/)
  assert.doesNotMatch(dupeBadgeMatch[1], /\bborder-2\b/)
  assert.doesNotMatch(dupeBadgeMatch[1], /\bborder-\[/)
  assert.doesNotMatch(dupeBadgeMatch[1], /\bbg-\[var\(--accent-amber\)\]/)
  assert.match(dupeBadgeMatch[2], /-translate-y-\[1px\]/)
  assert.match(html, /working-set-dismiss/)
  assert.match(html, /working-set-actions/)
  assert.match(html, /Dismiss Page 1 from working set/)
  const dismissClassMatch = html.match(/<button[^>]*class="([^"]*\bworking-set-dismiss\b[^"]*)"/)
  assert.ok(dismissClassMatch, 'working set dismiss should render as an icon button')
  assert.match(dismissClassMatch[1], /\brounded-full\b/)
  assert.match(dismissClassMatch[1], /\bborder-0\b/)
  assert.match(dismissClassMatch[1], /transition-\[opacity,color,background\]/)
  assert.doesNotMatch(dismissClassMatch[1], /\[corner-shape:squircle\]/)
  assert.match(html, /lucide-eye-off/)
  assert.doesNotMatch(html, /lucide-x/)
  assert.doesNotMatch(html, /Close this tab/)
})

test('WorkingSetPanel outlines matching items when another source owns the match', () => {
  const snapshot = {
    defaultLimit: 8,
    expandedLimit: 16,
    items: [makeWorkingSetItem(1)]
  }
  const chipHoverHtml = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      activeHoverUrl: 'https://example.com/page-1',
      activeHoverSource: 'chip'
    })
  )
  const historyHoverHtml = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      activeHoverUrl: 'https://example.com/page-1',
      activeHoverSource: 'history'
    })
  )
  const selfHoverHtml = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      activeHoverUrl: 'https://example.com/page-1',
      activeHoverSource: 'working-set'
    })
  )
  const chipHoverMatch = chipHoverHtml.match(/<button[^>]*class="([^"]*\bworking-set-item\b[^"]*)"/)
  const historyHoverMatch = historyHoverHtml.match(/<button[^>]*class="([^"]*\bworking-set-item\b[^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<button[^>]*class="([^"]*\bworking-set-item\b[^"]*)"/)

  assert.ok(chipHoverMatch, 'chip-hover working set item should render')
  assert.ok(historyHoverMatch, 'history-hover working set item should render')
  assert.ok(selfHoverMatch, 'self-hover working set item should render')
  assert.match(chipHoverMatch[1], /\bworking-set-item-hover-match\b/)
  assert.match(historyHoverMatch[1], /\bworking-set-item-hover-match\b/)
  assert.doesNotMatch(selfHoverMatch[1], /\bworking-set-item-hover-match\b/)
})

test('WorkingSetPanel matches chip hover against raw tab URLs', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fpage-1'
  const snapshot = {
    defaultLimit: 8,
    expandedLimit: 16,
    items: [makeWorkingSetItem(1, { rawUrl })]
  }
  const html = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      activeHoverUrl: 'https://example.com/preview',
      activeHoverUrls: [rawUrl],
      activeHoverSource: 'chip'
    })
  )
  const itemMatch = html.match(/<button[^>]*class="([^"]*\bworking-set-item\b[^"]*)"/)

  assert.ok(itemMatch, 'working set item should render')
  assert.match(itemMatch[1], /\bworking-set-item-hover-match\b/)
})

test('WorkingSetPanel active item hover keeps one border layer with stronger contrast', () => {
  const styleSource = readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8')
  const activeMatch = styleSource.match(/\.working-set-item\.is-active-working-set-item\s*\{([^}]*)\}/)
  const activeHoverMatch = styleSource.match(/\.working-set-item\.is-active-working-set-item:hover,\n\.working-set-item-shell:hover > \.working-set-item\.is-active-working-set-item,\n\.working-set-item-shell:focus-within > \.working-set-item\.is-active-working-set-item\s*\{([^}]*)\}/)

  assert.ok(activeMatch, 'active working set item rule should exist')
  assert.ok(activeHoverMatch, 'active working set item hover rule should exist')
  assert.match(activeMatch[1], /border-color:\s*color-mix\(in srgb, var\(--accent-slate\) 45%, var\(--warm-gray\)\);/)
  assert.doesNotMatch(activeMatch[1], /\bring\b/)
  assert.doesNotMatch(activeMatch[1], /\boutline\b/)
  assert.match(activeHoverMatch[1], /border-color:\s*var\(--accent-amber\);/)
  assert.match(activeHoverMatch[1], /background:\s*color-mix\(in srgb, var\(--card-bg\) 88%, var\(--accent-amber\)\);/)
  assert.doesNotMatch(activeHoverMatch[1], /\bring\b/)
  assert.doesNotMatch(activeHoverMatch[1], /\boutline\b/)
})

test('WorkingSetPanel keeps the moving show toggle visually neutral', () => {
  const styleSource = readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8')
  const toggleMoveMatch = styleSource.match(/\.working-set-toggle\.working-set-layout-moving,\n\.working-set-toggle\.working-set-layout-moving:hover,\n\.working-set-toggle\.working-set-layout-moving:active,\n\.working-set-toggle\.working-set-layout-moving:focus,\n\.working-set-toggle\.working-set-layout-moving:focus-visible\s*\{([^}]*)\}/)

  assert.ok(toggleMoveMatch, 'moving working set toggle rule should exist')
  assert.match(toggleMoveMatch[1], /border-color:\s*var\(--warm-gray\);/)
  assert.match(toggleMoveMatch[1], /background:\s*var\(--card-bg\);/)
  assert.match(toggleMoveMatch[1], /color:\s*var\(--muted\);/)
  assert.match(toggleMoveMatch[1], /box-shadow:\s*none;/)
  assert.doesNotMatch(toggleMoveMatch[1], /\btransition\b/)
})

test('WorkingSetPanel emits an external hover source for matching open tab chips', () => {
  const source = readFileSync(new URL('../src/components/WorkingSetPanel.tsx', import.meta.url), 'utf8')

  assert.match(source, /onHoverUrlChange\?\.\(item\.tabUrl, 'working-set', \[item\.tabUrl, item\.rawUrl\]\)/)
  assert.doesNotMatch(source, /onHoverUrlChange\?\.\(item\.tabUrl, 'chip', \[item\.tabUrl, item\.rawUrl\]\)/)
})

test('WorkingSetPanel uses transform snapshots for item move animation', () => {
  const panelSource = readFileSync(new URL('../src/components/WorkingSetPanel.tsx', import.meta.url), 'utf8')
  const animationSource = readFileSync(new URL('../src/extension/working-set-move-animation.ts', import.meta.url), 'utf8')

  assert.match(panelSource, /snapshotWorkingSetItemPositions\(grid\)/)
  assert.match(panelSource, /animateWorkingSetItemMoves\(grid, itemPositionsRef\.current\)/)
  assert.match(animationSource, /item\.style\.transform = `translate\(\$\{dx\}px, \$\{dy\}px\)`/)
  assert.match(animationSource, /item\.style\.transition = `transform \$\{WORKING_SET_ITEM_MOVE_MS\}ms cubic-bezier\(0\.2, 0, 0, 1\)`/)
  assert.match(animationSource, /prefers-reduced-motion: reduce/)
  assert.doesNotMatch(animationSource, /transition[^=]*=.*\b(?:top|left|width)\b/)
})

test('snapshotWorkingSetItemPositions reads stable grid offsets by layout key', () => {
  const grid = {
    querySelectorAll() {
      return [
        {
          dataset: { workingSetLayoutKey: 'first' },
          offsetLeft: 12,
          offsetTop: 34
        },
        {
          dataset: { workingSetLayoutKey: 'second' },
          offsetLeft: 56,
          offsetTop: 78
        },
        {
          dataset: {},
          offsetLeft: 90,
          offsetTop: 12
        }
      ]
    }
  } as unknown as HTMLElement

  assert.deepEqual(
    Array.from(snapshotWorkingSetItemPositions(grid).entries()),
    [
      ['first', { left: 12, top: 34 }],
      ['second', { left: 56, top: 78 }]
    ]
  )
})
