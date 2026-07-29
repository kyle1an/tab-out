import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { registerDashboardRefresh, settleDashboardRefresh } from '../extension/dashboard-controller.js'
import type { DashboardRefreshOptions } from '../extension/dashboard-controller.js'
import { buildFilterSearchRequest, dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import {
  createLatestRefreshRunner,
  dashboardRefreshContextMatches,
  fetchDashboardSnapshot,
  fetchDashboardStartupSnapshot,
  retainHistorySearchResultsOnError,
  type DashboardRefreshContext,
  type DashboardRefreshSnapshot,
  type DashboardSnapshotOptions
} from '../extension/dashboard-intake.js'
import type { DashboardStartupSnapshot } from '../extension/startup-snapshot.js'
import type { DashboardData, TabHistorySnapshot, WorkingSetSnapshot } from '../extension/types'

// Compatibility shims: consumers keep importing these from the hook module
// until they re-point at dashboard-intake / startup-snapshot directly.
export { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS, DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS, loadCachedDashboardStartup, loadCachedDashboardStartupSnapshot } from '../extension/startup-snapshot.js'
export type { DashboardStartupSnapshot, CachedDashboardStartup, DashboardStartupViewModel } from '../extension/startup-snapshot.js'
export { createLatestRefreshRunner, fetchDashboardSnapshot, fetchDashboardStartupSnapshot, retainHistorySearchResultsOnError } from '../extension/dashboard-intake.js'
export type { MissionOrderMap } from '../extension/dashboard-intake.js'

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
