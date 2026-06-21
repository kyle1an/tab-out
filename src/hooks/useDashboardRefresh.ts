import { useEffect, useRef } from 'react'
import { fetchClosedTabs, isClosedTabFetchSuppressed } from '../extension/closed-tabs.js'
import { registerDashboardRefresh } from '../extension/dashboard-controller.js'
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

export type RefreshOptions = { animateCards?: boolean; startupSnapshot?: boolean }
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

let startupSnapshotFlight: { key: string; promise: Promise<DashboardStartupSnapshot> } | null = null

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
  if (startupSnapshotFlight?.key === key) return startupSnapshotFlight.promise

  const promise = fetchDashboardStartupSnapshotOnce(options)
  startupSnapshotFlight = { key, promise }
  try {
    const snapshot = await promise
    void saveCachedDashboardStartupSnapshot(snapshot, options.localState ?? null, {
      buildStartupViewModel: buildDashboardStartupViewModel
    })
    return snapshot
  } finally {
    if (startupSnapshotFlight?.promise === promise) startupSnapshotFlight = null
  }
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
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => {})
  const startupRefreshFlightRef = useRef<Promise<void> | null>(null)
  const startupRefreshPendingRef = useRef(false)
  const animatedRefreshPendingRef = useRef(false)

  useEffect(() => {
    callbacksRef.current = { onBeforeAnimatedRefresh, onBeforePinnedRefresh }
  }, [onBeforeAnimatedRefresh, onBeforePinnedRefresh])

  refreshRef.current = async ({ animateCards = false, startupSnapshot = false }: RefreshOptions = {}) => {
    if (startupSnapshot) startupRefreshPendingRef.current = true
    if (animateCards) animatedRefreshPendingRef.current = true
    if (document.visibilityState !== 'visible') return
    if (!localStateLoaded) return
    const shouldAnimate = animatedRefreshPendingRef.current
    if (shouldAnimate) callbacksRef.current.onBeforeAnimatedRefresh?.()
    if (source === 'tabs' && (!dashboard || startupRefreshPendingRef.current)) {
      if (startupRefreshFlightRef.current) return startupRefreshFlightRef.current
      const startupRefreshFlight = (async () => {
        const nextStartup = await fetchDashboardStartupSnapshot({
          source,
          filter,
          historyRange,
          historyFilterEnabled,
          pinnedDomains,
          localState,
          previousOrder
        })
        startupRefreshPendingRef.current = false
        animatedRefreshPendingRef.current = false
        setStartupSnapshot(nextStartup)
      })()
      startupRefreshFlightRef.current = startupRefreshFlight
      try {
        await startupRefreshFlight
      } finally {
        if (startupRefreshFlightRef.current === startupRefreshFlight) startupRefreshFlightRef.current = null
      }
      return
    }
    const next = await fetchDashboardSnapshot({
      source,
      filter,
      historyRange,
      historyFilterEnabled,
      pinnedDomains,
      previousOrder
    })
    animatedRefreshPendingRef.current = false
    setDashboard(next.dashboard)
    setTabHistory(next.tabHistory)
    setWorkingSet(next.workingSet)
  }

  useEffect(() => registerDashboardRefresh((options?: RefreshOptions) => refreshRef.current(options)), [])

  useEffect(() => {
    if (!localStateLoaded || !dashboardNeedsFilterSearchRefresh(dashboard, { source, filter, historyRange, historyFilterEnabled })) return
    const frame = requestAnimationFrame(() => refreshRef.current())
    return () => cancelAnimationFrame(frame)
  }, [dashboard, filter, historyRange, historyFilterEnabled, localStateLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (!localStateLoaded) return
    callbacksRef.current.onBeforePinnedRefresh?.()
    requestAnimationFrame(() => refreshRef.current())
  }, [pinnedDomains, localStateLoaded])

  return (options?: RefreshOptions) => refreshRef.current(options)
}
