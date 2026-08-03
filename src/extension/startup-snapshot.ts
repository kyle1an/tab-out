import { Effect, Result, Schema, Semaphore } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import type { ClosedTabEntry } from './closed-tabs.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { isPinnableDomain, normalizePinnedDomains } from './domain-pins.js'
import {
  DASHBOARD_LOCAL_STORAGE_KEYS,
  sameDashboardLocalState,
  validDashboardLocalStateFromStorage,
  type DashboardLocalState
} from './dashboard-local-state.js'
import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import {
  DashboardDataBuildError,
  buildDashboardDataFromTabsEffect
} from './render.js'
import { normalizeTabHistorySnapshot } from './tab-history.js'
import { runPromiseExclusiveEffect } from './promise-exclusive-effect.js'
import {
  parseCachedDashboardLocalState,
  parseCachedDashboardStartupBoundary,
  parseCachedDashboardStartupViewModel,
  type CachedDashboardStartupBoundary,
  type DashboardStartupViewModel
} from './startup-snapshot-schema.js'
import { buildWorkingSetSnapshot, pageIdentityForWorkingSet } from './working-set.js'
import { normalizeWorkingSetSnapshot } from './working-set-client.js'
import type { SavedPageMetadataUpdates, SavedPagesStore } from './saved-pages.js'
import type { DashboardData, DashboardTab, DomainGroup, TabHistorySnapshot, WorkingSetActivityStore, WorkingSetSnapshot } from './types'

export type { DashboardStartupViewModel } from './startup-snapshot-schema.js'
export type DashboardStartupSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
  closedTabs: readonly ClosedTabEntry[]
  startupViewModel?: DashboardStartupViewModel
}
export type CachedDashboardStartup = {
  snapshot: DashboardStartupSnapshot
  localState: DashboardLocalState | null
}
export type CachedDashboardStartupLoadResult = {
  ok: boolean
  value: CachedDashboardStartup | null
}
type CachedDashboardStartupSnapshot = CachedDashboardStartupBoundary
type SaveCachedDashboardStartupOptions = {
  buildStartupViewModel?: (snapshot: DashboardStartupSnapshot, localState: DashboardLocalState | null) => DashboardStartupViewModel
  captureStartedAt?: number
  durableCheckpointIntervalMs?: number
  now?: number
  scheduleDurableCheckpoint?: (when: number) => Promise<void> | void
}

// Everything cached under this key crosses chrome.storage, which is JSON-only:
// Maps/Sets/Dates silently degrade ({} / {} / string) and revive wrong, so the
// snapshot and its startupViewModel must stay plain JSON data (records, arrays,
// primitives — see the title-suppression tone records). Bump the :vN suffix
// whenever the cached shape changes in a way the readers below cannot digest;
// old-version entries are simply never read again and age out.
export const DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY = 'tab-out:startup-snapshot:v1'
// How long the first-paint Working Set priority stays frozen across reopens before the next
// live hydration adopts a fresh Working Set. Longer keeps chip/section ordering stable across
// reopens at the cost of staler prioritization; capped in practice by the browser session
// because chrome.storage.session clears on restart.
export const DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS = 30 * 60_000
// Durable Checkpoint cap. chrome.storage.session is cleared on browser restart, so the
// source-only chrome.storage.local copy lets the first open after a restart derive the last
// checkpointed grouping before live hydration; a long-abandoned checkpoint is not shown.
export const DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS = 7 * 24 * 60 * 60_000
const DASHBOARD_STARTUP_SNAPSHOT_CACHE_WRITE_LOCK = 'tab-out:startup-snapshot-cache-write'

export class StartupSnapshotCacheMutationError extends Schema.TaggedErrorClass<StartupSnapshotCacheMutationError>()(
  'StartupSnapshotCacheMutationError',
  { cause: Schema.Defect() }
) {}

const startupSnapshotCacheMutationSemaphore = Semaphore.makeUnsafe(1)

