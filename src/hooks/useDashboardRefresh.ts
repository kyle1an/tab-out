import { useEffect, useRef } from 'react'
import { fetchClosedTabs, isClosedTabFetchSuppressed, type ClosedTabEntry } from '../extension/closed-tabs.js'
import { registerDashboardRefresh } from '../extension/dashboard-controller.js'
import { fetchDashboardServiceState } from '../extension/dashboard-service-state.js'
import { buildFilterSearchRequest, dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { buildDashboardDataFromTabs, fetchDashboardData, getCurrentWindowId } from '../extension/render.js'
import { fetchTabHistorySnapshot, normalizeTabHistorySnapshot } from '../extension/tab-history.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs } from '../extension/tabs.js'
import { buildWorkingSetSnapshot } from '../extension/working-set.js'
import { fetchWorkingSetSnapshot, normalizeWorkingSetSnapshot } from '../extension/working-set-client.js'
import { loadSavedPagesStore, type SavedPagesStore } from '../extension/saved-pages.js'
import type { DashboardLocalState } from './useDashboardLocalState'
import type { DashboardData, DashboardSource, TabHistorySnapshot, WorkingSetSnapshot } from '../extension/types'

export type RefreshOptions = { animateCards?: boolean; startupSnapshot?: boolean }
export type MissionOrderMap = Record<DashboardSource, Map<string, number>>

type DashboardSnapshotOptions = {
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  localState?: DashboardLocalState | null
  savedPagesStore?: SavedPagesStore
  previousOrder: MissionOrderMap
}
export type DashboardStartupSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
  closedTabs: readonly ClosedTabEntry[]
}
type DashboardRefreshSnapshot = {
  dashboard: DashboardData
  tabHistory: TabHistorySnapshot
  workingSet: WorkingSetSnapshot
}
type CachedDashboardStartupSnapshot = {
  savedAt: number
  workingSetSavedAt?: number
  snapshot: DashboardStartupSnapshot
  localState?: DashboardLocalState
}
export type CachedDashboardStartup = {
  snapshot: DashboardStartupSnapshot
  localState: DashboardLocalState | null
}

type UseDashboardRefreshOptions = DashboardSnapshotOptions & {
  dashboard: DashboardData | null
  localStateLoaded: boolean
  localState: DashboardLocalState | null
  setDashboard: (dashboard: DashboardData | null) => void
  setStartupSnapshot: (snapshot: DashboardStartupSnapshot) => void
  setTabHistory: (tabHistory: TabHistorySnapshot | null) => void
  setWorkingSet: (workingSet: WorkingSetSnapshot | null) => void
  onBeforeAnimatedRefresh?: () => void
  onBeforePinnedRefresh?: () => void
}

export const DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY = 'tab-out:startup-snapshot:v1'
const DASHBOARD_STARTUP_SNAPSHOT_CACHE_TTL_MS = 60_000
let startupSnapshotFlight: { key: string; promise: Promise<DashboardStartupSnapshot> } | null = null

function startupSnapshotCacheStorage(): chrome.storage.StorageArea | null {
  return typeof chrome === 'undefined' ? null : chrome.storage?.session || null
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

async function cachedStartupWorkingSetForSave(storage: chrome.storage.StorageArea, now: number): Promise<{ workingSet: WorkingSetSnapshot; savedAt: number } | null> {
  try {
    const stored = await storage.get(DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY)
    const cached = stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
    if (!isCachedDashboardStartupSnapshot(cached)) return null
    const savedAt = typeof cached.workingSetSavedAt === 'number' ? cached.workingSetSavedAt : cached.savedAt
    if (now - savedAt > DASHBOARD_STARTUP_SNAPSHOT_CACHE_TTL_MS) return null
    return {
      workingSet: normalizeWorkingSetSnapshot(cached.snapshot.workingSet),
      savedAt
    }
  } catch {
    return null
  }
}

export async function loadCachedDashboardStartup(): Promise<CachedDashboardStartup | null> {
  const storage = startupSnapshotCacheStorage()
  if (!storage) return null
  try {
    const stored = await storage.get(DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY)
    const cached = stored[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
    if (!isCachedDashboardStartupSnapshot(cached)) return null
    // chrome.storage.session is cleared on browser restart, so any structurally valid
    // snapshot belongs to the current session and is safe to paint immediately; live
    // hydration replaces it within the same load. A display-side freshness TTL here only
    // forces an empty-to-populated first paint when Tab Out is reopened slower than it.
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

export async function loadCachedDashboardStartupSnapshot(): Promise<DashboardStartupSnapshot | null> {
  return (await loadCachedDashboardStartup())?.snapshot ?? null
}

async function saveCachedDashboardStartupSnapshot(snapshot: DashboardStartupSnapshot, localState: DashboardLocalState | null, now = Date.now()): Promise<void> {
  const storage = startupSnapshotCacheStorage()
  if (!storage) return
  const cachedWorkingSet = await cachedStartupWorkingSetForSave(storage, now)
  const cacheSnapshot = cachedWorkingSet ? { ...snapshot, workingSet: cachedWorkingSet.workingSet } : snapshot
  try {
    await storage.set({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: { savedAt: now, workingSetSavedAt: cachedWorkingSet?.savedAt ?? now, snapshot: cacheSnapshot, ...(localState?.loaded ? { localState } : {}) } })
  } catch {}
}

function startupSnapshotFlightKey({ source, filter, historyRange, historyFilterEnabled, pinnedDomains }: DashboardSnapshotOptions): string {
  return JSON.stringify({
    source,
    filter,
    historyRange,
    historyFilterEnabled,
    pinnedDomains
  })
}

async function fetchTabsDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, savedPagesStore, previousOrder }: DashboardSnapshotOptions): Promise<DashboardRefreshSnapshot> {
  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [openTabs, currentWindowId, serviceState, resolvedSavedPagesStore] = await Promise.all([
    fetchOpenTabsSnapshot(),
    getCurrentWindowId(),
    fetchDashboardServiceState(),
    savedPagesStore ? Promise.resolve(savedPagesStore) : loadSavedPagesStore()
  ])
  const dashboardTabs = getDashboardTabsFromOpenTabs(openTabs)
  const dashboard = await buildDashboardDataFromTabs(dashboardTabs, currentWindowId, previousOrder[source] || new Map(), {
    pinnedDomains,
    bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
    historyPreviousOrder: previousOrder.history || new Map(),
    includeBookmarkMatches: filterSearch.includeBookmarkMatches,
    includeHistoryMatches: filterSearch.includeHistoryMatches,
    searchQuery: filterSearch.query,
    historyRange: filterSearch.historyRange,
    savedPagesStore: resolvedSavedPagesStore
  })
  const workingSet = buildWorkingSetSnapshot({
    tabs: dashboardTabs,
    activity: serviceState.workingSetActivity,
    currentWindowId
  })

  return { dashboard, tabHistory: serviceState.tabHistory, workingSet }
}

export async function fetchDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder }: DashboardSnapshotOptions): Promise<DashboardRefreshSnapshot> {
  if (source === 'tabs') {
    return fetchTabsDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, previousOrder })
  }

  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [dashboard, tabHistory, workingSet] = await Promise.all([
    fetchDashboardData(previousOrder[source] || new Map(), source, {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange
    }),
    fetchTabHistorySnapshot(),
    fetchWorkingSetSnapshot()
  ])

  return { dashboard, tabHistory, workingSet }
}

