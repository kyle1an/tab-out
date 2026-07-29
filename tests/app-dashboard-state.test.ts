import assert from 'node:assert/strict'
import test from 'node:test'

import {
  appDashboardReducer,
  createAppDashboardStore,
  initialAppDashboardState
} from '../src/extension/dashboard-intake.js'
import type { DashboardStartupSnapshot } from '../src/hooks/useDashboardRefresh.js'
import type { TabHistorySnapshot } from '../src/extension/types'

function historySnapshot(activeTabId: number): TabHistorySnapshot {
  return {
    stackSize: 0,
    maxSize: 48,
    cursorIndex: -1,
    currentIndex: -1,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId,
    activeWindowId: 1,
    activeWasInserted: false,
    entries: []
  }
}

function startupSnapshot(tabHistory: TabHistorySnapshot): DashboardStartupSnapshot {
  return {
    dashboard: { realTabs: [], domainGroups: [] },
    tabHistory,
    workingSet: { defaultLimit: 5, expandedLimit: 12, items: [] },
    closedTabs: []
  }
}

test('app dashboard store applies arrivals through the reducer and notifies only on change', () => {
  const store = createAppDashboardStore()

  assert.equal(store.read(), store.readBuildTime(), 'reads return the build-time state before any arrival')
  assert.equal(store.read().dashboard, null)
  assert.equal(store.read().startupStateApplied, false)

  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })

  store.dispatch({ type: 'source', source: 'tabs' })
  assert.equal(notifications, 0, 'a no-op arrival must not notify')
  assert.equal(store.read(), store.readBuildTime(), 'a no-op arrival must keep snapshot identity')

  store.dispatch({ type: 'source', source: 'bookmarks' })
  assert.equal(notifications, 1)
  assert.equal(store.read().source, 'bookmarks')

  unsubscribe()
  store.dispatch({ type: 'source', source: 'history' })
  assert.equal(notifications, 1, 'unsubscribed listeners stop receiving arrivals')
  assert.equal(store.read().source, 'history')
})

test('a live history update supersedes the deferred startup target before source cancellation', () => {
  const cachedHistory = historySnapshot(10)
  const liveHistory = historySnapshot(20)
  let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

  state = appDashboardReducer(state, {
    type: 'sourceRequest',
    requestId: 1,
    source: 'bookmarks'
  })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: startupSnapshot(cachedHistory)
  })
  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })

  assert.equal(state.tabHistory, null, 'the pending source must not reveal one startup surface alone')

  state = appDashboardReducer(state, { type: 'sourceRequestCancelled' })

  assert.equal(state.tabHistory, liveHistory, 'cancellation must restore the fresher hydrated target')
})

test('a live history update before startup resolution stays hidden during the pending source switch', () => {
  const cachedHistory = historySnapshot(10)
  const liveHistory = historySnapshot(20)
  let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

  state = appDashboardReducer(state, {
    type: 'sourceRequest',
    requestId: 1,
    source: 'bookmarks'
  })
  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })

  assert.equal(state.tabHistory, null, 'one live supplemental surface must not flash before startup')

  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: startupSnapshot(cachedHistory)
  })
  state = appDashboardReducer(state, { type: 'sourceRequestCancelled' })

  assert.equal(state.tabHistory, liveHistory)
})

test('a live history update without a source request waits for the atomic startup projection', () => {
  const cachedSnapshot = startupSnapshot(historySnapshot(10))
  const liveHistory = historySnapshot(20)
  let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })

  assert.equal(state.tabHistory, null)

  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot
  })

  assert.equal(state.dashboard, cachedSnapshot.dashboard)
  assert.equal(state.tabHistory, liveHistory)
  assert.equal(state.workingSet, cachedSnapshot.workingSet)
  assert.equal(state.closedTabs, cachedSnapshot.closedTabs)
})

for (const settlement of ['sourceRequestCancelled', 'sourceRequestFailed'] as const) {
  test(`${settlement} before startup keeps a live field held for the atomic projection`, () => {
    const cachedSnapshot = startupSnapshot(historySnapshot(10))
    const liveHistory = historySnapshot(20)
    let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

    state = appDashboardReducer(state, {
      type: 'sourceRequest',
      requestId: 1,
      source: 'bookmarks'
    })
    state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })
    state = appDashboardReducer(state, settlement === 'sourceRequestFailed'
      ? { type: settlement, requestId: 1 }
      : { type: settlement })

    assert.equal(state.sourceSelection, 'tabs')
    assert.equal(state.tabHistory, null)
    assert.equal(state.deferredStartupSourceFields?.tabHistory, liveHistory)

    state = appDashboardReducer(state, {
      type: 'startup',
      historyRange: '24h',
      snapshot: cachedSnapshot
    })

    assert.equal(state.tabHistory, liveHistory)
  })
}

test('a successful non-Tabs source keeps deferred supplemental startup fields', () => {
  const cachedHistory = historySnapshot(10)
  const cachedSnapshot = startupSnapshot(cachedHistory)
  const liveHistory = historySnapshot(20)
  const bookmarkDashboard = { realTabs: [], domainGroups: [] }
  let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

  state = appDashboardReducer(state, {
    type: 'sourceRequest',
    requestId: 1,
    source: 'bookmarks'
  })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot
  })
  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })
  state = appDashboardReducer(state, {
    type: 'sourceSnapshot',
    dashboard: bookmarkDashboard,
    requestId: 1,
    source: 'bookmarks'
  })

  assert.equal(state.source, 'bookmarks')
  assert.equal(state.dashboard, bookmarkDashboard)
  assert.equal(state.tabHistory, liveHistory)
  assert.equal(state.workingSet, cachedSnapshot.workingSet)
  assert.equal(state.closedTabs, cachedSnapshot.closedTabs)
  assert.equal(state.deferredStartupSourceFields, null)
})

test('late startup supplements an already successful non-Tabs source without replacing it', () => {
  const cachedSnapshot = startupSnapshot(historySnapshot(10))
  const bookmarkDashboard = { realTabs: [], domainGroups: [] }
  let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

  state = appDashboardReducer(state, {
    type: 'sourceRequest',
    requestId: 1,
    source: 'bookmarks'
  })
  state = appDashboardReducer(state, {
    type: 'sourceSnapshot',
    dashboard: bookmarkDashboard,
    requestId: 1,
    source: 'bookmarks'
  })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot
  })

  assert.equal(state.source, 'bookmarks')
  assert.equal(state.dashboard, bookmarkDashboard)
  assert.equal(state.tabHistory, cachedSnapshot.tabHistory)
  assert.equal(state.workingSet, cachedSnapshot.workingSet)
  assert.equal(state.closedTabs, cachedSnapshot.closedTabs)
})

test('a live supplemental update still wins when startup resolves after source success', () => {
  const cachedSnapshot = startupSnapshot(historySnapshot(10))
  const liveHistory = historySnapshot(20)
  let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

  state = appDashboardReducer(state, {
    type: 'sourceRequest',
    requestId: 1,
    source: 'bookmarks'
  })
  state = appDashboardReducer(state, {
    type: 'sourceSnapshot',
    dashboard: { realTabs: [], domainGroups: [] },
    requestId: 1,
    source: 'bookmarks'
  })
  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot
  })

  assert.equal(state.tabHistory, liveHistory)
})
