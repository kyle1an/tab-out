/* ================================================================
   Dashboard Intake — the page's fetch orchestration for arriving
   Dashboard state (ADR 0007).

   This module is UI-free: it gathers browser and service state, runs
   the pure Dashboard builds, and acts as the page-side single writer
   for the Saved Page metadata refresh those builds return. The React
   layer consumes it through useDashboardRefresh until the intake
   store lands.
   ================================================================ */

import { fetchClosedTabsResult, isClosedTabFetchSuppressed } from './closed-tabs.js'
import type { BrowserReadResult } from './browser-tabs-gateway.js'
import { fetchDashboardServiceStateResult } from './dashboard-service-state.js'
import { buildFilterSearchRequest } from './filter-search.js'
import { buildDashboardDataFromTabs, fetchDashboardData, getCurrentWindowIdResult } from './render.js'
import { fetchOpenTabsSnapshotResult, getDashboardTabsFromOpenTabs } from './tabs.js'
import { buildWorkingSetSnapshot } from './working-set.js'
import { loadSavedPagesStoreResult, persistSavedPageMetadataUpdates, type SavedPagesStore } from './saved-pages.js'
import { buildTabsDashboardStartupSnapshot, type DashboardStartupSnapshot } from './startup-snapshot.js'
import type { DashboardData, DashboardSource, TabHistorySnapshot, WorkingSetSnapshot } from './types'
import type { HistorySourceSearchResult } from './history-source.js'

export type MissionOrderMap = Record<DashboardSource, Map<string, number>>

export type DashboardSnapshotOptions = {
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  pinnedDomains: string[]
  savedPagesStore?: SavedPagesStore
  previousOrder: MissionOrderMap
}
export type DashboardRefreshSnapshot = {
  dashboard: DashboardData
  tabHistory?: TabHistorySnapshot
  workingSet?: WorkingSetSnapshot
}

type LatestRefreshRequest<T> = {
  apply: (value: T) => void
  run: () => Promise<T>
}
export type LatestRefreshRunner<T> = {
  active: () => boolean
  request: (run: () => Promise<T>, apply: (value: T) => void) => Promise<void>
  wait: () => Promise<void>
}

export type DashboardRefreshContext = {
  filter: string
  historyFilterEnabled: boolean
  historyRange: string
  pinnedDomains: readonly string[]
  source: DashboardSource
}

export function createLatestRefreshRunner<T>(): LatestRefreshRunner<T> {
  let inFlight: Promise<void> | null = null
  let latestRequest: LatestRefreshRequest<T> | null = null
  let revision = 0

  function request(run: () => Promise<T>, apply: (value: T) => void): Promise<void> {
    latestRequest = { apply, run }
    revision += 1
    if (inFlight) return inFlight

    const flight = (async () => {
      while (latestRequest) {
        const requestRevision = revision
        const currentRequest = latestRequest
        try {
          const value = await currentRequest.run()
          if (requestRevision !== revision) continue
          currentRequest.apply(value)
          if (requestRevision !== revision) continue
          latestRequest = null
          return
        } catch (error) {
          if (requestRevision !== revision) continue
          throw error
        }
      }
    })()
    inFlight = flight
    const clearFlight = () => {
      if (inFlight === flight) inFlight = null
    }
    void flight.then(clearFlight, clearFlight)
    return flight
  }

  return {
    active: () => inFlight !== null,
    request,
    wait: () => inFlight ?? Promise.resolve()
  }
}

export function dashboardRefreshContextMatches(
  request: DashboardRefreshContext,
  current: DashboardRefreshContext,
  startupSnapshot: boolean
): boolean {
  const sourceAndPinsMatch = request.source === current.source &&
    request.pinnedDomains.length === current.pinnedDomains.length &&
    request.pinnedDomains.every((domain, index) => domain === current.pinnedDomains[index])
  return sourceAndPinsMatch && (
    startupSnapshot ||
    (
      request.filter === current.filter &&
      request.historyRange === current.historyRange &&
      request.historyFilterEnabled === current.historyFilterEnabled
    )
  )
}

