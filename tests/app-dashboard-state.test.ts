import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'

import {
  appDashboardReducer,
  createAppDashboardStore,
  initialAppDashboardState,
} from '../src/extension/dashboard-intake.js'
import type { DashboardRefreshSnapshot, DashboardSnapshotOptions } from '../src/extension/dashboard-intake.js'
import type { BrowserReadResult } from '../src/extension/browser-tabs-gateway.js'
import type { ClosedTabEntry } from '../src/extension/closed-tabs.js'
import type { DashboardStartupSnapshot } from '../src/extension/startup-snapshot.js'
import type { TabHistorySnapshot } from '../src/extension/types'

function deferred<T>() {
  return Promise.withResolvers<T>()
}

async function flushAsyncWork(): Promise<void> {
  await setImmediate()
}

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
    entries: [],
  }
}

function startupSnapshot(tabHistory: TabHistorySnapshot): DashboardStartupSnapshot {
  return {
    dashboard: { realTabs: [], domainGroups: [] },
    tabHistory,
    workingSet: { defaultLimit: 5, expandedLimit: 12, items: [] },
    closedTabs: [],
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

  assert.equal(store.read().historySearchPending, false)
  store.dispatch({ type: 'historySearchPending', historySearchPending: true })
  assert.equal(notifications, 2, 'history search pending is arrival status in the snapshot')
  assert.equal(store.read().historySearchPending, true)
  store.dispatch({ type: 'historySearchPending', historySearchPending: true })
  assert.equal(notifications, 2, 'an unchanged pending flag must not notify')

  unsubscribe()
  store.dispatch({ type: 'source', source: 'history' })
  assert.equal(notifications, 2, 'unsubscribed listeners stop receiving arrivals')
  assert.equal(store.read().source, 'history')
})

test('a source choice made in the shell is admitted with the matching startup frame', () => {
  const store = createAppDashboardStore({
    fetchDashboardSnapshot: () => assert.fail('source choice must join startup capture'),
  })
  const snapshot = startupSnapshot(historySnapshot(10))
  snapshot.dashboard = {
    realTabs: [],
    domainGroups: [{ domain: 'bookmarks.example', tabs: [] }],
  }

  store.selectStartupSource('bookmarks')
  assert.equal(store.read().source, 'tabs')
  assert.equal(store.read().sourceSelection, 'bookmarks')

  store.applyStartup({
    historyRange: '24h',
    snapshot,
    source: 'bookmarks',
  })

  assert.equal(store.read().source, 'bookmarks')
  assert.equal(store.read().sourceSelection, 'bookmarks')
  assert.equal(store.read().dashboard, snapshot.dashboard)
  assert.equal(store.read().startupStateApplied, true)
  assert.equal(store.read().startupPriorityWorkingSet, null)
})

test('a live history update supersedes the deferred startup target before source cancellation', () => {
  const cachedHistory = historySnapshot(10)
  const liveHistory = historySnapshot(20)
  let state = initialAppDashboardState({ historyRange: '24h', snapshot: null })

  state = appDashboardReducer(state, {
    type: 'sourceRequest',
    requestId: 1,
    source: 'bookmarks',
  })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: startupSnapshot(cachedHistory),
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
    source: 'bookmarks',
  })
  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })

  assert.equal(state.tabHistory, null, 'one live supplemental surface must not flash before startup')

  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: startupSnapshot(cachedHistory),
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
  assert.deepEqual(state.deferredStartupSourceFields, { tabHistory: liveHistory })

  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot,
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
      source: 'bookmarks',
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
      snapshot: cachedSnapshot,
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
    source: 'bookmarks',
  })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot,
  })
  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })
  state = appDashboardReducer(state, {
    type: 'sourceSnapshot',
    dashboard: bookmarkDashboard,
    requestId: 1,
    source: 'bookmarks',
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
    source: 'bookmarks',
  })
  state = appDashboardReducer(state, {
    type: 'sourceSnapshot',
    dashboard: bookmarkDashboard,
    requestId: 1,
    source: 'bookmarks',
  })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot,
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
    source: 'bookmarks',
  })
  state = appDashboardReducer(state, {
    type: 'sourceSnapshot',
    dashboard: { realTabs: [], domainGroups: [] },
    requestId: 1,
    source: 'bookmarks',
  })
  state = appDashboardReducer(state, { type: 'tabHistory', tabHistory: liveHistory })
  state = appDashboardReducer(state, {
    type: 'startup',
    historyRange: '24h',
    snapshot: cachedSnapshot,
  })

  assert.equal(state.tabHistory, liveHistory)
})

