import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { registerDashboardRefresh } from '../extension/dashboard-controller.js'
import { buildFilterSearchRequest, dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { fetchDashboardData } from '../extension/render.js'
import { fetchTabHistorySnapshot } from '../extension/tab-history.js'
import type { DashboardData, DashboardSource, TabHistorySnapshot } from '../extension/types'

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
  setDashboard: Dispatch<SetStateAction<DashboardData | null>>
  setTabHistory: Dispatch<SetStateAction<TabHistorySnapshot | null>>
  onBeforeAnimatedRefresh?: () => void
  onBeforePinnedRefresh?: () => void
}

export async function fetchDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder }: DashboardSnapshotOptions) {
  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [dashboard, tabHistory] = await Promise.all([
    fetchDashboardData(previousOrder[source] || new Map(), source, {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange
    }),
    fetchTabHistorySnapshot()
  ])

  return { dashboard, tabHistory }
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