// performance.timeOrigin + performance.now() is comparable across extension pages and the
// service worker while retaining more ordering precision than Date.now(). Callers capture it
// before reading browser state, then carry it through the eventual cache write.
export function captureDashboardStartupSnapshotStartedAt(): number {
  const monotonicEpoch = typeof performance === 'undefined'
    ? Number.NaN
    : performance.timeOrigin + performance.now()
  return Number.isFinite(monotonicEpoch) ? monotonicEpoch : Date.now()
}

function startupSnapshotCacheStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.session || null
}

function startupSnapshotDurableStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.local || null
}

export function applyPinnedDomainsToDashboardGroups(
  groups: readonly DomainGroup[],
  pinnedDomains: readonly string[]
): DomainGroup[] {
  const originalOrder = new Map(groups.map((group, index) => [group.domain, index]))
  const pinnedOrder = new Map(
    normalizePinnedDomains(pinnedDomains).map((domain, index) => [domain, index])
  )
  return groups
    .map((group) => {
      const pinned = isPinnableDomain(group.domain) && pinnedOrder.has(group.domain)
      return group.pinned === pinned ? group : { ...group, pinned }
    })
    .sort((left, right) => {
      if (!!left.pinned !== !!right.pinned) return left.pinned ? -1 : 1
      if (left.pinned && right.pinned) {
        return (pinnedOrder.get(left.domain) ?? 0) - (pinnedOrder.get(right.domain) ?? 0)
      }
      return (originalOrder.get(left.domain) ?? 0) - (originalOrder.get(right.domain) ?? 0)
    })
}

function applyPinnedDomainsToCachedDashboard(
  dashboard: DashboardData,
  pinnedDomains: readonly string[]
): DashboardData {
  return {
    ...dashboard,
    domainGroups: applyPinnedDomainsToDashboardGroups(dashboard.domainGroups, pinnedDomains),
    ...(Array.isArray(dashboard.bookmarkDomainGroups)
      ? { bookmarkDomainGroups: applyPinnedDomainsToDashboardGroups(dashboard.bookmarkDomainGroups, pinnedDomains) }
      : {}),
    ...(Array.isArray(dashboard.historyDomainGroups)
      ? { historyDomainGroups: applyPinnedDomainsToDashboardGroups(dashboard.historyDomainGroups, pinnedDomains) }
      : {})
  }
}

function filterCachedWorkingSetToOpenDashboardTabs(workingSet: WorkingSetSnapshot, dashboard: DashboardData): WorkingSetSnapshot {
  const openKeys = new Set(
    dashboard.realTabs
      .filter((tab) => !isClosedSavedDashboardTab(tab))
      .map((tab) => pageIdentityForWorkingSet(tab?.url || tab?.rawUrl || ''))
      .filter(Boolean)
  )
  return {
    ...workingSet,
    items: workingSet.items.filter((item) => {
      const key = pageIdentityForWorkingSet(item.key) || pageIdentityForWorkingSet(item.tabUrl)
      return !!key && openKeys.has(key)
    })
  }
}

type StartupSnapshotCacheRead =
  | { ok: true; cached: CachedDashboardStartupSnapshot | null }
  | { ok: false; cached: null }

function readStartupSnapshotCacheForMutationEffect(
  storage: chrome.storage.StorageArea | null
): Effect.Effect<StartupSnapshotCacheRead> {
  if (!storage) return Effect.succeed({ ok: true, cached: null })
  return Effect.tryPromise({
    try: () => storage.get(DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY),
    catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
  }).pipe(
    Effect.flatMap((stored) => Effect.try({
      try: (): StartupSnapshotCacheRead => ({
        ok: true,
        cached: parseCachedDashboardStartupBoundary(
          stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
        )
      }),
      catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
    })),
    // A failed read makes the generation of the existing cache unknown. Do not
    // risk replacing a newer value whose comparison could not be performed.
    Effect.catchTag('StartupSnapshotCacheMutationError', () => Effect.succeed({
      ok: false,
      cached: null
    }))
  )
}

