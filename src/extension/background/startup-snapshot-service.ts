import { fetchClosedTabs, isClosedTabFetchSuppressed } from '../closed-tabs.js'
import { DOMAIN_PIN_STORAGE_KEY, loadPinnedDomains } from '../domain-pins.js'
import { loadPinnedPageChips, PAGE_CHIP_PIN_STORAGE_KEY } from '../page-chip-pins.js'
import { getCurrentWindowId } from '../render.js'
import { loadSavedPagesStore, SAVED_PAGES_STORAGE_KEY } from '../saved-pages.js'
import { loadPinnedSections, SECTION_PIN_STORAGE_KEY } from '../section-pins.js'
import { buildTabsDashboardStartupSnapshot, loadCachedDashboardStartupSnapshot, saveCachedDashboardStartupSnapshot } from '../startup-snapshot.js'
import { buildDashboardStartupViewModel } from '../startup-view-model.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs, seedOpenTabsTitleHistory } from '../tabs.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from '../types'

// Coalesce bursts of tab events into a single recompute. The maintained snapshot only needs to
// be reasonably fresh whenever a Tab Out page next opens; live hydration corrects any drift.
const STARTUP_SNAPSHOT_DEBOUNCE_MS = 4000
const STARTUP_SNAPSHOT_RENDER_STATE_KEYS = [
  DOMAIN_PIN_STORAGE_KEY,
  SECTION_PIN_STORAGE_KEY,
  PAGE_CHIP_PIN_STORAGE_KEY,
  SAVED_PAGES_STORAGE_KEY
]

export function startupSnapshotStorageChangesRequireRefresh(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string
): boolean {
  return areaName === 'local' &&
    STARTUP_SNAPSHOT_RENDER_STATE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(changes, key))
}

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
  let refreshPending = false
  let cachedOpenTabsSeeded = false

  async function compute(): Promise<void> {
    if (!cachedOpenTabsSeeded) {
      const cachedSnapshot = await loadCachedDashboardStartupSnapshot()
      seedOpenTabsTitleHistory(cachedSnapshot?.dashboard.realTabs ?? [])
      cachedOpenTabsSeeded = true
    }
    const [
      openTabs,
      currentWindowId,
      tabHistory,
      workingSetActivity,
      savedPagesStore,
      pinnedDomains,
      pinnedSectionIds,
      pinnedPageChipIds,
      closedTabs
    ] = await Promise.all([
      fetchOpenTabsSnapshot(),
      getCurrentWindowId(),
      deps.getTabHistorySnapshot(),
      deps.getWorkingSetActivity(),
      loadSavedPagesStore(),
      loadPinnedDomains(),
      loadPinnedSections(),
      loadPinnedPageChips(),
      isClosedTabFetchSuppressed() ? Promise.resolve([]) : fetchClosedTabs()
    ])
    const localState = {
      loaded: true,
      pinnedDomains,
      pinnedSectionIds,
      pinnedPageChipIds
    }
    const snapshot = await buildTabsDashboardStartupSnapshot({
      dashboardTabs: getDashboardTabsFromOpenTabs(openTabs),
      currentWindowId,
      tabHistory,
      workingSetActivity,
      savedPagesStore,
      closedTabs,
      pinnedDomains
    })
    await saveCachedDashboardStartupSnapshot(snapshot, localState, {
      buildStartupViewModel: buildDashboardStartupViewModel
    })
  }

  function refreshNow(): Promise<void> {
    if (inFlight) {
      refreshPending = true
      return inFlight
    }
    const run = (async () => {
      do {
        refreshPending = false
        try {
          await compute()
        } catch {}
      } while (refreshPending)
    })()
    inFlight = run
    void run.finally(() => {
      if (inFlight === run) inFlight = null
    })
    return run
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
