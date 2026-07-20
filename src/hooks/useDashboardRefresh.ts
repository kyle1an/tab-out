import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchClosedTabs, isClosedTabFetchSuppressed } from '../extension/closed-tabs.js'
import { registerDashboardRefresh } from '../extension/dashboard-controller.js'
import type { DashboardRefreshOptions } from '../extension/dashboard-controller.js'
import { fetchDashboardServiceState } from '../extension/dashboard-service-state.js'
import { buildFilterSearchRequest, dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { buildDashboardDataFromTabs, fetchDashboardData, getCurrentWindowId } from '../extension/render.js'
import { fetchTabHistorySnapshot } from '../extension/tab-history.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs } from '../extension/tabs.js'
import { buildWorkingSetSnapshot } from '../extension/working-set.js'
import { fetchWorkingSetSnapshot } from '../extension/working-set-client.js'
import { loadSavedPagesStore, type SavedPagesStore } from '../extension/saved-pages.js'
import { buildTabsDashboardStartupSnapshot, saveCachedDashboardStartupSnapshot, type DashboardStartupSnapshot } from '../extension/startup-snapshot.js'
import { buildDashboardStartupViewModel } from '../extension/startup-view-model.js'
import type { DashboardLocalState } from './useDashboardLocalState'
import type { DashboardData, DashboardSource, TabHistorySnapshot, WorkingSetSnapshot } from '../extension/types'

export { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS, DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS, loadCachedDashboardStartup, loadCachedDashboardStartupSnapshot } from '../extension/startup-snapshot.js'
export type { DashboardStartupSnapshot, CachedDashboardStartup, DashboardStartupViewModel } from '../extension/startup-snapshot.js'

export type MissionOrderMap = Record<DashboardSource, Map<string, number>>

type DashboardSnapshotOptions = {
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  localState?: DashboardLocalState | null
  savedPagesStore?: SavedPagesStore
  previousOrder: MissionOrderMap
}
type DashboardRefreshSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
}

type UseDashboardRefreshOptions = DashboardSnapshotOptions & {
  dashboard: DashboardData | null
  localStateLoaded: boolean
  localState: DashboardLocalState | null
  setDashboard: (dashboard: DashboardData | null) => void
  setStartupSnapshot: (snapshot: DashboardStartupSnapshot) => void
  setTabHistory: (tabHistory: TabHistorySnapshot | null) => void
  setWorkingSet: (workingSet: WorkingSetSnapshot | null) => void
  onBeforeAnimatedRefresh?: () => void
  onBeforePinnedRefresh?: () => void
}
type DashboardRefreshRequestOptions = DashboardRefreshOptions & {
  waitForStartup?: boolean
}

type LatestRefreshRequest<T> = {
  apply: (value: T) => void
  run: () => Promise<T>
}
type LatestRefreshRunner<T> = {
  active: () => boolean
  request: (run: () => Promise<T>, apply: (value: T) => void) => Promise<void>
  wait: () => Promise<void>
}

type DashboardRefreshContext = {
  filter: string
  historyFilterEnabled: boolean
  historyRange: string
  pinnedDomains: readonly string[]
  source: DashboardSource
}

export function createLatestRefreshRunner<T>(): LatestRefreshRunner<T> {
  let inFlight: Promise<void> | null = null
  let latestRequest: LatestRefreshRequest<T> | null = null
  let revision = 0

  function request(run: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    latestRequest = { apply, run }
    revision += 1
    if (inFlight) return inFlight

    const flight = (async () => {
      while (latestRequest) {
        const requestRevision = revision
        const currentRequest = latestRequest
        try {
          const value = await currentRequest.run()
          if (requestRevision !== revision) continue
          currentRequest.apply(value)
          if (requestRevision !== revision) continue
          latestRequest = null
          return
        } catch (error) {
          if (requestRevision !== revision) continue
          throw error
        }
      }
    })()
    inFlight = flight
    const clearFlight = () => {
      if (inFlight === flight) inFlight = null
    }
    void flight.then(clearFlight, clearFlight)
    return flight
  }

  return {
    active: () => inFlight !== null,
    request,
    wait: () => inFlight ?? Promise.resolve()
  }
}

function dashboardRefreshContextMatches(
  request: DashboardRefreshContext,
  current: DashboardRefreshContext,
  startupSnapshot: boolean
): boolean {
  const sourceAndPinsMatch = request.source === current.source &&
    request.pinnedDomains.length === current.pinnedDomains.length &&
    request.pinnedDomains.every((domain, index) => domain === current.pinnedDomains[index])
  return sourceAndPinsMatch && (
    startupSnapshot ||
    (
      request.filter === current.filter &&
      request.historyRange === current.historyRange &&
      request.historyFilterEnabled === current.historyFilterEnabled
    )
  )
}

let startupSnapshotFlight: {
  key: string
  localStateRef: { current: DashboardLocalState | null }
  promise: Promise<DashboardStartupSnapshot>
} | null = null
let startupSnapshotCacheWrite = Promise.resolve()