async function fetchDashboardStartupSnapshotOnce(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const closedTabsPromise = isClosedTabFetchSuppressed() ? Promise.resolve([]) : fetchClosedTabs()
  const [snapshot, closedTabs] = await Promise.all([
    fetchTabsDashboardSnapshot(options),
    closedTabsPromise
  ])
  return { ...snapshot, closedTabs }
}

export async function fetchDashboardStartupSnapshot(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const key = startupSnapshotFlightKey(options)
  if (startupSnapshotFlight?.key === key) return startupSnapshotFlight.promise

  const promise = fetchDashboardStartupSnapshotOnce(options)
  startupSnapshotFlight = { key, promise }
  try {
    const snapshot = await promise
    void saveCachedDashboardStartupSnapshot(snapshot, options.localState ?? null)
    return snapshot
  } finally {
    if (startupSnapshotFlight?.promise === promise) startupSnapshotFlight = null
  }
}

export function useDashboardRefresh({
  dashboard,
  source,
  filter,
  historyRange,
  historyFilterEnabled,
  pinnedDomains,
  localStateLoaded,
  localState,
  previousOrder,
  setDashboard,
  setStartupSnapshot,
  setTabHistory,
  setWorkingSet,
  onBeforeAnimatedRefresh,
  onBeforePinnedRefresh
}: UseDashboardRefreshOptions) {
  const callbacksRef = useRef({ onBeforeAnimatedRefresh, onBeforePinnedRefresh })
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => {})
  const startupRefreshPendingRef = useRef(false)
  const animatedRefreshPendingRef = useRef(false)

  useEffect(() => {
    callbacksRef.current = { onBeforeAnimatedRefresh, onBeforePinnedRefresh }
  }, [onBeforeAnimatedRefresh, onBeforePinnedRefresh])

  refreshRef.current = async ({ animateCards = false, startupSnapshot = false }: RefreshOptions = {}) => {
    if (startupSnapshot) startupRefreshPendingRef.current = true
    if (animateCards) animatedRefreshPendingRef.current = true
    if (document.visibilityState !== 'visible') return
    if (!localStateLoaded) return
    const shouldAnimate = animatedRefreshPendingRef.current
    if (shouldAnimate) callbacksRef.current.onBeforeAnimatedRefresh?.()
    if (source === 'tabs' && (!dashboard || startupRefreshPendingRef.current)) {
      const nextStartup = await fetchDashboardStartupSnapshot({
        source,
        filter,
        historyRange,
        historyFilterEnabled,
        pinnedDomains,
        localState,
        previousOrder
      })
      startupRefreshPendingRef.current = false
      animatedRefreshPendingRef.current = false
      setStartupSnapshot(nextStartup)
      return
    }
    const next = await fetchDashboardSnapshot({
      source,
      filter,
      historyRange,
      historyFilterEnabled,
      pinnedDomains,
      previousOrder
    })
    animatedRefreshPendingRef.current = false
    setDashboard(next.dashboard)
    setTabHistory(next.tabHistory)
    setWorkingSet(next.workingSet)
  }

  useEffect(() => registerDashboardRefresh((options?: RefreshOptions) => refreshRef.current(options)), [])

  useEffect(() => {
    if (!localStateLoaded || !dashboardNeedsFilterSearchRefresh(dashboard, { source, filter, historyRange, historyFilterEnabled })) return
    const frame = requestAnimationFrame(() => refreshRef.current())
    return () => cancelAnimationFrame(frame)
  }, [dashboard, filter, historyRange, historyFilterEnabled, localStateLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (!localStateLoaded) return
    callbacksRef.current.onBeforePinnedRefresh?.()
    requestAnimationFrame(() => refreshRef.current())
  }, [pinnedDomains, localStateLoaded])

  return (options?: RefreshOptions) => refreshRef.current(options)
}