test('startup intake defers its Tabs ordering priority until a pending source switch is cancelled', () => {
  const sourceFlight = deferred<DashboardRefreshSnapshot>()
  const cachedSnapshot = startupSnapshot(historySnapshot(10))
  const store = createAppDashboardStore({
    fetchDashboardSnapshot: () => sourceFlight.promise,
    showToast: () => assert.fail('a cancelled source switch must not show a failure toast'),
  })
  store.setRefreshInputs({
    filter: '',
    localStateLoaded: true,
    pinnedDomains: [],
    previousOrder: { tabs: new Map(), bookmarks: new Map(), history: new Map() },
  })

  store.switchSource('bookmarks')
  store.applyStartup({ historyRange: '7d', snapshot: cachedSnapshot })

  assert.equal(store.read().historyRange, '7d')
  assert.equal(store.read().dashboard, null, 'the pending source keeps the startup projection atomic')
  assert.equal(store.read().startupPriorityWorkingSet, null)

  store.switchSource('tabs')

  assert.equal(store.read().dashboard, cachedSnapshot.dashboard)
  assert.equal(store.read().startupPriorityWorkingSet, cachedSnapshot.workingSet)

  store.clearStartupPriority()
  assert.equal(store.read().startupPriorityWorkingSet, null)
})

test('only the latest source switch announces and applies its arriving snapshot', async () => {
  const requests: DashboardSnapshotOptions[] = []
  const flights: ReturnType<typeof deferred<DashboardRefreshSnapshot>>[] = []
  const store = createAppDashboardStore({
    fetchDashboardSnapshot: (options) => {
      requests.push(options)
      const flight = deferred<DashboardRefreshSnapshot>()
      flights.push(flight)
      return flight.promise
    },
    showToast: () => assert.fail('a successful source switch must not show a failure toast'),
  })
  store.setRefreshInputs({
    filter: '',
    localStateLoaded: true,
    pinnedDomains: [],
    previousOrder: { tabs: new Map(), bookmarks: new Map(), history: new Map() },
  })
  const beforeApplyEvents: unknown[] = []
  store.subscribeBeforeApply((event) => beforeApplyEvents.push(event))

  const bookmarkRequestId = store.switchSource('bookmarks')
  const historyRequestId = store.switchSource('history')

  assert.equal(bookmarkRequestId, 1)
  assert.equal(historyRequestId, 2)
  assert.equal(store.read().sourceSelection, 'history')
  assert.deepEqual(requests.map(({ source }) => source), ['bookmarks', 'history'])

  flights[0]!.resolve({ dashboard: { realTabs: [], domainGroups: [] } })
  await flushAsyncWork()

  assert.equal(store.read().source, 'tabs', 'a stale source snapshot must not apply')
  assert.deepEqual(beforeApplyEvents, [], 'a stale source snapshot must not hand off card geometry')

  const historyDashboard = { realTabs: [], domainGroups: [] }
  flights[1]!.resolve({ dashboard: historyDashboard })
  await flushAsyncWork()

  assert.equal(store.read().source, 'history')
  assert.equal(store.read().dashboard, historyDashboard)
  assert.deepEqual(beforeApplyEvents, [{ reason: 'source-switch', requestId: 2 }])
})