export function retainHistorySearchResultsOnError(
  nextDashboard: DashboardData,
  previousDashboard: DashboardData | null
): DashboardData {
  if (
    nextDashboard.historySearchStatus !== 'error' ||
    !previousDashboard ||
    previousDashboard.historySearchQuery !== nextDashboard.historySearchQuery
  ) return nextDashboard

  return {
    ...nextDashboard,
    historyTabs: previousDashboard.historyTabs ?? [],
    historyDomainGroups: previousDashboard.historyDomainGroups ?? []
  }
}

let startupSnapshotFlight: {
  id: object
  key: string
  promise: Promise<DashboardStartupSnapshot>
} | null = null

async function fetchBookmarksSourceItemsLazy(): Promise<BrowserReadResult<DashboardData['realTabs']>> {
  const { fetchBookmarksSourceItemsResult } = await import('../extension/bookmarks.js')
  return fetchBookmarksSourceItemsResult()
}

async function fetchHistorySourceItemsLazy(query: string, range: string): Promise<HistorySourceSearchResult> {
  const { fetchHistorySourceSearch } = await import('../extension/history-source.js')
  return fetchHistorySourceSearch(query, range)
}

function startupSnapshotFlightKey({ pinnedDomains, previousOrder, savedPagesStore }: DashboardSnapshotOptions): string {
  return JSON.stringify({
    pinnedDomains,
    savedPagesStore: savedPagesStore ?? null,
    tabPreviousOrder: Array.from(previousOrder.tabs || []).sort(([left], [right]) => left.localeCompare(right))
  })
}

async function fetchTabsDashboardSnapshot({ source, filter, historyRange, historyFilterEnabled, pinnedDomains, savedPagesStore, previousOrder }: DashboardSnapshotOptions): Promise<DashboardRefreshSnapshot> {
  const filterSearch = buildFilterSearchRequest({ source, filter, historyRange, historyFilterEnabled })
  const [currentWindowResult, serviceStateResult, savedPagesResult, bookmarkTabsResult, historySearch] = await Promise.all([
    getCurrentWindowIdResult(),
    fetchDashboardServiceStateResult(),
    savedPagesStore
      ? Promise.resolve({ ok: true as const, value: savedPagesStore })
      : loadSavedPagesStoreResult(),
    filterSearch.includeBookmarkMatches
      ? fetchBookmarksSourceItemsLazy()
      : Promise.resolve({ ok: true as const, value: [] }),
    filterSearch.includeHistoryMatches
      ? fetchHistorySourceItemsLazy(filterSearch.query, filterSearch.historyRange)
      : Promise.resolve({ status: 'ready' as const, tabs: [] })
  ])
  if (!serviceStateResult.ok) throw new Error('Could not read dashboard service state')
  if (!currentWindowResult.ok) throw new Error('Could not read current browser window')
  if (!savedPagesResult.ok) throw new Error('Could not read Saved Pages')
  if (!bookmarkTabsResult.ok) throw new Error('Could not read bookmarks')
  const serviceState = serviceStateResult.value
  const currentWindowId = currentWindowResult.value
  const openTabsResult = await fetchOpenTabsSnapshotResult(serviceState.openTabsSnapshot)
  if (!openTabsResult.ok) throw new Error('Could not read open tabs')
  const openTabs = openTabsResult.tabs
  const resolvedSavedPagesStore = savedPagesResult.value
  const dashboardTabs = getDashboardTabsFromOpenTabs(openTabs)
  const { dashboard, savedPageUpdates } = await buildDashboardDataFromTabs(dashboardTabs, currentWindowId, previousOrder[source] || new Map(), {
    pinnedDomains,
    bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
    historyPreviousOrder: previousOrder.history || new Map(),
    includeBookmarkMatches: filterSearch.includeBookmarkMatches,
    includeHistoryMatches: filterSearch.includeHistoryMatches,
    searchQuery: filterSearch.query,
    historyRange: filterSearch.historyRange,
    historySearchStatus: historySearch.status,
    bookmarkTabs: bookmarkTabsResult.value,
    historyTabs: historySearch.tabs,
    savedPagesStore: resolvedSavedPagesStore
  })
  // Page fetchers are the Saved Pages metadata writers; the build stays pure.
  void persistSavedPageMetadataUpdates(savedPageUpdates.base, savedPageUpdates.merged).catch(() => {})
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
  const [bookmarkTabsResult, savedPagesResult] = await Promise.all([
    source === 'bookmarks'
      ? fetchBookmarksSourceItemsLazy()
      : Promise.resolve({ ok: true as const, value: [] }),
    loadSavedPagesStoreResult()
  ])
  if (!savedPagesResult.ok) throw new Error('Could not read Saved Pages')
  if (!bookmarkTabsResult.ok) throw new Error('Could not read bookmarks')
  const dashboard = await fetchDashboardData(previousOrder[source] || new Map(), source, {
      pinnedDomains,
      bookmarkPreviousOrder: previousOrder.bookmarks || new Map(),
      historyPreviousOrder: previousOrder.history || new Map(),
      includeBookmarkMatches: filterSearch.includeBookmarkMatches,
      includeHistoryMatches: filterSearch.includeHistoryMatches,
      searchQuery: filterSearch.query,
      historyRange: filterSearch.historyRange,
      bookmarkTabs: bookmarkTabsResult.value,
      savedPagesStore: savedPagesResult.value
    })

  return { dashboard }
}

