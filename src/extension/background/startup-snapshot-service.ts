import { CLOSED_TAB_RESTORE_WATCHDOG_MS, CLOSED_TAB_SESSION_SETTLE_MS, closedTabFetchSuppressionRemainingMs, fetchClosedTabsResult } from '../closed-tabs.js'
import type { CapturedDashboardServiceState } from '../dashboard-service-messages.js'
import { DOMAIN_PIN_STORAGE_KEY, loadPinnedDomainsResult } from '../domain-pins.js'
import { loadPinnedPageChipsResult, PAGE_CHIP_PIN_STORAGE_KEY } from '../page-chip-pins.js'
import { getCurrentWindowIdResult } from '../render.js'
import { loadSavedPagesStoreResult, SAVED_PAGES_STORAGE_KEY } from '../saved-pages.js'
import { loadPinnedSectionsResult, SECTION_PIN_STORAGE_KEY } from '../section-pins.js'
import { buildTabsDashboardStartupSnapshot, captureDashboardStartupSnapshotStartedAt, loadCachedDashboardStartupResult, saveCachedDashboardStartupSnapshot } from '../startup-snapshot.js'
import { buildDashboardStartupViewModel } from '../startup-view-model.js'
import { fetchOpenTabsSnapshotResult, getDashboardTabsFromOpenTabs, seedOpenTabsTitleHistory } from '../tabs.js'

// Coalesce bursts of tab events into a single recompute. The maintained snapshot only needs to
// be reasonably fresh whenever a Tab Out page next opens; live hydration corrects any drift.
const STARTUP_SNAPSHOT_DEBOUNCE_MS = 4000
export const STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS = 250
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
  getDashboardServiceState: () => Promise<CapturedDashboardServiceState>
}

export type StartupSnapshotService = {
  scheduleRefresh: () => void
  sessionsChanged: () => void
  sessionRestoreStarted: (restoreId: string) => void
  sessionRestoreSettled: (restoreId: string) => void
  refreshNow: () => Promise<void>
}