test('a source switch retries with the latest intake context before applying', async () => {
  const requests: DashboardSnapshotOptions[] = []
  const flights: ReturnType<typeof deferred<DashboardRefreshSnapshot>>[] = []
  const store = createAppDashboardStore({
    fetchDashboardSnapshot: (options) => {
      requests.push(options)
      const flight = deferred<DashboardRefreshSnapshot>()
      flights.push(flight)
      return flight.promise
    },
    showToast: () => assert.fail('a retried source switch must not show a failure toast'),
  })
  const previousOrder = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
  store.setRefreshInputs({ filter: 'first', localStateLoaded: true, pinnedDomains: [], previousOrder })

  store.switchSource('bookmarks')
  store.setRefreshInputs({ filter: 'latest', localStateLoaded: true, pinnedDomains: [], previousOrder })
  flights[0]!.resolve({ dashboard: { realTabs: [], domainGroups: [] } })
  await flushAsyncWork()

  assert.deepEqual(requests.map(({ filter }) => filter), ['first', 'latest'])
  assert.equal(store.read().source, 'tabs', 'the stale-context snapshot must remain hidden')

  const latestDashboard = { realTabs: [], domainGroups: [] }
  flights[1]!.resolve({ dashboard: latestDashboard })
  await flushAsyncWork()

  assert.equal(store.read().source, 'bookmarks')
  assert.equal(store.read().dashboard, latestDashboard)
})

test('a failed source switch restores the active source and reports the failure', async () => {
  const toasts: string[] = []
  const store = createAppDashboardStore({
    fetchDashboardSnapshot: () => Promise.reject(new Error('source unavailable')),
    showToast: (message) => toasts.push(message),
  })
  store.setRefreshInputs({
    filter: '',
    localStateLoaded: true,
    pinnedDomains: [],
    previousOrder: { tabs: new Map(), bookmarks: new Map(), history: new Map() },
  })

  assert.equal(store.switchSource('bookmarks'), 1)
  assert.equal(store.read().sourceSelection, 'bookmarks')

  await flushAsyncWork()

  assert.equal(store.read().source, 'tabs')
  assert.equal(store.read().sourceSelection, 'tabs')
  assert.deepEqual(toasts, ['Could not switch source'])
})

test('closed-tab intake waits for restore settlement and ignores an overtaken read', async () => {
  let suppressionRemainingMs = Number.POSITIVE_INFINITY
  let closedTabChangeHandler: ((settleDelayMs: number) => void) | null = null
  let unsubscribed = false
  const timers: Array<{ callback: () => void, delayMs: number }> = []
  const flights: ReturnType<typeof deferred<BrowserReadResult<ClosedTabEntry[]>>>[] = []
  const store = createAppDashboardStore({
    closedTabFetchSuppressionRemainingMs: () => suppressionRemainingMs,
    fetchClosedTabsResult: () => {
      const flight = deferred<BrowserReadResult<ClosedTabEntry[]>>()
      flights.push(flight)
      return flight.promise
    },
    scheduleTimeout: (callback, delayMs) => {
      timers.push({ callback, delayMs })
      return timers.length as never
    },
    subscribeClosedTabChanges: (handler) => {
      closedTabChangeHandler = handler
      return () => { unsubscribed = true }
    },
  })
  store.dispatch({
    type: 'startup',
    historyRange: '24h',
    snapshot: startupSnapshot(historySnapshot(1)),
  })

  const stopClosedTabUpdates = store.startClosedTabUpdates()
  assert.equal(flights.length, 0, 'subscribing must not race the atomic startup snapshot')

  closedTabChangeHandler!(0)
  assert.equal(timers.length, 0, 'an unresolved restore has no safe retry deadline')
  assert.equal(flights.length, 0)

  suppressionRemainingMs = 25
  closedTabChangeHandler!(10)
  assert.equal(timers[0]?.delayMs, 25)
  suppressionRemainingMs = 0
  timers[0]!.callback()
  assert.equal(flights.length, 1)

  closedTabChangeHandler!(0)
  assert.equal(flights.length, 2)

  const staleClosedTab = closedTabEntry('stale')
  flights[0]!.resolve({ ok: true, value: [staleClosedTab] })
  await flushAsyncWork()
  assert.deepEqual(store.read().closedTabs, [], 'an overtaken recently-closed read must stay hidden')

  const latestClosedTab = closedTabEntry('latest')
  flights[1]!.resolve({ ok: true, value: [latestClosedTab] })
  await flushAsyncWork()
  assert.deepEqual(store.read().closedTabs, [latestClosedTab])

  stopClosedTabUpdates()
  assert.equal(unsubscribed, true)
})

