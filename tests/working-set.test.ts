import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { WorkingSetPanel } from '../src/components/WorkingSetPanel.js'
import {
  buildWorkingSetSnapshot,
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

test('WorkingSetPanel renders a bounded switching surface without cleanup controls', () => {
  const snapshot = {
    defaultLimit: 8,
    expandedLimit: 16,
    items: Array.from({ length: 9 }, (_, index) => makeWorkingSetItem(index + 1, index === 1 ? { dupeCount: 2 } : {}))
  }

  const html = renderToStaticMarkup(
    React.createElement(WorkingSetPanel, {
      snapshot,
      onHoverUrlChange: () => {}
    })
  )

  assert.match(html, /working-set-panel/)
  assert.match(html, /Page 1/)
  assert.match(html, /Page 8/)
  assert.doesNotMatch(html, /Page 9/)
  assert.match(html, /×2/)
  assert.doesNotMatch(html, /Close this tab/)
})
