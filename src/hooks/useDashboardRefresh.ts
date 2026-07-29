import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fetchClosedTabsResult, isClosedTabFetchSuppressed } from '../extension/closed-tabs.js'
import type { BrowserReadResult } from '../extension/browser-tabs-gateway.js'
import { registerDashboardRefresh, settleDashboardRefresh } from '../extension/dashboard-controller.js'
import type { DashboardRefreshOptions } from '../extension/dashboard-controller.js'
import { fetchDashboardServiceStateResult } from '../extension/dashboard-service-state.js'
import { buildFilterSearchRequest, dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { buildDashboardDataFromTabs, fetchDashboardData, getCurrentWindowIdResult } from '../extension/render.js'
import { fetchOpenTabsSnapshotResult, getDashboardTabsFromOpenTabs } from '../extension/tabs.js'
import { buildWorkingSetSnapshot } from '../extension/working-set.js'
import { loadSavedPagesStoreResult, persistSavedPageMetadataUpdates, type SavedPagesStore } from '../extension/saved-pages.js'
import { buildTabsDashboardStartupSnapshot, type DashboardStartupSnapshot } from '../extension/startup-snapshot.js'
import type { DashboardData, DashboardSource, TabHistorySnapshot, WorkingSetSnapshot } from '../extension/types'
import type { HistorySourceSearchResult } from '../extension/history-source.js'

export { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS, DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS, loadCachedDashboardStartup, loadCachedDashboardStartupSnapshot } from '../extension/startup-snapshot.js'
export type { DashboardStartupSnapshot, CachedDashboardStartup, DashboardStartupViewModel } from '../extension/startup-snapshot.js'

export type MissionOrderMap = Record<DashboardSource, Map<string, number>>

type DashboardSnapshotOptions = {
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  savedPagesStore?: SavedPagesStore
  previousOrder: MissionOrderMap
}
type DashboardRefreshSnapshot = {
  dashboard: DashboardData
  tabHistory?: TabHistorySnapshot
  workingSet?: WorkingSetSnapshot
}

type UseDashboardRefreshOptions = DashboardSnapshotOptions & {
  dashboard: DashboardData | null
  localStateLoaded: boolean
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

export function retainHistorySearchResultsOnError(
  nextDashboard: DashboardData,
  previousDashboard: DashboardData | null
): DashboardData {
  if (
    nextDashboard.historySearchStatus !== 'error' ||
    !previousDashboard ||
    previousDashboard.historySearchQuery !== nextDashboard.historySearchQuery
  ) return nextDashboard

  return {
    ...nextDashboard,
    historyTabs: previousDashboard.historyTabs ?? [],
    historyDomainGroups: previousDashboard.historyDomainGroups ?? []
  }
}

let startupSnapshotFlight: {
  id: object
  key: string
  promise: Promise<DashboardStartupSnapshot>
} | null = null

async function fetchBookmarksSourceItemsLazy(): Promise<BrowserReadResult<DashboardData['realTabs']>> {
  const { fetchBookmarksSourceItemsResult } = await import('../extension/bookmarks.js')
  return fetchBookmarksSourceItemsResult()
}

async function fetchHistorySourceItemsLazy(query: string, range: string): Promise<HistorySourceSearchResult> {
  const { fetchHistorySourceSearch } = await import('../extension/history-source.js')
  return fetchHistorySourceSearch(query, range)
}

function startupSnapshotFlightKey({ pinnedDomains, previousOrder, savedPagesStore }: DashboardSnapshotOptions): string {
  return JSON.stringify({
    pinnedDomains,
    savedPagesStore: savedPagesStore ?? null,
    tabPreviousOrder: Array.from(previousOrder.tabs || []).sort(([left], [right]) => left.localeCompare(right))
  })
}

async function fetchTabsDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, savedPagesStore, previousOrder }: DashboardSnapshotOptions): Promise<DashboardRefreshSnapshot> {
  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [currentWindowResult, serviceStateResult, savedPagesResult, bookmarkTabsResult, historySearch] = await Promise.all([
    getCurrentWindowIdResult(),
    fetchDashboardServiceStateResult(),
    savedPagesStore
      ? Promise.resolve({ ok: true as const, value: savedPagesStore })
      : loadSavedPagesStoreResult(),
    filterSearch.includeBookmarkMatches
      ? fetchBookmarksSourceItemsLazy()
      : Promise.resolve({ ok: true as const, value: [] }),
    filterSearch.includeHistoryMatches
      ? fetchHistorySourceItemsLazy(filterSearch.query, filterSearch.historyRange)
      : Promise.resolve({ status: 'ready' as const, tabs: [] })
  ])
  if (!serviceStateResult.ok) throw new Error('Could not read dashboard service state')
  if (!currentWindowResult.ok) throw new Error('Could not read current browser window')
  if (!savedPagesResult.ok) throw new Error('Could not read Saved Pages')
  if (!bookmarkTabsResult.ok) throw new Error('Could not read bookmarks')
  const serviceState = serviceStateResult.value
  const currentWindowId = currentWindowResult.value
  const openTabsResult = await fetchOpenTabsSnapshotResult(serviceState.openTabsSnapshot)
  if (!openTabsResult.ok) throw new Error('Could not read open tabs')
  const openTabs = openTabsResult.tabs
  const resolvedSavedPagesStore = savedPagesResult.value
  const dashboardTabs = getDashboardTabsFromOpenTabs(openTabs)
  const { dashboard, savedPageUpdates } = await buildDashboardDataFromTabs(dashboardTabs, currentWindowId, previousOrder[source] || new Map(), {
    pinnedDomains,
    bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
    historyPreviousOrder: previousOrder.history || new Map(),
    includeBookmarkMatches: filterSearch.includeBookmarkMatches,
    includeHistoryMatches: filterSearch.includeHistoryMatches,
    searchQuery: filterSearch.query,
    historyRange: filterSearch.historyRange,
    historySearchStatus: historySearch.status,
    bookmarkTabs: bookmarkTabsResult.value,
    historyTabs: historySearch.tabs,
    savedPagesStore: resolvedSavedPagesStore
  })
  // Page fetchers are the Saved Pages metadata writers; the build stays pure.
  void persistSavedPageMetadataUpdates(savedPageUpdates.base, savedPageUpdates.merged).catch(() => {})
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
  const [bookmarkTabsResult, savedPagesResult] = await Promise.all([
    source === 'bookmarks'
      ? fetchBookmarksSourceItemsLazy()
      : Promise.resolve({ ok: true as const, value: [] }),
    loadSavedPagesStoreResult()
  ])
  if (!savedPagesResult.ok) throw new Error('Could not read Saved Pages')
  if (!bookmarkTabsResult.ok) throw new Error('Could not read bookmarks')
  const dashboard = await fetchDashboardData(previousOrder[source] || new Map(), source, {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange,
      bookmarkTabs: bookmarkTabsResult.value,
      savedPagesStore: savedPagesResult.value
    })

  return { dashboard }
}