test('stopping closed-tab intake cancels its pending refresh timer', () => {
  let closedTabChangeHandler: ((settleDelayMs: number) => void) | null = null
  let unsubscribed = false
  const timerId = 17 as never
  const cancelledTimers: Array<ReturnType<typeof setTimeout>> = []
  const store = createAppDashboardStore({
    cancelTimeout: (timer) => cancelledTimers.push(timer),
    closedTabFetchSuppressionRemainingMs: () => 25,
    fetchClosedTabsResult: () => assert.fail('a suppressed refresh must not read recently closed tabs'),
    scheduleTimeout: () => timerId,
    subscribeClosedTabChanges: (handler) => {
      closedTabChangeHandler = handler
      return () => { unsubscribed = true }
    },
  })

  const stopClosedTabUpdates = store.startClosedTabUpdates()
  closedTabChangeHandler!(0)
  stopClosedTabUpdates()

  assert.deepEqual(cancelledTimers, [timerId])
  assert.equal(unsubscribed, true)
})

test('stopping closed-tab intake prevents an in-flight result from applying', async () => {
  let closedTabChangeHandler: ((settleDelayMs: number) => void) | null = null
  const flight = deferred<BrowserReadResult<ClosedTabEntry[]>>()
  const store = createAppDashboardStore({
    closedTabFetchSuppressionRemainingMs: () => 0,
    fetchClosedTabsResult: () => flight.promise,
    subscribeClosedTabChanges: (handler) => {
      closedTabChangeHandler = handler
      return () => {}
    },
  })
  store.dispatch({
    type: 'startup',
    historyRange: '24h',
    snapshot: startupSnapshot(historySnapshot(1)),
  })

  const stopClosedTabUpdates = store.startClosedTabUpdates()
  closedTabChangeHandler!(0)
  stopClosedTabUpdates()
  flight.resolve({ ok: true, value: [closedTabEntry('late')] })
  await flushAsyncWork()

  assert.deepEqual(store.read().closedTabs, [])
})

test('closed-tab intake recovers after a rejected read', async () => {
  let closedTabChangeHandler: ((settleDelayMs: number) => void) | null = null
  const flights: ReturnType<typeof deferred<BrowserReadResult<ClosedTabEntry[]>>>[] = []
  const store = createAppDashboardStore({
    closedTabFetchSuppressionRemainingMs: () => 0,
    fetchClosedTabsResult: () => {
      const flight = deferred<BrowserReadResult<ClosedTabEntry[]>>()
      flights.push(flight)
      return flight.promise
    },
    subscribeClosedTabChanges: (handler) => {
      closedTabChangeHandler = handler
      return () => {}
    },
  })
  store.dispatch({
    type: 'startup',
    historyRange: '24h',
    snapshot: startupSnapshot(historySnapshot(1)),
  })

  const stopClosedTabUpdates = store.startClosedTabUpdates()
  closedTabChangeHandler!(0)
  flights[0]!.reject(new Error('sessions unavailable'))
  await flushAsyncWork()

  closedTabChangeHandler!(0)
  const recoveredClosedTab = closedTabEntry('recovered')
  flights[1]!.resolve({ ok: true, value: [recoveredClosedTab] })
  await flushAsyncWork()

  assert.deepEqual(store.read().closedTabs, [recoveredClosedTab])
  stopClosedTabUpdates()
})

function closedTabEntry(id: string): ClosedTabEntry {
  return {
    sessionId: `session-${id}`,
    tabId: 1,
    url: `https://${id}.example.test/`,
    rawUrl: `https://${id}.example.test/`,
    displayUrl: `${id}.example.test`,
    title: id,
    favIconUrl: '',
    lastClosedAt: 1,
  }
}
