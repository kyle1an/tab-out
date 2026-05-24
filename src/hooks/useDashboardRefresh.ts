import { useEffect, useRef } from 'react'
import { registerDashboardRefresh } from '../extension/dashboard-controller.js'
import { buildFilterSearchRequest, dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { fetchDashboardData } from '../extension/render.js'
import { fetchTabHistorySnapshot } from '../extension/tab-history.js'
import { fetchWorkingSetSnapshot } from '../extension/working-set-client.js'
import type { DashboardData, DashboardSource, TabHistorySnapshot, WorkingSetSnapshot } from '../extension/types'

export type RefreshOptions = { animateCards?: boolean }
export type MissionOrderMap = Record<DashboardSource, Map<string, number>>

type DashboardSnapshotOptions = {
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  previousOrder: MissionOrderMap
}

type UseDashboardRefreshOptions = DashboardSnapshotOptions & {
  dashboard: DashboardData | null
  pinsLoaded: boolean
  setDashboard: (dashboard: DashboardData | null) => void
  setTabHistory: (tabHistory: TabHistorySnapshot | null) => void
  setWorkingSet: (workingSet: WorkingSetSnapshot | null) => void
  onBeforeAnimatedRefresh?: () => void
  onBeforePinnedRefresh?: () => void
}

export async function fetchDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder }: DashboardSnapshotOptions) {
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

export function useDashboardRefresh({
  dashboard,
  source,
  filter,
  historyRange,
  historyFilterEnabled,
  pinnedDomains,
  pinsLoaded,
  previousOrder,
  setDashboard,
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
    if (!pinsLoaded) return
    if (animateCards) callbacksRef.current.onBeforeAnimatedRefresh?.()
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

  useEffect(() => registerDashboardRefresh((options: RefreshOptions) => refreshRef.current(options)), [])

  useEffect(() => {
    if (!pinsLoaded || !dashboardNeedsFilterSearchRefresh(dashboard, { source, filter, historyRange, historyFilterEnabled })) return
    const frame = requestAnimationFrame(() => refreshRef.current())
    return () => cancelAnimationFrame(frame)
  }, [dashboard, filter, historyRange, historyFilterEnabled, pinsLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (!pinsLoaded) return
    callbacksRef.current.onBeforePinnedRefresh?.()
    requestAnimationFrame(() => refreshRef.current())
  }, [pinnedDomains, pinsLoaded])

  return (options?: RefreshOptions) => refreshRef.current(options)
}
