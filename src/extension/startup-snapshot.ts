import type { ClosedTabEntry } from './closed-tabs.js'
import { DEFAULT_HISTORY_RANGE } from './history-source.js'
import { buildDashboardDataFromTabs } from './render.js'
import { normalizeTabHistorySnapshot } from './tab-history.js'
import { buildWorkingSetSnapshot } from './working-set.js'
import { normalizeWorkingSetSnapshot } from './working-set-client.js'
import type { SavedPagesStore } from './saved-pages.js'
import type { DashboardData, DashboardTab, TabHistorySnapshot, WorkingSetActivityStore, WorkingSetSnapshot } from './types'
import type { DashboardLocalState } from '../hooks/useDashboardLocalState'

export type DashboardStartupSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
  closedTabs: readonly ClosedTabEntry[]
}
export type CachedDashboardStartup = {
  snapshot: DashboardStartupSnapshot
  localState: DashboardLocalState | null
}
type CachedDashboardStartupSnapshot = {
  savedAt: number
  workingSetSavedAt?: number
  snapshot: DashboardStartupSnapshot
  localState?: DashboardLocalState
}

export const DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY = 'tab-out:startup-snapshot:v1'
// How long the first-paint Working Set priority stays frozen across reopens before the next
// live hydration adopts a fresh Working Set. Longer keeps chip/section ordering stable across
// reopens at the cost of staler prioritization; capped in practice by the browser session
// because chrome.storage.session clears on restart.
export const DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS = 30 * 60_000
// Durable mirror cap. chrome.storage.session is cleared on browser restart, so the durable
// chrome.storage.local copy lets the first open after a restart paint warm with the last
// session's config-grouped snapshot; a long-abandoned snapshot past this cap is not shown.
export const DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS = 7 * 24 * 60 * 60_000

function startupSnapshotCacheStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.session || null
}

function startupSnapshotDurableStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.local || null
}

// The service worker has no `window` and cannot run function-based LOCAL_PATH_GROUPERS, so the
// page records whether any are active. When set, the worker defers grouping to the page-written
// cache instead of writing a snapshot that would group differently and shift on hydration. Stored
// durably so the decision survives a browser restart before any page has run this session.
export const LOCAL_PATH_GROUPERS_ACTIVE_KEY = 'tab-out:local-path-groupers-active'

