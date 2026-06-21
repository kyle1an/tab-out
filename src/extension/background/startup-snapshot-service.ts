import { fetchClosedTabs, isClosedTabFetchSuppressed } from '../closed-tabs.js'
import { loadPinnedDomains } from '../domain-pins.js'
import { getCurrentWindowId } from '../render.js'
import { loadSavedPagesStore } from '../saved-pages.js'
import { buildTabsDashboardStartupSnapshot, LOCAL_PATH_GROUPERS_ACTIVE_KEY, saveCachedDashboardStartupSnapshot } from '../startup-snapshot.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs } from '../tabs.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from '../types'

// Coalesce bursts of tab events into a single recompute. The maintained snapshot only needs to
// be reasonably fresh whenever a Tab Out page next opens; live hydration corrects any drift.
const STARTUP_SNAPSHOT_DEBOUNCE_MS = 4000

export type StartupSnapshotServiceDeps = {
  getTabHistorySnapshot: () => Promise<TabHistorySnapshot>
  getWorkingSetActivity: () => Promise<WorkingSetActivityStore>
}

export type StartupSnapshotService = {
  scheduleRefresh: () => void
  refreshNow: () => Promise<void>
}

export function createStartupSnapshotService(deps: StartupSnapshotServiceDeps): StartupSnapshotService {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  async function pathGroupersActive(): Promise<boolean> {
    try {
      const stored = await globalThis.chrome?.storage?.local?.get(LOCAL_PATH_GROUPERS_ACTIVE_KEY)
      return stored?.[LOCAL_PATH_GROUPERS_ACTIVE_KEY] === true
    } catch {
      return false
    }
  }

  async function compute(): Promise<void> {
    if (await pathGroupersActive()) return
    const [openTabs, currentWindowId, tabHistory, workingSetActivity, savedPagesStore, pinnedDomains, closedTabs] = await Promise.all([
      fetchOpenTabsSnapshot(),
      getCurrentWindowId(),
      deps.getTabHistorySnapshot(),
      deps.getWorkingSetActivity(),
      loadSavedPagesStore(),
      loadPinnedDomains(),
      isClosedTabFetchSuppressed() ? Promise.resolve([]) : fetchClosedTabs()
    ])
    const snapshot = await buildTabsDashboardStartupSnapshot({
      dashboardTabs: getDashboardTabsFromOpenTabs(openTabs),
      currentWindowId,
      tabHistory,
      workingSetActivity,
      savedPagesStore,
      closedTabs,
      pinnedDomains
    })
    await saveCachedDashboardStartupSnapshot(snapshot, null)
  }

  function refreshNow(): Promise<void> {
    if (inFlight) return inFlight
    const run = compute().catch(() => {})
    inFlight = run.finally(() => {
      if (inFlight === run) inFlight = null
    })
    return inFlight
  }

  function scheduleRefresh(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void refreshNow()
    }, STARTUP_SNAPSHOT_DEBOUNCE_MS)
  }

  return { scheduleRefresh, refreshNow }
}