function queueStartupSnapshotCacheWrite(
  snapshot: DashboardStartupSnapshot,
  localState: DashboardLocalState | null
): void {
  const write = startupSnapshotCacheWrite
    .catch(() => {})
    .then(() => saveCachedDashboardStartupSnapshot(snapshot, localState, {
      buildStartupViewModel: buildDashboardStartupViewModel
    }))
  startupSnapshotCacheWrite = write
  void write.catch(() => {})
}

async function fetchBookmarksSourceItemsLazy(): Promise<DashboardData['realTabs']> {
  const { fetchBookmarksSourceItems } = await import('../extension/bookmarks.js')
  return fetchBookmarksSourceItems()
}

async function fetchHistorySourceItemsLazy(query: string, range: string): Promise<DashboardData['realTabs']> {
  const { fetchHistorySourceItems } = await import('../extension/history-source.js')
  return fetchHistorySourceItems(query, range)
}

function startupSnapshotFlightKey({ source, filter, historyRange, historyFilterEnabled, pinnedDomains }: DashboardSnapshotOptions): string {
  return JSON.stringify({
    source,
    filter,
    historyRange,
    historyFilterEnabled,
    pinnedDomains
  })
}

async function fetchTabsDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, savedPagesStore, previousOrder }: DashboardSnapshotOptions): Promise<DashboardRefreshSnapshot> {
  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [openTabs, currentWindowId, serviceState, resolvedSavedPagesStore, bookmarkTabs, historyTabs] = await Promise.all([
    fetchOpenTabsSnapshot(),
    getCurrentWindowId(),
    fetchDashboardServiceState(),
    savedPagesStore ? Promise.resolve(savedPagesStore) : loadSavedPagesStore(),
    filterSearch.includeBookmarkMatches ? fetchBookmarksSourceItemsLazy() : Promise.resolve([]),
    filterSearch.includeHistoryMatches ? fetchHistorySourceItemsLazy(filterSearch.query, filterSearch.historyRange) : Promise.resolve([])
  ])
  const dashboardTabs = getDashboardTabsFromOpenTabs(openTabs)
  const dashboard = await buildDashboardDataFromTabs(dashboardTabs, currentWindowId, previousOrder[source] || new Map(), {
    pinnedDomains,
    bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
    historyPreviousOrder: previousOrder.history || new Map(),
    includeBookmarkMatches: filterSearch.includeBookmarkMatches,
    includeHistoryMatches: filterSearch.includeHistoryMatches,
    searchQuery: filterSearch.query,
    historyRange: filterSearch.historyRange,
    bookmarkTabs,
    historyTabs,
    savedPagesStore: resolvedSavedPagesStore
  })
  const workingSet = buildWorkingSetSnapshot({
    tabs: dashboardTabs,
    activity: serviceState.workingSetActivity,
    currentWindowId
  })

  return { dashboard, tabHistory: serviceState.tabHistory, workingSet }
}

export async function fetchDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder }: DashboardSnapshotOptions): Promise<DashboardRefreshSnapshot> {
  if (source === 'tabs') {
    return fetchTabsDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder })
  }

  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [dashboard, tabHistory, workingSet] = await Promise.all([
    (async () => fetchDashboardData(previousOrder[source] || new Map(), source, {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange,
      bookmarkTabs: source === 'bookmarks' ? await fetchBookmarksSourceItemsLazy() : []
    }))(),
    fetchTabHistorySnapshot(),
    fetchWorkingSetSnapshot()
  ])

  return { dashboard, tabHistory, workingSet }
}

async function fetchDashboardStartupSnapshotOnce(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const closedTabsPromise = isClosedTabFetchSuppressed() ? Promise.resolve([]) : fetchClosedTabs()
  const [openTabs, currentWindowId, serviceState, savedPagesStore, closedTabs] = await Promise.all([
    fetchOpenTabsSnapshot(),
    getCurrentWindowId(),
    fetchDashboardServiceState(),
    options.savedPagesStore ? Promise.resolve(options.savedPagesStore) : loadSavedPagesStore(),
    closedTabsPromise
  ])
  return buildTabsDashboardStartupSnapshot({
    dashboardTabs: getDashboardTabsFromOpenTabs(openTabs),
    currentWindowId,
    tabHistory: serviceState.tabHistory,
    workingSetActivity: serviceState.workingSetActivity,
    savedPagesStore,
    closedTabs,
    pinnedDomains: options.pinnedDomains,
    tabPreviousOrder: options.previousOrder.tabs || new Map()
  })
}

export async function fetchDashboardStartupSnapshot(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const key = startupSnapshotFlightKey(options)
  if (startupSnapshotFlight?.key === key) {
    startupSnapshotFlight.localStateRef.current = options.localState ?? null
    return startupSnapshotFlight.promise
  }

  const localStateRef = { current: options.localState ?? null }
  const promise = (async () => {
    try {
      const snapshot = await fetchDashboardStartupSnapshotOnce(options)
      queueStartupSnapshotCacheWrite(snapshot, localStateRef.current)
      return snapshot
    } finally {
      if (startupSnapshotFlight?.localStateRef === localStateRef) startupSnapshotFlight = null
    }
  })()
  const flight = {
    key,
    localStateRef,
    promise
  }
  startupSnapshotFlight = flight
  return flight.promise
}