export async function persistLocalPathGroupersActive(active: boolean): Promise<void> {
  const storage = startupSnapshotDurableStorage()
  if (!storage) return
  try {
    await storage.set({ [LOCAL_PATH_GROUPERS_ACTIVE_KEY]: active })
  } catch {}
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isDashboardStartupSnapshot(value: unknown): value is DashboardStartupSnapshot {
  if (!isObject(value) || !isObject(value.dashboard)) return false
  return (
    Array.isArray(value.dashboard.realTabs) &&
    Array.isArray(value.dashboard.domainGroups) &&
    (value.tabHistory == null || isObject(value.tabHistory)) &&
    (value.workingSet == null || isObject(value.workingSet)) &&
    Array.isArray(value.closedTabs)
  )
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : null
}

function cachedDashboardLocalState(value: unknown): DashboardLocalState | null {
  if (!isObject(value) || value.loaded !== true) return null
  const pinnedDomains = stringArray(value.pinnedDomains)
  const pinnedSectionIds = stringArray(value.pinnedSectionIds)
  const pinnedPageChipIds = stringArray(value.pinnedPageChipIds)
  if (!pinnedDomains || !pinnedSectionIds || !pinnedPageChipIds) return null
  return {
    loaded: true,
    pinnedDomains,
    pinnedSectionIds,
    pinnedPageChipIds
  }
}

function isCachedDashboardStartupSnapshot(value: unknown): value is CachedDashboardStartupSnapshot {
  return isObject(value) && typeof value.savedAt === 'number' && isDashboardStartupSnapshot(value.snapshot)
}

async function cachedStartupWorkingSetForSave(storage: chrome.storage.StorageArea | null, now: number): Promise<{ workingSet: WorkingSetSnapshot; savedAt: number } | null> {
  if (!storage) return null
  try {
    const stored = await storage.get(DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY)
    const cached = stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
    if (!isCachedDashboardStartupSnapshot(cached)) return null
    const savedAt = typeof cached.workingSetSavedAt === 'number' ? cached.workingSetSavedAt : cached.savedAt
    if (now - savedAt > DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS) return null
    return {
      workingSet: normalizeWorkingSetSnapshot(cached.snapshot.workingSet),
      savedAt
    }
  } catch {
    return null
  }
}

async function readCachedDashboardStartup(storage: chrome.storage.StorageArea | null, maxAgeMs: number | null, now: number): Promise<CachedDashboardStartup | null> {
  if (!storage) return null
  try {
    const stored = await storage.get(DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY)
    const cached = stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
    if (!isCachedDashboardStartupSnapshot(cached)) return null
    if (maxAgeMs != null && now - cached.savedAt > maxAgeMs) return null
    return {
      snapshot: {
        ...cached.snapshot,
        tabHistory: normalizeTabHistorySnapshot(cached.snapshot.tabHistory),
        workingSet: normalizeWorkingSetSnapshot(cached.snapshot.workingSet)
      },
      localState: cachedDashboardLocalState(cached.localState)
    }
  } catch {
    return null
  }
}

export async function loadCachedDashboardStartup(now = Date.now()): Promise<CachedDashboardStartup | null> {
  // Prefer the in-session snapshot: written this session and shown regardless of age, since
  // chrome.storage.session is cleared on browser restart so it can never outlive the session.
  const sessionStartup = await readCachedDashboardStartup(startupSnapshotCacheStorage(), null, now)
  if (sessionStartup) return sessionStartup
  // Fall back to the durable snapshot so the first open after a restart still paints warm.
  return readCachedDashboardStartup(startupSnapshotDurableStorage(), DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS, now)
}

export async function loadCachedDashboardStartupSnapshot(now = Date.now()): Promise<DashboardStartupSnapshot | null> {
  return (await loadCachedDashboardStartup(now))?.snapshot ?? null
}

async function writeStartupSnapshotCache(storage: chrome.storage.StorageArea | null, payload: CachedDashboardStartupSnapshot): Promise<void> {
  if (!storage) return
  try {
    await storage.set({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: payload })
  } catch {}
}

export async function saveCachedDashboardStartupSnapshot(snapshot: DashboardStartupSnapshot, localState: DashboardLocalState | null, now = Date.now()): Promise<void> {
  // The freeze epoch is in-session, so preserve the previously cached Working Set priority
  // from the session copy only; both copies then receive the same payload.
  const cachedWorkingSet = await cachedStartupWorkingSetForSave(startupSnapshotCacheStorage(), now)
  const cacheSnapshot = cachedWorkingSet ? { ...snapshot, workingSet: cachedWorkingSet.workingSet } : snapshot
  const payload: CachedDashboardStartupSnapshot = {
    savedAt: now,
    workingSetSavedAt: cachedWorkingSet?.savedAt ?? now,
    snapshot: cacheSnapshot,
    ...(localState?.loaded ? { localState } : {})
  }
  await writeStartupSnapshotCache(startupSnapshotCacheStorage(), payload)
  await writeStartupSnapshotCache(startupSnapshotDurableStorage(), payload)
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

// Build the unfiltered Tabs-source startup snapshot from already-gathered inputs. Shared by the
// page (which gathers via chrome.* fetchers / service messaging) and the service worker (which
// has the same data directly), so both produce an identical snapshot and hydration cannot shift.
export async function buildTabsDashboardStartupSnapshot(inputs: TabsStartupSnapshotInputs): Promise<DashboardStartupSnapshot> {
  const dashboard = await buildDashboardDataFromTabs(inputs.dashboardTabs, inputs.currentWindowId, inputs.tabPreviousOrder ?? new Map(), {
    pinnedDomains: inputs.pinnedDomains,
    bookmarkPreviousOrder: new Map(),
    historyPreviousOrder: new Map(),
    includeBookmarkMatches: false,
    includeHistoryMatches: false,
    searchQuery: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    savedPagesStore: inputs.savedPagesStore
  })
  const workingSet = buildWorkingSetSnapshot({
    tabs: inputs.dashboardTabs,
    activity: inputs.workingSetActivity,
    currentWindowId: inputs.currentWindowId
  })
  return { dashboard, tabHistory: inputs.tabHistory, workingSet, closedTabs: inputs.closedTabs }
}
