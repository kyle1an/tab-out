import { useEffect, useRef } from 'react'
import { fetchClosedTabs, isClosedTabFetchSuppressed, type ClosedTabEntry } from '../extension/closed-tabs.js'
import { registerDashboardRefresh } from '../extension/dashboard-controller.js'
import { fetchDashboardServiceState } from '../extension/dashboard-service-state.js'
import { buildFilterSearchRequest, dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { buildDashboardDataFromTabs, fetchDashboardData, getCurrentWindowId } from '../extension/render.js'
import { fetchTabHistorySnapshot } from '../extension/tab-history.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs } from '../extension/tabs.js'
import { buildWorkingSetSnapshot } from '../extension/working-set.js'
import { fetchWorkingSetSnapshot } from '../extension/working-set-client.js'
import { loadSavedPagesStore, type SavedPagesStore } from '../extension/saved-pages.js'
import type { DashboardData, DashboardSource, TabHistorySnapshot, WorkingSetSnapshot } from '../extension/types'

export type RefreshOptions = { animateCards?: boolean }
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
export type DashboardStartupSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
  closedTabs: readonly ClosedTabEntry[]
}
type DashboardRefreshSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
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

let startupSnapshotFlight: { key: string; promise: Promise<DashboardStartupSnapshot> } | null = null

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
  const [openTabs, currentWindowId, serviceState, resolvedSavedPagesStore] = await Promise.all([
    fetchOpenTabsSnapshot(),
    getCurrentWindowId(),
    fetchDashboardServiceState(),
    savedPagesStore ? Promise.resolve(savedPagesStore) : loadSavedPagesStore()
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
    fetchDashboardData(previousOrder[source] || new Map(), source, {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange
    }),
    fetchTabHistorySnapshot(),
    fetchWorkingSetSnapshot()
  ])

  return { dashboard, tabHistory, workingSet }
}

async function fetchDashboardStartupSnapshotOnce(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const closedTabsPromise = isClosedTabFetchSuppressed() ? Promise.resolve([]) : fetchClosedTabs()
  const [snapshot, closedTabs] = await Promise.all([
    fetchTabsDashboardSnapshot(options),
    closedTabsPromise
  ])
  return { ...snapshot, closedTabs }
}

export async function fetchDashboardStartupSnapshot(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const key = startupSnapshotFlightKey(options)
  if (startupSnapshotFlight?.key === key) return startupSnapshotFlight.promise

  const promise = fetchDashboardStartupSnapshotOnce(options)
  startupSnapshotFlight = { key, promise }
  try {
    return await promise
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

  useEffect(() => {
    callbacksRef.current = { onBeforeAnimatedRefresh, onBeforePinnedRefresh }
  }, [onBeforeAnimatedRefresh, onBeforePinnedRefresh])

  refreshRef.current = async ({ animateCards = false }: RefreshOptions = {}) => {
    if (document.visibilityState !== 'visible') return
    if (!localStateLoaded) return
    if (animateCards) callbacksRef.current.onBeforeAnimatedRefresh?.()
    if (!dashboard && source === 'tabs') {
      const nextStartup = await fetchDashboardStartupSnapshot({
        source,
        filter,
        historyRange,
        historyFilterEnabled,
        pinnedDomains,
        previousOrder
      })
      setStartupSnapshot(nextStartup)
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