export function createStartupSnapshotService(deps: StartupSnapshotServiceDeps): StartupSnapshotService {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let cacheSeedRetryTimer: ReturnType<typeof setTimeout> | null = null
  let cacheSeedRetryAttempted = false
  let closedTabsRetryTimer: ReturnType<typeof setTimeout> | null = null
  let sessionsSettleTimer: ReturnType<typeof setTimeout> | null = null
  let sessionsRevision = 0
  const pendingSessionRestoreIds = new Set<string>()
  const sessionRestoreWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()
  let inFlight: Promise<void> | null = null
  let refreshPending = false
  let cachedOpenTabsSeeded = false

  function clearCacheSeedRetry(): void {
    if (cacheSeedRetryTimer !== null) clearTimeout(cacheSeedRetryTimer)
    cacheSeedRetryTimer = null
  }

  function scheduleCacheSeedRetry(): void {
    if (cachedOpenTabsSeeded || cacheSeedRetryAttempted || cacheSeedRetryTimer !== null) return
    cacheSeedRetryTimer = setTimeout(() => {
      cacheSeedRetryTimer = null
      cacheSeedRetryAttempted = true
      void refreshNow()
    }, STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS)
  }

  function deferWhileClosedTabsSettle(): boolean {
    const remainingMs = closedTabFetchSuppressionRemainingMs()
    if (remainingMs <= 0) {
      if (closedTabsRetryTimer) clearTimeout(closedTabsRetryTimer)
      closedTabsRetryTimer = null
      return false
    }
    if (!Number.isFinite(remainingMs)) {
      if (closedTabsRetryTimer) clearTimeout(closedTabsRetryTimer)
      closedTabsRetryTimer = null
      return true
    }
    if (!closedTabsRetryTimer) {
      closedTabsRetryTimer = setTimeout(() => {
        closedTabsRetryTimer = null
        void refreshNow()
      }, Math.max(1, Math.ceil(remainingMs)))
    }
    return true
  }

  async function compute(): Promise<void> {
    // Chrome briefly reports an empty sessions list while a restore settles.
    // Preserve the warm cache and guarantee one trailing read after the window.
    if (pendingSessionRestoreIds.size > 0 || deferWhileClosedTabsSettle()) return
    const capturedSessionsRevision = sessionsRevision
    const captureStartedAt = captureDashboardStartupSnapshotStartedAt()
    if (!cachedOpenTabsSeeded) {
      const cachedResult = await loadCachedDashboardStartupResult()
      if (!cachedResult.ok) {
        scheduleCacheSeedRetry()
        return
      }
      clearCacheSeedRetry()
      seedOpenTabsTitleHistory(cachedResult.value?.snapshot.dashboard.realTabs ?? [])
      cachedOpenTabsSeeded = true
    }
    const [
      dashboardServiceState,
      currentWindowResult,
      savedPagesResult,
      pinnedDomainsResult,
      pinnedSectionsResult,
      pinnedPageChipsResult,
      closedTabsResult
    ] = await Promise.all([
      deps.getDashboardServiceState(),
      getCurrentWindowIdResult(),
      loadSavedPagesStoreResult(),
      loadPinnedDomainsResult(),
      loadPinnedSectionsResult(),
      loadPinnedPageChipsResult(),
      fetchClosedTabsResult()
    ])
    const openTabsResult = await fetchOpenTabsSnapshotResult(dashboardServiceState.openTabsSnapshot)
    if (
      !openTabsResult.ok ||
      !currentWindowResult.ok ||
      !savedPagesResult.ok ||
      !pinnedDomainsResult.ok ||
      !pinnedSectionsResult.ok ||
      !pinnedPageChipsResult.ok ||
      !closedTabsResult.ok ||
      pendingSessionRestoreIds.size > 0 ||
      capturedSessionsRevision !== sessionsRevision
    ) return
    const openTabs = openTabsResult.tabs
    const savedPagesStore = savedPagesResult.value
    const pinnedDomains = pinnedDomainsResult.value
    const pinnedSectionIds = pinnedSectionsResult.value
    const pinnedPageChipIds = pinnedPageChipsResult.value
    const localState = {
      loaded: true,
      pinnedDomains,
      pinnedSectionIds,
      pinnedPageChipIds
    }
    const snapshot = await buildTabsDashboardStartupSnapshot({
      dashboardTabs: getDashboardTabsFromOpenTabs(openTabs),
      currentWindowId: currentWindowResult.value,
      tabHistory: dashboardServiceState.tabHistory,
      workingSetActivity: dashboardServiceState.workingSetActivity,
      savedPagesStore,
      closedTabs: closedTabsResult.value,
      pinnedDomains
    })
    await saveCachedDashboardStartupSnapshot(snapshot, localState, {
      buildStartupViewModel: buildDashboardStartupViewModel,
      captureStartedAt
    })
  }

  function refreshNow(): Promise<void> {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
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

  function sessionsChanged(): void {
    // Invalidate a getRecentlyClosed already in flight before waiting out the
    // cross-context restore settle window and taking one authoritative read.
    sessionsRevision += 1
    if (sessionsSettleTimer) clearTimeout(sessionsSettleTimer)
    sessionsSettleTimer = null
    if (pendingSessionRestoreIds.size > 0) return
    scheduleSessionsSettleRefresh()
  }

  function scheduleSessionsSettleRefresh(): void {
    sessionsSettleTimer = setTimeout(() => {
      sessionsSettleTimer = null
      void refreshNow()
    }, CLOSED_TAB_SESSION_SETTLE_MS)
  }

  function sessionRestoreStarted(restoreId: string): void {
    if (!restoreId || pendingSessionRestoreIds.has(restoreId)) return
    pendingSessionRestoreIds.add(restoreId)
    sessionsRevision += 1
    if (sessionsSettleTimer) clearTimeout(sessionsSettleTimer)
    sessionsSettleTimer = null
    const watchdog = setTimeout(() => {
      sessionRestoreWatchdogs.delete(restoreId)
      if (!pendingSessionRestoreIds.delete(restoreId)) return
      sessionsRevision += 1
      if (pendingSessionRestoreIds.size === 0) scheduleSessionsSettleRefresh()
    }, CLOSED_TAB_RESTORE_WATCHDOG_MS)
    sessionRestoreWatchdogs.set(restoreId, watchdog)
  }

  function sessionRestoreSettled(restoreId: string): void {
    if (!restoreId) return
    const watchdog = sessionRestoreWatchdogs.get(restoreId)
    if (watchdog) clearTimeout(watchdog)
    sessionRestoreWatchdogs.delete(restoreId)
    pendingSessionRestoreIds.delete(restoreId)
    // Invalidate any read started during a missing/late start notification too.
    sessionsRevision += 1
    if (sessionsSettleTimer) clearTimeout(sessionsSettleTimer)
    sessionsSettleTimer = null
    if (pendingSessionRestoreIds.size === 0) scheduleSessionsSettleRefresh()
  }

  return { scheduleRefresh, sessionsChanged, sessionRestoreStarted, sessionRestoreSettled, refreshNow }
}
