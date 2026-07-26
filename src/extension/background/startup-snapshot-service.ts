import { CLOSED_TAB_RESTORE_WATCHDOG_MS, CLOSED_TAB_SESSION_SETTLE_MS, closedTabFetchSuppressionRemainingMs, fetchClosedTabsResult } from '../closed-tabs.js'
import type { CapturedDashboardServiceState } from '../dashboard-service-messages.js'
import { loadDashboardLocalStateResult } from '../dashboard-local-state.js'
import { domainGroupCardId } from '../domain-card-id.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../domain-pins.js'
import { PAGE_CHIP_PIN_STORAGE_KEY } from '../page-chip-pins.js'
import { loadSavedPagesStoreResult, SAVED_PAGES_STORAGE_KEY } from '../saved-pages.js'
import { SECTION_PIN_STORAGE_KEY } from '../section-pins.js'
import { buildTabsDashboardStartupSnapshot, captureDashboardStartupSnapshotStartedAt, loadCachedDashboardStartupResult, promoteCachedDashboardStartupSnapshot, saveCachedDashboardStartupSnapshot } from '../startup-snapshot.js'
import { buildDashboardStartupViewModel } from '../startup-view-model.js'
import { fetchOpenTabsSnapshotResult, getDashboardTabsFromOpenTabs, seedOpenTabsTitleHistory } from '../tabs.js'

// Coalesce bursts of tab events into a single recompute. The maintained snapshot only needs to
// be reasonably fresh whenever a Tab Out page next opens; live hydration corrects any drift.
export const STARTUP_SNAPSHOT_DEBOUNCE_MS = 4000
export const STARTUP_SNAPSHOT_MAX_WAIT_MS = 30_000
export const STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS = 5 * 60_000
export const STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM = 'tab-out:startup-snapshot-durable-checkpoint'
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

type StartupSnapshotAlarmApi = {
  create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => Promise<void>
  get: (name: string) => Promise<chrome.alarms.Alarm | undefined>
}

export type StartupSnapshotServiceDeps = {
  alarms?: StartupSnapshotAlarmApi
  getDashboardServiceState: () => Promise<CapturedDashboardServiceState>
}

export type StartupSnapshotService = {
  scheduleRefresh: () => void
  sessionsChanged: () => void
  sessionRestoreStarted: (restoreId: string) => void
  sessionRestoreSettled: (restoreId: string) => void
  promoteDurableCheckpoint: () => Promise<void>
  refreshNow: () => Promise<void>
}