export function useDashboardRefresh({
  dashboard,
  source,
  filter,
  historyRange,
  historyFilterEnabled,
  pinnedDomains,
  localStateLoaded,
  localState,
  previousOrder,
  setDashboard,
  setStartupSnapshot,
  setTabHistory,
  setWorkingSet,
  onBeforeAnimatedRefresh,
  onBeforePinnedRefresh
}: UseDashboardRefreshOptions) {
  const callbacksRef = useRef({ onBeforeAnimatedRefresh, onBeforePinnedRefresh })
  const refreshRef = useRef<(options?: DashboardRefreshRequestOptions) => Promise<void>>(async () => {})
  type DashboardRefreshResult =
    | { kind: 'startup'; snapshot: DashboardStartupSnapshot }
    | { kind: 'standard'; snapshot: DashboardRefreshSnapshot }
  const [refreshRunner] = useState(() => createLatestRefreshRunner<DashboardRefreshResult>())
  const refreshContextRef = useRef<DashboardRefreshContext>({
    filter,
    historyFilterEnabled,
    historyRange,
    pinnedDomains,
    source
  })
  const startupRefreshPendingRef = useRef(false)
  const animatedRefreshPendingRef = useRef(false)

  useEffect(() => {
    callbacksRef.current = { onBeforeAnimatedRefresh, onBeforePinnedRefresh }
  }, [onBeforeAnimatedRefresh, onBeforePinnedRefresh])

  useLayoutEffect(() => {
    refreshContextRef.current = {
      filter,
      historyFilterEnabled,
      historyRange,
      pinnedDomains,
      source
    }
  }, [filter, historyFilterEnabled, historyRange, pinnedDomains, source])

  refreshRef.current = async ({
    animateCards = false,
    startupSnapshot = false,
    waitForStartup = false
  }: DashboardRefreshRequestOptions = {}) => {
    if (waitForStartup && startupRefreshPendingRef.current && refreshRunner.active()) {
      try {
        await refreshRunner.wait()
      } catch {}
      return refreshRef.current()
    }
    if (startupSnapshot) startupRefreshPendingRef.current = true
    if (animateCards) animatedRefreshPendingRef.current = true
    if (document.visibilityState !== 'visible') return
    if (!localStateLoaded) return
    const useStartupSnapshot = source === 'tabs' && (!dashboard || startupRefreshPendingRef.current)
    const requestContext: DashboardRefreshContext = {
      filter,
      historyFilterEnabled,
      historyRange,
      pinnedDomains: [...pinnedDomains],
      source
    }
    try {
      await refreshRunner.request(
        async () => {
          if (animatedRefreshPendingRef.current) {
            callbacksRef.current.onBeforeAnimatedRefresh?.()
          }
          if (useStartupSnapshot) {
            return {
              kind: 'startup' as const,
              snapshot: await fetchDashboardStartupSnapshot({
                source,
                filter,
                historyRange,
                historyFilterEnabled,
                pinnedDomains,
                localState,
                previousOrder
              })
            }
          }
          return {
            kind: 'standard' as const,
            snapshot: await fetchDashboardSnapshot({
              source,
              filter,
              historyRange,
              historyFilterEnabled,
              pinnedDomains,
              previousOrder
            })
          }
        },
        (result) => {
          startupRefreshPendingRef.current = false
          animatedRefreshPendingRef.current = false
          if (
            !refreshContextRef.current ||
            !dashboardRefreshContextMatches(
              requestContext,
              refreshContextRef.current,
              result.kind === 'startup'
            )
          ) return
          if (result.kind === 'startup') {
            setStartupSnapshot(result.snapshot)
            return
          }
          setDashboard(result.snapshot.dashboard)
          setTabHistory(result.snapshot.tabHistory)
          setWorkingSet(result.snapshot.workingSet)
        }
      )
    } catch (error) {
      startupRefreshPendingRef.current = false
      animatedRefreshPendingRef.current = false
      throw error
    }
  }

  useEffect(() => registerDashboardRefresh((options?: DashboardRefreshOptions) => refreshRef.current(options)), [])

  useEffect(() => {
    if (!localStateLoaded || !dashboardNeedsFilterSearchRefresh(dashboard, { source, filter, historyRange, historyFilterEnabled })) return
    const frame = requestAnimationFrame(() => refreshRef.current({ waitForStartup: true }))
    return () => cancelAnimationFrame(frame)
  }, [dashboard, filter, historyRange, historyFilterEnabled, localStateLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (!localStateLoaded) return
    callbacksRef.current.onBeforePinnedRefresh?.()
    requestAnimationFrame(() => refreshRef.current())
  }, [pinnedDomains, localStateLoaded])

  // Stable identity: the hook itself bails out of React Compiler (the render-time
  // refreshRef assignment is its latest-callback architecture), so the returned
  // facade is memoized manually — consumers key effects and props on it.
  return useCallback((options?: DashboardRefreshOptions) => refreshRef.current(options), [])
}