function cachedStartupWorkingSetForSave(cached: CachedDashboardStartupSnapshot | null, now: number): { workingSet: WorkingSetSnapshot; savedAt: number } | null {
  if (!cached) return null
  const savedAt = typeof cached.workingSetSavedAt === 'number' ? cached.workingSetSavedAt : cached.savedAt
  if (now - savedAt > DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS) return null
  return {
    workingSet: normalizeWorkingSetSnapshot(cached.snapshot.workingSet),
    savedAt
  }
}

function cachedCaptureStartedAt(cached: CachedDashboardStartupSnapshot | null): number | null {
  if (!cached) return null
  return typeof cached.captureStartedAt === 'number' && Number.isFinite(cached.captureStartedAt)
    ? cached.captureStartedAt
    : cached.savedAt
}

const runStartupSnapshotCacheMutation = Effect.fn('startupSnapshotCache.mutate')(function*<
  Value,
  Failure,
  Requirements
>(
  mutation: Effect.Effect<Value, Failure, Requirements>
) {
  const guardedMutation = mutation.pipe(
    Effect.catchDefect((cause) => Effect.fail(
      StartupSnapshotCacheMutationError.make({ cause })
    ))
  )
  return yield* startupSnapshotCacheMutationSemaphore.withPermit(
    runPromiseExclusiveEffect(
      (task) => navigator.locks.request(
        DASHBOARD_STARTUP_SNAPSHOT_CACHE_WRITE_LOCK,
        task
      ),
      guardedMutation,
      (cause) => StartupSnapshotCacheMutationError.make({ cause })
    )
  )
})

type HydratedCachedDashboardStartup = {
  cached: CachedDashboardStartupSnapshot
  startup: CachedDashboardStartup
}

type CachedDashboardStartupStorageRead = {
  ok: boolean
  startup: HydratedCachedDashboardStartup | null
  liveLocalState: DashboardLocalState | null
}

function readCachedDashboardStartupEffect(
  storage: chrome.storage.StorageArea | null,
  maxAgeMs: number | null,
  now: number,
  includeLocalStateKeys = false
): Effect.Effect<CachedDashboardStartupStorageRead> {
  if (!storage) return Effect.succeed({ ok: true, startup: null, liveLocalState: null })
  return Effect.tryPromise({
    try: () => storage.get(includeLocalStateKeys
      ? [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, ...DASHBOARD_LOCAL_STORAGE_KEYS]
      : DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY),
    catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
  }).pipe(
    Effect.flatMap((stored) => Effect.try({
      try: (): CachedDashboardStartupStorageRead => {
        const liveLocalState = includeLocalStateKeys
          ? validDashboardLocalStateFromStorage(stored)
          : null
        const cached = parseCachedDashboardStartupBoundary(
          stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
        )
        if (!cached) return { ok: true, startup: null, liveLocalState }
        if (maxAgeMs != null && now - cached.savedAt > maxAgeMs) {
          return { ok: true, startup: null, liveLocalState }
        }
        const { startupViewModel: rawStartupViewModel, ...snapshot } = cached.snapshot
        const cachedLocalState = parseCachedDashboardLocalState(cached.localState)
        const startupViewModel = parseCachedDashboardStartupViewModel(rawStartupViewModel)
        const dashboard = snapshot.dashboard
        const workingSet = filterCachedWorkingSetToOpenDashboardTabs(
          normalizeWorkingSetSnapshot(snapshot.workingSet),
          dashboard
        )
        return {
          ok: true,
          startup: {
            cached,
            startup: {
              snapshot: {
                ...snapshot,
                dashboard,
                tabHistory: normalizeTabHistorySnapshot(snapshot.tabHistory),
                workingSet,
                ...(startupViewModel ? { startupViewModel } : {})
              },
              localState: cachedLocalState
            }
          },
          liveLocalState
        }
      },
      catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
    })),
    Effect.catchTag('StartupSnapshotCacheMutationError', () => Effect.succeed({
      ok: false,
      startup: null,
      liveLocalState: null
    }))
  )
}

