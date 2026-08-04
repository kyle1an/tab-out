import {
  Context,
  Deferred,
  Effect,
  FiberHandle,
  FiberMap,
  FiberSet,
  Layer,
  Ref,
  Schema
} from 'effect'

import {
  CLOSED_TAB_RESTORE_WATCHDOG_MS,
  CLOSED_TAB_SESSION_SETTLE_MS,
  closedTabFetchSuppressionRemainingMs,
  fetchClosedTabsResultEffect
} from '../closed-tabs.js'
import type { CapturedDashboardServiceState } from '../dashboard-service-messages.js'
import { loadDashboardLocalStateResultEffect } from '../dashboard-local-state.js'
import { domainGroupCardId } from '../domain-card-id.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../domain-pins.js'
import { PAGE_CHIP_PIN_STORAGE_KEY } from '../page-chip-pins.js'
import { SAVED_PAGES_STORAGE_KEY } from '../saved-pages.js'
import { loadSavedPagesStoreResultEffect } from '../saved-pages-storage.js'
import { SECTION_PIN_STORAGE_KEY } from '../section-pins.js'
import {
  buildTabsDashboardStartupSnapshotEffect,
  captureDashboardStartupSnapshotStartedAt,
  loadCachedDashboardStartupResultEffect,
  promoteCachedDashboardStartupSnapshotEffect,
  saveCachedDashboardStartupSnapshotEffect,
  type DashboardStartupSnapshot
} from '../startup-snapshot.js'
import { buildDashboardStartupViewModel } from '../startup-view-model.js'
import {
  fetchOpenTabsSnapshotEffect,
  getDashboardTabsFromOpenTabs,
  seedOpenTabsTitleHistory
} from '../tabs.js'
import { BrowserTabs } from '../browser-tabs-service.js'

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
    STARTUP_SNAPSHOT_RENDER_STATE_KEYS.some((key) => Object.hasOwn(changes, key))
}

type StartupSnapshotAlarmApi = {
  create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => Promise<void>
  get: (name: string) => Promise<chrome.alarms.Alarm | undefined>
}

export type StartupSnapshotLayerDeps<Failure, Requirements> = {
  readonly alarms?: StartupSnapshotAlarmApi
  readonly getDashboardServiceState: Effect.Effect<
    CapturedDashboardServiceState,
    Failure,
    Requirements
  >
}

export class StartupSnapshot extends Context.Service<StartupSnapshot, {
  readonly scheduleRefresh: () => Effect.Effect<void>
  readonly sessionsChanged: () => Effect.Effect<void>
  readonly sessionRestoreStarted: (restoreId: string) => Effect.Effect<void>
  readonly sessionRestoreSettled: (restoreId: string) => Effect.Effect<void>
  readonly promoteDurableCheckpoint: () => Effect.Effect<void>
  readonly refreshNow: () => Effect.Effect<void>
}>()('@tab-out/background/StartupSnapshot') {
  static layer<Failure, Requirements>(
    deps: StartupSnapshotLayerDeps<Failure, Requirements>
  ): Layer.Layer<StartupSnapshot, never, Requirements | BrowserTabs> {
    return makeStartupSnapshotLayer(deps)
  }
}

class StartupSnapshotRefreshError extends Schema.TaggedErrorClass<StartupSnapshotRefreshError>()(
  'StartupSnapshotRefreshError',
  { cause: Schema.Defect() }
) {}

type RefreshFlight = {
  readonly completion: Deferred.Deferred<void>
  readonly shouldStart: boolean
}