async function fetchDashboardStartupSnapshotOnce(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  if (isClosedTabFetchSuppressed()) throw new Error('Recently closed is settling after restore')
  const [currentWindowResult, serviceStateResult, savedPagesResult, closedTabsResult] = await Promise.all([
    getCurrentWindowIdResult(),
    fetchDashboardServiceStateResult(),
    options.savedPagesStore
      ? Promise.resolve({ ok: true as const, value: options.savedPagesStore })
      : loadSavedPagesStoreResult(),
    fetchClosedTabsResult()
  ])
  if (!serviceStateResult.ok) throw new Error('Could not read dashboard service state')
  if (!currentWindowResult.ok) throw new Error('Could not read current browser window')
  if (!savedPagesResult.ok) throw new Error('Could not read Saved Pages')
  if (!closedTabsResult.ok) throw new Error('Could not read recently closed tabs')
  const openTabsResult = await fetchOpenTabsSnapshotResult(serviceStateResult.value.openTabsSnapshot)
  if (!openTabsResult.ok) throw new Error('Could not read open tabs')
  const { snapshot, savedPageUpdates } = await buildTabsDashboardStartupSnapshot({
    dashboardTabs: getDashboardTabsFromOpenTabs(openTabsResult.tabs),
    currentWindowId: currentWindowResult.value,
    tabHistory: serviceStateResult.value.tabHistory,
    workingSetActivity: serviceStateResult.value.workingSetActivity,
    savedPagesStore: savedPagesResult.value,
    closedTabs: closedTabsResult.value,
    pinnedDomains: options.pinnedDomains,
    tabPreviousOrder: options.previousOrder.tabs || new Map()
  })
  // Page fetchers are the Saved Pages metadata writers; the build stays pure.
  void persistSavedPageMetadataUpdates(savedPageUpdates.base, savedPageUpdates.merged).catch(() => {})
  return snapshot
}

export async function fetchDashboardStartupSnapshot(options: DashboardSnapshotOptions): Promise<DashboardStartupSnapshot> {
  const key = startupSnapshotFlightKey(options)
  if (startupSnapshotFlight?.key === key) return startupSnapshotFlight.promise

  const id = {}
  const promise = (async () => {
    try {
      return await fetchDashboardStartupSnapshotOnce(options)
    } finally {
      if (startupSnapshotFlight?.id === id) startupSnapshotFlight = null
    }
  })()
  startupSnapshotFlight = { id, key, promise }
  return promise
}