async function fetchDashboardStartupSnapshotOnce(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  if (isClosedTabFetchSuppressed()) throw new Error('Recently closed is settling after restore')
  const [currentWindowResult, serviceStateResult, savedPagesResult, closedTabsResult] = await Promise.all([
    getCurrentWindowIdResult(),
    fetchDashboardServiceStateResult(),
    options.savedPagesStore
      ? Promise.resolve({ ok: true as const, value: options.savedPagesStore })
      : loadSavedPagesStoreResult(),
    fetchClosedTabsResult()
  ])
  if (!serviceStateResult.ok) throw new Error('Could not read dashboard service state')
  if (!currentWindowResult.ok) throw new Error('Could not read current browser window')
  if (!savedPagesResult.ok) throw new Error('Could not read Saved Pages')
  if (!closedTabsResult.ok) throw new Error('Could not read recently closed tabs')
  const openTabsResult = await fetchOpenTabsSnapshotResult(serviceStateResult.value.openTabsSnapshot)
  if (!openTabsResult.ok) throw new Error('Could not read open tabs')
  const { snapshot, savedPageUpdates } = await buildTabsDashboardStartupSnapshot({
    dashboardTabs: getDashboardTabsFromOpenTabs(openTabsResult.tabs),
    currentWindowId: currentWindowResult.value,
    tabHistory: serviceStateResult.value.tabHistory,
    workingSetActivity: serviceStateResult.value.workingSetActivity,
    savedPagesStore: savedPagesResult.value,
    closedTabs: closedTabsResult.value,
    pinnedDomains: options.pinnedDomains,
    tabPreviousOrder: options.previousOrder.tabs || new Map()
  })
  // Page fetchers are the Saved Pages metadata writers; the build stays pure.
  void persistSavedPageMetadataUpdates(savedPageUpdates.base, savedPageUpdates.merged).catch(() => {})
  return snapshot
}