function applyLiveDashboardLocalState(
  hydrated: HydratedCachedDashboardStartup,
  liveLocalState: DashboardLocalState | null
): CachedDashboardStartup {
  if (!liveLocalState) return hydrated.startup

  const { startupViewModel, ...snapshot } = hydrated.startup.snapshot
  const matchingStartupViewModel = startupViewModel && sameDashboardLocalState({
    loaded: true,
    pinnedDomains: [...startupViewModel.pinnedDomains],
    pinnedSectionIds: [...startupViewModel.pinnedSectionIds],
    pinnedPageChipIds: [...startupViewModel.pinnedPageChipIds]
  }, liveLocalState)
    ? startupViewModel
    : undefined
  const dashboard = applyPinnedDomainsToCachedDashboard(snapshot.dashboard, liveLocalState.pinnedDomains)
  return {
    snapshot: {
      ...snapshot,
      dashboard,
      ...(matchingStartupViewModel ? { startupViewModel: matchingStartupViewModel } : {})
    },
    localState: liveLocalState
  }
}

export const loadCachedDashboardStartupResultEffect = Effect.fn(
  'startupSnapshotCache.load'
)(function*(now = Date.now()) {
  // Read and validate both representations so an older render-ready Warm Snapshot cannot mask
  // a newer source-only Durable Checkpoint. For an equal generation, prefer whichever copy has
  // a valid derived view model, then prefer session because it is the normal render-ready tier.
  const [sessionRead, durableRead] = yield* Effect.all([
    readCachedDashboardStartupEffect(startupSnapshotCacheStorage(), null, now),
    readCachedDashboardStartupEffect(
      startupSnapshotDurableStorage(),
      DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS,
      now,
      true
    )
  ], { concurrency: 'unbounded' })
  const sessionStartup = sessionRead.startup
  const durableStartup = durableRead.startup
  const sessionCaptureStartedAt = cachedCaptureStartedAt(sessionStartup?.cached ?? null) ?? Number.NEGATIVE_INFINITY
  const durableCaptureStartedAt = cachedCaptureStartedAt(durableStartup?.cached ?? null) ?? Number.NEGATIVE_INFINITY
  const selected = !sessionStartup
    ? durableStartup
    : !durableStartup
      ? sessionStartup
      : durableCaptureStartedAt > sessionCaptureStartedAt
        ? durableStartup
        : sessionCaptureStartedAt > durableCaptureStartedAt
          ? sessionStartup
          : durableStartup.startup.snapshot.startupViewModel && !sessionStartup.startup.snapshot.startupViewModel
            ? durableStartup
            : sessionStartup
  return {
    // If either representation failed, its generation is unknown. A selected value can
    // still warm the page, but the background must retry before treating cache
    // seeding as complete or overwriting that unknown representation.
    ok: sessionRead.ok && durableRead.ok,
    value: selected ? applyLiveDashboardLocalState(selected, durableRead.liveLocalState) : null
  }
})

export function loadCachedDashboardStartupResult(
  now = Date.now()
): Promise<CachedDashboardStartupLoadResult> {
  return getAppRuntime().runPromise(loadCachedDashboardStartupResultEffect(now))
}

export const loadCachedDashboardStartupEffect = Effect.fn(
  'startupSnapshotCache.loadValue'
)(function*(now = Date.now()) {
  return (yield* loadCachedDashboardStartupResultEffect(now)).value
})

export function loadCachedDashboardStartup(
  now = Date.now()
): Promise<CachedDashboardStartup | null> {
  return getAppRuntime().runPromise(loadCachedDashboardStartupEffect(now))
}

