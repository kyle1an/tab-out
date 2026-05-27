import assert from 'node:assert/strict'
import test from 'node:test'

import { buildHistoryPanelRows } from '../src/hooks/useHistoryPanelRows.js'
import type { TabHistoryEntry, TabHistorySnapshot, WorkingSetItem, WorkingSetSnapshot } from '../src/extension/types'
import type { ClosedTabEntry } from '../src/extension/closed-tabs.js'

function makeStackEntry(overrides: Partial<TabHistoryEntry> & { index: number; tabId: number; url: string }): TabHistoryEntry {
  return {
    windowId: 1,
    exists: true,
    active: false,
    activeInOtherWindow: false,
    isApp: false,
    pinned: false,
    discarded: false,
    cursor: false,
    current: false,
    previousTarget: false,
    nextTarget: false,
    title: `Title ${overrides.tabId}`,
    rawUrl: overrides.url,
    displayUrl: overrides.url,
    favIconUrl: '',
    lastActivatedAt: null,
    ...overrides
  }
}

function makeWorkingSetItem(overrides: Partial<WorkingSetItem> & { key: string; tabId: number }): WorkingSetItem {
  return {
    windowId: 1,
    tabUrl: overrides.key,
    rawUrl: overrides.key,
    title: `WS ${overrides.tabId}`,
    displayUrl: overrides.key,
    faviconUrl: '',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    score: 100,
    lastActivatedAt: 0,
    ...overrides
  }
}

function makeClosed(overrides: Partial<ClosedTabEntry> & { sessionId: string; url: string; lastClosedAt: number }): ClosedTabEntry {
  return {
    tabId: -1,
    rawUrl: overrides.url,
    displayUrl: overrides.url,
    title: `Closed ${overrides.sessionId}`,
    favIconUrl: '',
    ...overrides
  }
}

function snapshotOf(entries: TabHistoryEntry[]): TabHistorySnapshot {
  return {
    stackSize: entries.length,
    maxSize: 24,
    cursorIndex: entries.length - 1,
    currentIndex: entries.length - 1,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: null,
    activeWindowId: null,
    activeWasInserted: false,
    entries
  }
}

function workingSetOf(items: WorkingSetItem[]): WorkingSetSnapshot {
  return { defaultLimit: 8, expandedLimit: 16, items }
}

test('buildHistoryPanelRows produces one row per source candidate', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/a', lastActivatedAt: 1000 })]),
    workingSet: workingSetOf([makeWorkingSetItem({ key: 'https://example.com/b', tabId: 2, lastActivatedAt: 2000 })]),
    closedTabs: [makeClosed({ sessionId: 'c', url: 'https://example.com/c', lastClosedAt: 3000 })],
    filter: ''
  })
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['closed-ghost', 'open-ghost', 'stack'])
})

test('buildHistoryPanelRows handles all-empty sources', () => {
  const rows = buildHistoryPanelRows({
    snapshot: null,
    workingSet: null,
    closedTabs: [],
    filter: ''
  })
  assert.deepEqual(rows, [])
})

test('buildHistoryPanelRows applies filter to all three kinds by title and url', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/alpha', title: 'Alpha', lastActivatedAt: 1 }),
      makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/bravo', title: 'Bravo', lastActivatedAt: 2 })
    ]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/charlie', tabId: 3, title: 'Charlie', lastActivatedAt: 3 }),
      makeWorkingSetItem({ key: 'https://example.com/alpha2', tabId: 4, title: 'Alpha 2', lastActivatedAt: 4 })
    ]),
    closedTabs: [
      makeClosed({ sessionId: 'd', url: 'https://example.com/delta', title: 'Delta', lastClosedAt: 5 }),
      makeClosed({ sessionId: 'a', url: 'https://example.com/alpha-archive', title: 'Alpha Archive', lastClosedAt: 6 })
    ],
    filter: 'alpha'
  })

  const kinds = rows.map((r) => r.kind).sort()
  assert.equal(rows.length, 3)
  assert.deepEqual(kinds, ['closed-ghost', 'open-ghost', 'stack'])
})