export function createStartupSnapshotService(deps: StartupSnapshotServiceDeps): StartupSnapshotService {
  let quietTimer: ReturnType<typeof setTimeout> | null = null
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  let cacheSeedRetryTimer: ReturnType<typeof setTimeout> | null = null
  let cacheSeedRetryAttempted = false
  let closedTabsRetryTimer: ReturnType<typeof setTimeout> | null = null
  let sessionsSettleTimer: ReturnType<typeof setTimeout> | null = null
  let sessionsRevision = 0
  const pendingSessionRestoreIds = new Set<string>()
  const sessionRestoreWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()
  let inFlight: Promise<void> | null = null
  // Same-worker concurrency guard only; the Chrome alarm remains the persisted schedule.
  let durablePromotionInFlight = false
  let cachedOpenTabsSeeded = false
  let tabPreviousOrder = new Map<string, number>()

  async function scheduleDurableCheckpoint(when: number): Promise<void> {
    if (!deps.alarms || durablePromotionInFlight) return
    try {
      const pending = await deps.alarms.get(STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM)
      if (pending) return
      await deps.alarms.create(STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM, { when })
    } catch {}
  }

  function rememberTabOrder(snapshot: Awaited<ReturnType<typeof buildTabsDashboardStartupSnapshot>>): void {
    tabPreviousOrder = new Map(
      snapshot.dashboard.domainGroups.map((group, index) => [domainGroupCardId(group), index])
    )
  }

  function clearScheduledRefresh(): void {
    if (quietTimer !== null) clearTimeout(quietTimer)
    if (maxWaitTimer !== null) clearTimeout(maxWaitTimer)
    quietTimer = null
    maxWaitTimer = null
  }

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
      if (cachedResult.value) rememberTabOrder(cachedResult.value.snapshot)
      cachedOpenTabsSeeded = true
    }
    const [
      dashboardServiceState,
      savedPagesResult,
      localStateResult,
      closedTabsResult
    ] = await Promise.all([
      deps.getDashboardServiceState(),
      loadSavedPagesStoreResult(),
      loadDashboardLocalStateResult(),
      fetchClosedTabsResult()
    ])
    const openTabsResult = await fetchOpenTabsSnapshotResult(dashboardServiceState.openTabsSnapshot)
    if (
      !openTabsResult.ok ||
      !savedPagesResult.ok ||
      !localStateResult.ok ||
      !closedTabsResult.ok ||
      pendingSessionRestoreIds.size > 0 ||
      capturedSessionsRevision !== sessionsRevision
    ) return
    const openTabs = openTabsResult.tabs
    const savedPagesStore = savedPagesResult.value
    const localState = localStateResult.state
    const pinnedDomains = localState.pinnedDomains
    const capturedActiveWindowId = dashboardServiceState.tabHistory.activeWindowId
    const currentWindowId = typeof capturedActiveWindowId === 'number' &&
      Number.isInteger(capturedActiveWindowId) && capturedActiveWindowId >= 0
      ? capturedActiveWindowId
      : null
    const snapshot = await buildTabsDashboardStartupSnapshot({
      dashboardTabs: getDashboardTabsFromOpenTabs(openTabs),
      // The worker's `windows.getCurrent()` is another last-focused-window
      // read. Reuse the window captured atomically with tabs + history instead
      // of mixing two browser generations.
      currentWindowId,
      tabHistory: dashboardServiceState.tabHistory,
      workingSetActivity: dashboardServiceState.workingSetActivity,
      savedPagesStore,
      closedTabs: closedTabsResult.value,
      pinnedDomains,
      tabPreviousOrder
    })
    await saveCachedDashboardStartupSnapshot(snapshot, localState, {
      buildStartupViewModel: buildDashboardStartupViewModel,
      captureStartedAt,
      durableCheckpointIntervalMs: STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS,
      ...(deps.alarms ? { scheduleDurableCheckpoint } : {})
    })
    rememberTabOrder(snapshot)
  }

  function refreshNow(): Promise<void> {
    clearScheduledRefresh()
    if (inFlight) {
      scheduleRefresh()
      return inFlight
    }
    const run = (async () => {
      try {
        await compute()
      } catch {}
    })()
    inFlight = run
    void run.finally(() => {
      if (inFlight === run) inFlight = null
    })
    return run
  }

  async function promoteDurableCheckpoint(): Promise<void> {
    if (durablePromotionInFlight) return
    durablePromotionInFlight = true
    try {
      await promoteCachedDashboardStartupSnapshot()
    } catch {
    } finally {
      durablePromotionInFlight = false
    }
  }

  function scheduleRefresh(): void {
    if (quietTimer !== null) clearTimeout(quietTimer)
    const runScheduledRefresh = () => {
      clearScheduledRefresh()
      void refreshNow()
    }
    quietTimer = setTimeout(runScheduledRefresh, STARTUP_SNAPSHOT_DEBOUNCE_MS)
    if (maxWaitTimer === null) {
      maxWaitTimer = setTimeout(runScheduledRefresh, STARTUP_SNAPSHOT_MAX_WAIT_MS)
    }
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
      scheduleRefresh()
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

  return {
    scheduleRefresh,
    sessionsChanged,
    sessionRestoreStarted,
    sessionRestoreSettled,
    promoteDurableCheckpoint,
    refreshNow
  }
}