function writeStartupSnapshotCacheEffect(
  storage: chrome.storage.StorageArea | null,
  payload: CachedDashboardStartupSnapshot
): Effect.Effect<boolean> {
  if (!storage) return Effect.succeed(true)
  return Effect.gen(function*() {
    let fallbackPayload = payload
    const initialWrite = yield* Effect.result(Effect.tryPromise({
      try: () => storage.set({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: payload }),
      catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
    }))
    if (Result.isSuccess(initialWrite)) return true
    if (Result.isFailure(initialWrite)) {
      if (payload.snapshot.startupViewModel) {
        const { startupViewModel: _startupViewModel, ...snapshot } = payload.snapshot
        fallbackPayload = { ...payload, snapshot }
      }
    }
    // The compact retry handles both quota pressure from the render-ready view model and a
    // one-shot storage transport failure. If it also fails, the prior valid value stays intact.
    return Result.isSuccess(yield* Effect.result(Effect.tryPromise({
      try: () => storage.set({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: fallbackPayload }),
      catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
    })))
  })
}

function compactStartupSnapshotPayload(payload: CachedDashboardStartupSnapshot): CachedDashboardStartupSnapshot {
  const { startupViewModel: _startupViewModel, ...snapshot } = payload.snapshot
  return { ...payload, snapshot }
}

function durableCheckpointDueAt(
  durable: CachedDashboardStartupSnapshot | null,
  now: number,
  intervalMs: number
): number {
  const savedAt = durable?.savedAt
  if (savedAt === undefined || !Number.isFinite(savedAt) || now < savedAt) return now
  return Math.max(now, savedAt + intervalMs)
}

function rebaseCachedWorkingSetPriority(cached: WorkingSetSnapshot, live: WorkingSetSnapshot): WorkingSetSnapshot {
  const liveItemsByKey = new Map(live.items.map((item) => [item.key, item]))
  return {
    defaultLimit: cached.defaultLimit,
    expandedLimit: cached.expandedLimit,
    items: cached.items.flatMap((cachedItem) => {
      const liveItem = liveItemsByKey.get(cachedItem.key)
      if (!liveItem) return []
      return [{
        ...liveItem,
        score: cachedItem.score
      }]
    })
  }
}

function hashDashboardStartupContent(content: string): string {
  let hashA = 1_779_033_703
  let hashB = 3_144_134_277
  let hashC = 1_013_904_242
  let hashD = 2_773_480_762
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    hashA = hashB ^ Math.imul(hashA ^ code, 597_399_067)
    hashB = hashC ^ Math.imul(hashB ^ code, 2_869_860_233)
    hashC = hashD ^ Math.imul(hashC ^ code, 951_274_213)
    hashD = hashA ^ Math.imul(hashD ^ code, 2_716_044_179)
  }
  hashA = Math.imul(hashC ^ (hashA >>> 18), 597_399_067)
  hashB = Math.imul(hashD ^ (hashB >>> 22), 2_869_860_233)
  hashC = Math.imul(hashA ^ (hashC >>> 17), 951_274_213)
  hashD = Math.imul(hashB ^ (hashD >>> 19), 2_716_044_179)
  hashA ^= hashB ^ hashC ^ hashD
  hashB ^= hashA
  hashC ^= hashA
  hashD ^= hashA
  return [hashA, hashB, hashC, hashD]
    .map((hash) => (hash >>> 0).toString(16).padStart(8, '0'))
    .join('')
}

function dashboardStartupContentFingerprint(
  snapshot: DashboardStartupSnapshot,
  localState: DashboardLocalState | null
): string {
  const { startupViewModel: _startupViewModel, ...snapshotWithoutViewModel } = snapshot
  const semanticContent = JSON.stringify({
    snapshot: {
      ...snapshotWithoutViewModel,
      workingSet: {
        ...snapshot.workingSet,
        // Scores decay with wall time. Ordering and row content are visible semantics; a
        // score-only change must not create a new storage generation.
        items: snapshot.workingSet.items.map((item) => ({ ...item, score: 0 }))
      }
    },
    localState: localState?.loaded ? localState : null
  })
  return `semantic-v1:${semanticContent.length}:${hashDashboardStartupContent(semanticContent)}`
}