test('buildHistoryPanelRows hides open-ghost when same URL exists as stack', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/shared', title: 'Shared', lastActivatedAt: 10 })
    ]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/shared', tabId: 1, lastActivatedAt: 20 })
    ]),
    closedTabs: [],
    filter: ''
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'stack')
})

test('buildHistoryPanelRows hides closed-ghost when same URL exists as open-ghost', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/shared', tabId: 1, lastActivatedAt: 5 })
    ]),
    closedTabs: [
      makeClosed({ sessionId: 'x', url: 'https://example.com/shared', lastClosedAt: 100 })
    ],
    filter: ''
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'open-ghost')
})

test('buildHistoryPanelRows hides closed-ghost when same URL exists as stack', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/shared', title: 'Shared', lastActivatedAt: 1 })
    ]),
    workingSet: workingSetOf([]),
    closedTabs: [
      makeClosed({ sessionId: 'x', url: 'https://example.com/shared', lastClosedAt: 100 })
    ],
    filter: ''
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'stack')
})

test('buildHistoryPanelRows sorts rows by recency descending', () => {
  const rows = buildHistoryPanelRows({
    snapshot: snapshotOf([
      makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/a', lastActivatedAt: 100 }),
      makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/b', lastActivatedAt: 300 })
    ]),
    workingSet: workingSetOf([
      makeWorkingSetItem({ key: 'https://example.com/c', tabId: 3, lastActivatedAt: 200 })
    ]),
    closedTabs: [
      makeClosed({ sessionId: 'd', url: 'https://example.com/d', lastClosedAt: 400 })
    ],
    filter: ''
  })

  assert.deepEqual(
    rows.map((r) => r.lastTouchedAt),
    [400, 300, 200, 100]
  )
})

test('buildHistoryPanelRows slots stack rows with null timestamp by cursor distance', () => {
  const rows = buildHistoryPanelRows({
    snapshot: {
      stackSize: 3,
      maxSize: 24,
      cursorIndex: 2,
      currentIndex: 2,
      previousIndex: -1,
      nextIndex: -1,
      activeTabId: null,
      activeWindowId: null,
      activeWasInserted: false,
      entries: [
        makeStackEntry({ index: 0, tabId: 1, url: 'https://example.com/a' }),
        makeStackEntry({ index: 1, tabId: 2, url: 'https://example.com/b' }),
        makeStackEntry({ index: 2, tabId: 3, url: 'https://example.com/c' })
      ]
    },
    workingSet: null,
    closedTabs: [],
    filter: ''
  })

  assert.equal(rows.length, 3)
  assert.equal((rows[0] as { entry: TabHistoryEntry }).entry.tabId, 3)
  assert.equal((rows[1] as { entry: TabHistoryEntry }).entry.tabId, 2)
  assert.equal((rows[2] as { entry: TabHistoryEntry }).entry.tabId, 1)
})

test('buildHistoryPanelRows dedupes utility-URL stack entries to the one closest to current', () => {
  const rows = buildHistoryPanelRows({
    snapshot: {
      stackSize: 3,
      maxSize: 24,
      cursorIndex: 2,
      currentIndex: 2,
      previousIndex: -1,
      nextIndex: -1,
      activeTabId: null,
      activeWindowId: null,
      activeWasInserted: false,
      entries: [
        makeStackEntry({ index: 0, tabId: 1, url: 'chrome://newtab/' }),
        makeStackEntry({ index: 1, tabId: 2, url: 'chrome://newtab/' }),
        makeStackEntry({ index: 2, tabId: 3, url: 'chrome://newtab/' })
      ]
    },
    workingSet: null,
    closedTabs: [],
    filter: ''
  })

  assert.equal(rows.length, 1)
  assert.equal((rows[0] as { entry: TabHistoryEntry }).entry.tabId, 3)
})
