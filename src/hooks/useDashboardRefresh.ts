import { useEffect, useLayoutEffect, useRef } from 'react'
import { settleDashboardRefresh } from '../extension/dashboard-controller.js'
import { dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { appDashboardStore, type MissionOrderMap } from '../extension/dashboard-intake.js'
import type { DashboardData, DashboardSource } from '../extension/types'

// Compatibility shims: consumers keep importing these from the hook module
// until they re-point at dashboard-intake / startup-snapshot directly.
export { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS, DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS, loadCachedDashboardStartup, loadCachedDashboardStartupSnapshot } from '../extension/startup-snapshot.js'
export type { DashboardStartupSnapshot, CachedDashboardStartup, DashboardStartupViewModel } from '../extension/startup-snapshot.js'
export { createLatestRefreshRunner, fetchDashboardSnapshot, fetchDashboardStartupSnapshot, retainHistorySearchResultsOnError } from '../extension/dashboard-intake.js'
export type { MissionOrderMap } from '../extension/dashboard-intake.js'

type UseDashboardRefreshOptions = {
  dashboard: DashboardData | null
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  localStateLoaded: boolean
  previousOrder: MissionOrderMap
  onBeforePinnedRefresh?: () => void
}

/**
 * React adapter for the Dashboard Intake store's refresh path: it feeds the
 * store its page-side refresh inputs and turns React-observable changes
 * (filter search staleness, pinned-domain updates) into refresh requests.
 * The latest-wins arbitration itself lives in the store.
 */
export function useDashboardRefresh({
  dashboard,
  source,
  filter,
  historyRange,
  historyFilterEnabled,
  pinnedDomains,
  localStateLoaded,
  previousOrder,
  onBeforePinnedRefresh
}: UseDashboardRefreshOptions) {
  const callbacksRef = useRef({ onBeforePinnedRefresh })

  useEffect(() => {
    callbacksRef.current = { onBeforePinnedRefresh }
  }, [onBeforePinnedRefresh])

  useLayoutEffect(() => {
    appDashboardStore.setRefreshInputs({ filter, localStateLoaded, pinnedDomains, previousOrder })
  }, [filter, localStateLoaded, pinnedDomains, previousOrder])

  useEffect(() => {
    if (!localStateLoaded || !dashboardNeedsFilterSearchRefresh(dashboard, { source, filter, historyRange, historyFilterEnabled })) return
    const frame = requestAnimationFrame(() => {
      void settleDashboardRefresh(appDashboardStore.refresh({ waitForStartup: true }))
    })
    return () => cancelAnimationFrame(frame)
  }, [dashboard, filter, historyRange, historyFilterEnabled, localStateLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (!localStateLoaded) return
    callbacksRef.current.onBeforePinnedRefresh?.()
    const frame = requestAnimationFrame(() => {
      void settleDashboardRefresh(appDashboardStore.refresh())
    })
    return () => cancelAnimationFrame(frame)
  }, [pinnedDomains, localStateLoaded])

  return { refreshDashboard: appDashboardStore.refresh }
}