function cachedDashboardStartupContentFingerprint(cached: CachedDashboardStartupSnapshot): string {
  const { startupViewModel: _startupViewModel, ...snapshot } = cached.snapshot
  return cached.contentFingerprint ?? dashboardStartupContentFingerprint(
    {
      ...snapshot,
      tabHistory: normalizeTabHistorySnapshot(snapshot.tabHistory),
      workingSet: normalizeWorkingSetSnapshot(snapshot.workingSet)
    },
    parseCachedDashboardLocalState(cached.localState)
  )
}

export const saveCachedDashboardStartupSnapshotEffect = Effect.fn(
  'startupSnapshotCache.save'
)(function*(
  snapshot: DashboardStartupSnapshot,
  localState: DashboardLocalState | null,
  options: SaveCachedDashboardStartupOptions = {}
) {
  const now = options.now ?? Date.now()
  const requestedCaptureStartedAt = options.captureStartedAt ?? now
  const captureStartedAt = Number.isFinite(requestedCaptureStartedAt)
    ? requestedCaptureStartedAt
    : now
  const requestedDurableCheckpointIntervalMs = options.durableCheckpointIntervalMs ?? 0
  const durableCheckpointIntervalMs = Number.isFinite(requestedDurableCheckpointIntervalMs)
    ? Math.max(0, requestedDurableCheckpointIntervalMs)
    : 0

  yield* runStartupSnapshotCacheMutation(Effect.gen(function*() {
    const sessionStorage = startupSnapshotCacheStorage()
    const durableStorage = startupSnapshotDurableStorage()
    const [sessionCacheRead, durableCacheRead] = yield* Effect.all([
      readStartupSnapshotCacheForMutationEffect(sessionStorage),
      readStartupSnapshotCacheForMutationEffect(durableStorage)
    ], { concurrency: 'unbounded' })
    if (!sessionCacheRead.ok || !durableCacheRead.ok) return

    const existingCaptureStartedAt = Math.max(
      cachedCaptureStartedAt(sessionCacheRead.cached) ?? Number.NEGATIVE_INFINITY,
      cachedCaptureStartedAt(durableCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    )
    if (existingCaptureStartedAt > captureStartedAt) return

    // The freeze epoch is in-session, so preserve the previously cached Working Set priority
    // from the session copy only. Rebase those priorities onto the live rows so closed targets
    // disappear and mutable tab IDs/titles/state stay current; both copies receive that payload.
    const cachedWorkingSet = cachedStartupWorkingSetForSave(sessionCacheRead.cached, now)
    const cacheSnapshotBase = cachedWorkingSet
      ? { ...snapshot, workingSet: rebaseCachedWorkingSetPriority(cachedWorkingSet.workingSet, snapshot.workingSet) }
      : snapshot
    const contentFingerprint = dashboardStartupContentFingerprint(cacheSnapshotBase, localState)
    const sessionContentCurrent = sessionStorage === null ||
      sessionCacheRead.cached?.contentFingerprint === contentFingerprint
    const sessionRenderReady = sessionStorage === null || (
      sessionContentCurrent &&
      (options.buildStartupViewModel === undefined ||
        parseCachedDashboardStartupViewModel(sessionCacheRead.cached?.snapshot.startupViewModel) !== undefined)
    )
    const sessionWriteRequired = !sessionContentCurrent || !sessionRenderReady
    const durableContentCurrent = durableStorage === null || (
      durableCacheRead.cached?.contentFingerprint === contentFingerprint &&
      durableCacheRead.cached.snapshot.startupViewModel === undefined
    )
    if (!sessionWriteRequired && durableContentCurrent) return
    let startupViewModel: DashboardStartupViewModel | undefined
    if (sessionWriteRequired) {
      try {
        startupViewModel = options.buildStartupViewModel?.(cacheSnapshotBase, localState)
      } catch {}
    }
    const cacheSnapshot = {
      ...cacheSnapshotBase,
      ...(startupViewModel ? { startupViewModel } : {})
    }
    const payload: CachedDashboardStartupSnapshot = {
      savedAt: now,
      captureStartedAt,
      contentFingerprint,
      workingSetSavedAt: cachedWorkingSet?.savedAt ?? now,
      snapshot: cacheSnapshot,
      ...(localState?.loaded ? { localState } : {})
    }
    const compactPayload = compactStartupSnapshotPayload(payload)
    let sessionSourceForCheckpoint = sessionStorage === null
      ? compactPayload
      : sessionCacheRead.cached

    if (sessionWriteRequired) {
      const sessionWritten = yield* writeStartupSnapshotCacheEffect(sessionStorage, payload)
      if (sessionWritten) sessionSourceForCheckpoint = compactPayload
    }

    const durableMissing = durableStorage !== null && durableCacheRead.cached === null
    const durableWriteDue = !durableContentCurrent &&
      durableCheckpointDueAt(durableCacheRead.cached, now, durableCheckpointIntervalMs) <= now
    if (durableMissing || (durableWriteDue && !options.scheduleDurableCheckpoint)) {
      // Durable Checkpoints are deliberately source-only. A missing checkpoint is initialized
      // immediately; callers without an alarm scheduler retain the old synchronous behavior.
      const checkpointSource = !sessionWriteRequired && sessionSourceForCheckpoint
        ? compactStartupSnapshotPayload(sessionSourceForCheckpoint)
        : compactPayload
      yield* writeStartupSnapshotCacheEffect(
        durableStorage,
        { ...checkpointSource, savedAt: now }
      )
      return
    }

    if (!options.scheduleDurableCheckpoint || !sessionSourceForCheckpoint) return
    const sessionCaptureStartedAt = cachedCaptureStartedAt(sessionSourceForCheckpoint) ?? Number.NEGATIVE_INFINITY
    const durableCaptureStartedAt = cachedCaptureStartedAt(durableCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    const durableContentFingerprint = durableCacheRead.cached
      ? cachedDashboardStartupContentFingerprint(durableCacheRead.cached)
      : undefined
    const checkpointNeeded = !sessionContentCurrent &&
      sessionCaptureStartedAt >= durableCaptureStartedAt && (
      cachedDashboardStartupContentFingerprint(sessionSourceForCheckpoint) !== durableContentFingerprint ||
      durableCacheRead.cached?.snapshot.startupViewModel !== undefined
    )
    if (checkpointNeeded) {
      // Scheduling while holding the cache lock prevents an alarm promotion racing with this
      // save from leaving behind a clean-state alarm. The scheduler preserves an existing alarm.
      yield* Effect.tryPromise({
        try: async () => {
          await options.scheduleDurableCheckpoint?.(
            durableCheckpointDueAt(durableCacheRead.cached, now, durableCheckpointIntervalMs)
          )
        },
        catch: (cause) => StartupSnapshotCacheMutationError.make({ cause })
      })
    }
  }))
})

export function saveCachedDashboardStartupSnapshot(
  snapshot: DashboardStartupSnapshot,
  localState: DashboardLocalState | null,
  options: SaveCachedDashboardStartupOptions = {}
): Promise<void> {
  return getAppRuntime().runPromise(
    saveCachedDashboardStartupSnapshotEffect(snapshot, localState, options).pipe(
      Effect.catchTag(
        'StartupSnapshotCacheMutationError',
        (error) => Effect.fail(error.cause)
      )
    )
  )
}

export const promoteCachedDashboardStartupSnapshotEffect = Effect.fn(
  'startupSnapshotCache.promote'
)(function*(now = Date.now()) {
  return yield* runStartupSnapshotCacheMutation(Effect.gen(function*() {
    const sessionStorage = startupSnapshotCacheStorage()
    const durableStorage = startupSnapshotDurableStorage()
    const [sessionCacheRead, durableCacheRead] = yield* Effect.all([
      readStartupSnapshotCacheForMutationEffect(sessionStorage),
      readStartupSnapshotCacheForMutationEffect(durableStorage)
    ], { concurrency: 'unbounded' })
    if (!sessionCacheRead.ok || !durableCacheRead.ok || !sessionCacheRead.cached) return false

    const sessionCaptureStartedAt = cachedCaptureStartedAt(sessionCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    const durableCaptureStartedAt = cachedCaptureStartedAt(durableCacheRead.cached) ?? Number.NEGATIVE_INFINITY
    if (durableCaptureStartedAt > sessionCaptureStartedAt) return true

    const compactSessionPayload = compactStartupSnapshotPayload(sessionCacheRead.cached)
    const sessionContentFingerprint = cachedDashboardStartupContentFingerprint(compactSessionPayload)
    const durableCurrent = !!durableCacheRead.cached &&
      durableCacheRead.cached.contentFingerprint === sessionContentFingerprint &&
      durableCacheRead.cached.snapshot.startupViewModel === undefined
    if (durableCurrent) return true

    return yield* writeStartupSnapshotCacheEffect(durableStorage, {
      ...compactSessionPayload,
      savedAt: now,
      contentFingerprint: sessionContentFingerprint
    })
  }))
})

export function promoteCachedDashboardStartupSnapshot(
  now = Date.now()
): Promise<boolean> {
  return getAppRuntime().runPromise(
    promoteCachedDashboardStartupSnapshotEffect(now).pipe(
      Effect.catchTag(
        'StartupSnapshotCacheMutationError',
        (error) => Effect.fail(error.cause)
      )
    )
  )
}

export type TabsStartupSnapshotInputs = {
  dashboardTabs: DashboardTab[]
  currentWindowId: number | null
  tabHistory: TabHistorySnapshot
  workingSetActivity: WorkingSetActivityStore
  savedPagesStore: SavedPagesStore
  closedTabs: readonly ClosedTabEntry[]
  pinnedDomains: string[]
  tabPreviousOrder?: Map<string, number>
}

export type TabsStartupSnapshotBuild = {
  snapshot: DashboardStartupSnapshot
  savedPageUpdates: SavedPageMetadataUpdates
}

// Build the unfiltered Tabs-source startup snapshot from already-gathered inputs. Shared by the
// page (which gathers via chrome.* fetchers / service messaging) and the service worker (which
// has the same data directly), so both produce an identical snapshot and hydration cannot shift.
// The build is pure: only page-side callers persist the returned savedPageUpdates.
export const buildTabsDashboardStartupSnapshotEffect = Effect.fn(
  'startupSnapshot.buildFromTabs'
)(function*(inputs: TabsStartupSnapshotInputs) {
  const { dashboard, savedPageUpdates } = yield* buildDashboardDataFromTabsEffect(inputs.dashboardTabs, inputs.currentWindowId, inputs.tabPreviousOrder ?? new Map(), {
    pinnedDomains: inputs.pinnedDomains,
    bookmarkPreviousOrder: new Map(),
    historyPreviousOrder: new Map(),
    includeBookmarkMatches: false,
    includeHistoryMatches: false,
    searchQuery: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    savedPagesStore: inputs.savedPagesStore
  })
  return yield* Effect.try({
    try: (): TabsStartupSnapshotBuild => {
      const workingSet = buildWorkingSetSnapshot({
        tabs: inputs.dashboardTabs,
        activity: inputs.workingSetActivity,
        currentWindowId: inputs.currentWindowId
      })
      return {
        snapshot: { dashboard, tabHistory: inputs.tabHistory, workingSet, closedTabs: inputs.closedTabs },
        savedPageUpdates
      }
    },
    catch: (cause) => DashboardDataBuildError.make({ cause })
  })
})

export function buildTabsDashboardStartupSnapshot(
  inputs: TabsStartupSnapshotInputs
): Promise<TabsStartupSnapshotBuild> {
  return getAppRuntime().runPromise(
    buildTabsDashboardStartupSnapshotEffect(inputs).pipe(
      Effect.catchTag('DashboardDataBuildError', (error) => Effect.fail(error.cause))
    )
  )
}