function makeStartupSnapshotLayer<Failure, Requirements>(
  deps: StartupSnapshotLayerDeps<Failure, Requirements>
): Layer.Layer<StartupSnapshot, never, Requirements | BrowserTabs> {
  return Layer.effect(StartupSnapshot, Effect.gen(function*() {
    const scope = yield* Effect.scope
    const browserTabs = yield* BrowserTabs
    const services = yield* Effect.context<Requirements>()
    const getDashboardServiceState = deps.getDashboardServiceState.pipe(
      Effect.provide(services)
    )
    const inFlight = yield* Ref.make<Deferred.Deferred<void> | null>(null)
    const quietRefresh = yield* FiberHandle.make<void, never>()
    const maxWaitRefresh = yield* FiberHandle.make<void, never>()
    const cacheSeedRetry = yield* FiberHandle.make<void, never>()
    const closedTabsRetry = yield* FiberHandle.make<void, never>()
    const sessionsSettle = yield* FiberHandle.make<void, never>()
    const sessionRestoreWatchdogs = yield* FiberMap.make<string, void, never>()
    const runInLayer = yield* FiberSet.makeRuntime<never, void, never>()
    let cacheSeedRetryAttempted = false
    let sessionsRevision = 0
    const pendingSessionRestoreIds = new Set<string>()
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

    function rememberTabOrder(snapshot: DashboardStartupSnapshot): void {
      tabPreviousOrder = new Map(
        snapshot.dashboard.domainGroups.map((group, index) => [domainGroupCardId(group), index])
      )
    }

    const clearScheduledRefresh = Effect.fn('StartupSnapshot.clearScheduledRefresh')(function*() {
      yield* FiberHandle.clear(quietRefresh)
      yield* FiberHandle.clear(maxWaitRefresh)
    })

    const clearCacheSeedRetry = () => FiberHandle.clear(cacheSeedRetry)

    function refreshNow(): Effect.Effect<void> {
      return runRefreshNow()
    }

    const scheduleCacheSeedRetry = Effect.fn('StartupSnapshot.scheduleCacheSeedRetry')(function*() {
      if (cachedOpenTabsSeeded || cacheSeedRetryAttempted) return
      yield* FiberHandle.run(
        cacheSeedRetry,
        Effect.sleep(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS).pipe(
          Effect.andThen(Effect.sync(() => {
            cacheSeedRetryAttempted = true
            runInLayer(refreshNow())
          }))
        ),
        { onlyIfMissing: true }
      )
    })

    const deferWhileClosedTabsSettle = Effect.fn('StartupSnapshot.deferClosedTabs')(function*() {
      const remainingMs = closedTabFetchSuppressionRemainingMs()
      if (remainingMs <= 0) {
        yield* FiberHandle.clear(closedTabsRetry)
        return false
      }
      if (!Number.isFinite(remainingMs)) {
        yield* FiberHandle.clear(closedTabsRetry)
        return true
      }
      yield* FiberHandle.run(
        closedTabsRetry,
        Effect.sleep(Math.max(1, Math.ceil(remainingMs))).pipe(
          Effect.andThen(Effect.sync(() => {
            runInLayer(refreshNow())
          }))
        ),
        { onlyIfMissing: true }
      )
      return true
    })

    const computeStartupSnapshot = Effect.fn('StartupSnapshot.compute')(function*() {
      // Chrome briefly reports an empty sessions list while a restore settles.
      // Preserve the warm cache and guarantee one trailing read after the window.
      if (pendingSessionRestoreIds.size > 0 || (yield* deferWhileClosedTabsSettle())) return
      const capturedSessionsRevision = sessionsRevision
      const captureStartedAt = captureDashboardStartupSnapshotStartedAt()
      if (!cachedOpenTabsSeeded) {
        const cachedResult = yield* loadCachedDashboardStartupResultEffect()
        if (!cachedResult.ok) {
          yield* scheduleCacheSeedRetry()
          return
        }
        yield* clearCacheSeedRetry()
        seedOpenTabsTitleHistory(cachedResult.value?.snapshot.dashboard.realTabs ?? [])
        if (cachedResult.value) rememberTabOrder(cachedResult.value.snapshot)
        cachedOpenTabsSeeded = true
      }

      const dashboardServiceStateEffect = getDashboardServiceState.pipe(
        Effect.mapError((cause) => StartupSnapshotRefreshError.make({ cause }))
      )
      const [dashboardServiceState, savedPagesResult, localStateResult, closedTabsResult] =
        yield* Effect.all([
          dashboardServiceStateEffect,
          loadSavedPagesStoreResultEffect(),
          loadDashboardLocalStateResultEffect(),
          fetchClosedTabsResultEffect().pipe(Effect.provideService(BrowserTabs, browserTabs))
        ], { concurrency: 'unbounded' })
      const openTabsResult = yield* fetchOpenTabsSnapshotEffect(
        dashboardServiceState.openTabsSnapshot
      ).pipe(Effect.provideService(BrowserTabs, browserTabs))
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
      // The worker deliberately drops the build's savedPageUpdates: Saved Pages
      // metadata writes belong to page fetchers only.
      const { snapshot } = yield* buildTabsDashboardStartupSnapshotEffect({
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
      }).pipe(
        Effect.mapError((error) => StartupSnapshotRefreshError.make({ cause: error.cause }))
      )
      yield* saveCachedDashboardStartupSnapshotEffect(snapshot, localState, {
        buildStartupViewModel: buildDashboardStartupViewModel,
        captureStartedAt,
        durableCheckpointIntervalMs: STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS,
        ...(deps.alarms ? { scheduleDurableCheckpoint } : {})
      }).pipe(
        Effect.mapError((error) => StartupSnapshotRefreshError.make({ cause: error.cause }))
      )
      rememberTabOrder(snapshot)
    })

    const runStartupSnapshotRefresh = Effect.fn('StartupSnapshot.runRefresh')(function*() {
      yield* computeStartupSnapshot().pipe(
        Effect.catchTag('StartupSnapshotRefreshError', () => Effect.void)
      )
    })

    const scheduleRefreshState = Effect.fn('StartupSnapshot.scheduleRefresh')(function*() {
      const runScheduledRefresh = Effect.sync(() => {
        runInLayer(refreshNow())
      })
      yield* FiberHandle.run(
        quietRefresh,
        Effect.sleep(STARTUP_SNAPSHOT_DEBOUNCE_MS).pipe(
          Effect.andThen(runScheduledRefresh)
        )
      )
      yield* FiberHandle.run(
        maxWaitRefresh,
        Effect.sleep(STARTUP_SNAPSHOT_MAX_WAIT_MS).pipe(
          Effect.andThen(runScheduledRefresh)
        ),
        { onlyIfMissing: true }
      )
    })

    const runRefreshNow = Effect.fn('StartupSnapshot.refreshNow')(function*() {
      yield* clearScheduledRefresh()
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
        const candidate = yield* Deferred.make<void>()
        const flight = yield* Ref.modify(
          inFlight,
          (current): readonly [RefreshFlight, Deferred.Deferred<void> | null] => current
            ? [{ completion: current, shouldStart: false }, current]
            : [{ completion: candidate, shouldStart: true }, candidate]
        )
        if (!flight.shouldStart) {
          yield* scheduleRefreshState()
          return yield* restore(Deferred.await(flight.completion))
        }

        yield* runStartupSnapshotRefresh().pipe(
          Effect.onExit((exit) => Ref.update(inFlight, (current) =>
            current === flight.completion ? null : current
          ).pipe(
            Effect.andThen(Deferred.done(flight.completion, exit)),
            Effect.asVoid
          )),
          Effect.forkIn(scope, { startImmediately: true })
        )
        return yield* restore(Deferred.await(flight.completion))
      }))
    })

    const promoteDurableCheckpoint = Effect.fn('StartupSnapshot.promoteDurableCheckpoint')(
      function*() {
        if (durablePromotionInFlight) return
        durablePromotionInFlight = true
        yield* promoteCachedDashboardStartupSnapshotEffect().pipe(
          Effect.mapError((error) => StartupSnapshotRefreshError.make({ cause: error.cause })),
          Effect.catchTag('StartupSnapshotRefreshError', () => Effect.void),
          Effect.ensuring(Effect.sync(() => {
            durablePromotionInFlight = false
          }))
        )
      }
    )

    const scheduleSessionsSettleRefresh = Effect.fn(
      'StartupSnapshot.scheduleSessionsSettleRefresh'
    )(function*() {
      yield* FiberHandle.run(
        sessionsSettle,
        Effect.sleep(CLOSED_TAB_SESSION_SETTLE_MS).pipe(
          Effect.andThen(scheduleRefreshState())
        )
      )
    })

    const sessionsChangedState = Effect.fn('StartupSnapshot.sessionsChanged')(function*() {
      // Invalidate a getRecentlyClosed already in flight before waiting out the
      // cross-context restore settle window and taking one authoritative read.
      sessionsRevision += 1
      yield* FiberHandle.clear(sessionsSettle)
      if (pendingSessionRestoreIds.size > 0) return
      yield* scheduleSessionsSettleRefresh()
    })

    const sessionRestoreStartedState = Effect.fn(
      'StartupSnapshot.sessionRestoreStarted'
    )(function*(restoreId: string) {
      if (!restoreId || pendingSessionRestoreIds.has(restoreId)) return
      pendingSessionRestoreIds.add(restoreId)
      sessionsRevision += 1
      yield* FiberHandle.clear(sessionsSettle)
      yield* FiberMap.run(
        sessionRestoreWatchdogs,
        restoreId,
        Effect.sleep(CLOSED_TAB_RESTORE_WATCHDOG_MS).pipe(
          Effect.andThen(Effect.gen(function*() {
            if (!pendingSessionRestoreIds.delete(restoreId)) return
            sessionsRevision += 1
            if (pendingSessionRestoreIds.size === 0) {
              yield* scheduleSessionsSettleRefresh()
            }
          }))
        )
      )
    })

    const sessionRestoreSettledState = Effect.fn(
      'StartupSnapshot.sessionRestoreSettled'
    )(function*(restoreId: string) {
      if (!restoreId) return
      yield* FiberMap.remove(sessionRestoreWatchdogs, restoreId)
      pendingSessionRestoreIds.delete(restoreId)
      // Invalidate any read started during a missing/late start notification too.
      sessionsRevision += 1
      yield* FiberHandle.clear(sessionsSettle)
      if (pendingSessionRestoreIds.size === 0) {
        yield* scheduleSessionsSettleRefresh()
      }
    })

    return StartupSnapshot.of({
      scheduleRefresh: scheduleRefreshState,
      sessionsChanged: sessionsChangedState,
      sessionRestoreStarted: sessionRestoreStartedState,
      sessionRestoreSettled: sessionRestoreSettledState,
      promoteDurableCheckpoint,
      refreshNow
    })
  }))
}
