import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { WorkingSetPanel } from '../src/components/WorkingSetPanel.js'
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
  assert.match(html, /rounded-xl/)
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
  assert.doesNotMatch(itemClassMatch[1], /\bcursor-pointer\b/)
  assert.doesNotMatch(itemClassMatch[1], /\btransition-/)
  assert.doesNotMatch(itemClassMatch[1], /\bduration-/)
  assert.doesNotMatch(itemClassMatch[1], /\bease-/)
  const toggleClassMatch = html.match(/<button[^>]*class="([^"]*\bworking-set-toggle\b[^"]*)"/)
  assert.ok(toggleClassMatch, 'working set toggle should render as a button')
  assert.match(toggleClassMatch[1], /\bworking-set-item\b/)
  assert.match(toggleClassMatch[1], /\bcursor-default\b/)
  assert.match(toggleClassMatch[1], /\bmin-h-12\b/)
  assert.match(toggleClassMatch[1], /\brounded-xl\b/)
  assert.doesNotMatch(toggleClassMatch[1], /\bh-6\b/)
  assert.doesNotMatch(toggleClassMatch[1], /\bcursor-pointer\b/)
  assert.doesNotMatch(toggleClassMatch[1], /\btransition-/)
  assert.match(html, /working-set-item[^"]*\bis-active-working-set-item\b/)
  assert.doesNotMatch(html, /working-set-item[^"]*\bring-inset\b/)
  assert.doesNotMatch(html, /working-set-item[^"]*\bring-neutral-400\b/)
  assert.match(html, /Page 1/)
  assert.match(html, /Page 8/)
  assert.doesNotMatch(html, /Page 9/)
  assert.match(html, />Show more</)
  assert.doesNotMatch(html, /title="Page 1"/)
  assert.doesNotMatch(html, /working-set-url/)
  assert.doesNotMatch(html, /example\.com\/page-1/)
  assert.match(html, /×2/)
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

test('WorkingSetPanel outlines matching items only when chip hover owns the match', () => {
  const snapshot = {
    defaultLimit: 8,
    expandedLimit: 16,
    items: [makeWorkingSetItem(1)]
  }
  const matchedHtml = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      activeHoverUrl: 'https://example.com/page-1',
      activeHoverSource: 'chip'
    })
  )
  const selfHoverHtml = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      activeHoverUrl: 'https://example.com/page-1',
      activeHoverSource: 'working-set'
    })
  )
  const itemMatch = matchedHtml.match(/<button[^>]*class="([^"]*\bworking-set-item\b[^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<button[^>]*class="([^"]*\bworking-set-item\b[^"]*)"/)

  assert.ok(itemMatch, 'working set item should render')
  assert.ok(selfHoverMatch, 'self-hover working set item should render')
  assert.match(itemMatch[1], /\bworking-set-item-hover-match\b/)
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

test('WorkingSetPanel emits an external hover source for matching open tab chips', () => {
  const source = readFileSync(new URL('../src/components/WorkingSetPanel.tsx', import.meta.url), 'utf8')

  assert.match(source, /onHoverUrlChange\?\.\(item\.tabUrl, 'working-set', \[item\.tabUrl, item\.rawUrl\]\)/)
  assert.doesNotMatch(source, /onHoverUrlChange\?\.\(item\.tabUrl, 'chip', \[item\.tabUrl, item\.rawUrl\]\)/)
})