export async function fetchDashboardStartupSnapshot(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const key = startupSnapshotFlightKey(options)
  if (startupSnapshotFlight?.key === key) return startupSnapshotFlight.promise

  const id = {}
  const promise = (async () => {
    try {
      return await fetchDashboardStartupSnapshotOnce(options)
    } finally {
      if (startupSnapshotFlight?.id === id) startupSnapshotFlight = null
    }
  })()
  startupSnapshotFlight = { id, key, promise }
  return promise
}

export function useDashboardRefresh({
  dashboard,
  source,
  filter,
  historyRange,
  historyFilterEnabled,
  pinnedDomains,
  localStateLoaded,
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
  const historySearchPendingRevisionRef = useRef(0)
  const [historySearchPending, setHistorySearchPending] = useState(false)

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
    const tracksHistorySearch = buildFilterSearchRequest(requestContext).includeHistoryMatches
    const historySearchPendingRevision = tracksHistorySearch
      ? historySearchPendingRevisionRef.current + 1
      : 0
    if (tracksHistorySearch) {
      historySearchPendingRevisionRef.current = historySearchPendingRevision
      setHistorySearchPending(true)
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
          setDashboard(retainHistorySearchResultsOnError(result.snapshot.dashboard, dashboard))
          if (result.snapshot.tabHistory !== undefined) setTabHistory(result.snapshot.tabHistory)
          if (result.snapshot.workingSet !== undefined) setWorkingSet(result.snapshot.workingSet)
        }
      )
    } catch (error) {
      startupRefreshPendingRef.current = false
      animatedRefreshPendingRef.current = false
      throw error
    } finally {
      if (tracksHistorySearch && historySearchPendingRevisionRef.current === historySearchPendingRevision) {
        setHistorySearchPending(false)
      }
    }
  }

  useEffect(() => registerDashboardRefresh((options?: DashboardRefreshOptions) => refreshRef.current(options)), [])

  useEffect(() => {
    if (!localStateLoaded || !dashboardNeedsFilterSearchRefresh(dashboard, { source, filter, historyRange, historyFilterEnabled })) return
    const frame = requestAnimationFrame(() => {
      void settleDashboardRefresh(refreshRef.current({ waitForStartup: true }))
    })
    return () => cancelAnimationFrame(frame)
  }, [dashboard, filter, historyRange, historyFilterEnabled, localStateLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (!localStateLoaded) return
    callbacksRef.current.onBeforePinnedRefresh?.()
    const frame = requestAnimationFrame(() => {
      void settleDashboardRefresh(refreshRef.current())
    })
    return () => cancelAnimationFrame(frame)
  }, [pinnedDomains, localStateLoaded])

  // Stable identity: the hook itself bails out of React Compiler (the render-time
  // refreshRef assignment is its latest-callback architecture), so the returned
  // facade is memoized manually — consumers key effects and props on it.
  const refreshDashboard = useCallback((options?: DashboardRefreshOptions) => refreshRef.current(options), [])
  return { historySearchPending, refreshDashboard }
}
