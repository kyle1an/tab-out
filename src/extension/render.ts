/* ================================================================
   Render — data pipeline + derived dashboard selectors.

   This module is renderer-agnostic: it owns the tab-fetching and
   view-model derivation, while the component tree mounts elsewhere.

   Exports:
   • fetchDashboardData — refreshes chrome.tabs state and returns the
                          current { realTabs, domainGroups } snapshot
   • buildDomainGroups — group tabs into domain cards
   • buildDashboardViewModel — one-pass derivation for header stats,
                               global actions, and prebuilt card VMs
   • computeDomainCardViewModel — per-card VM, takes { filter, mode }
                                  and returns match-scoped fields
   ================================================================ */

import { getCurrentWindowResult, type BrowserReadResult } from './browser-tabs-gateway.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs } from './tabs.js'
import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import { annotateSavedPageHints, loadSavedPagesStore, mergeSavedPagesWithTabs, persistSavedPageMetadataUpdates, savedPageKeyForUrl, savedPageKeysFromStore, type SavedPageMetadataUpdates, type SavedPagesStore } from './saved-pages.js'
import { buildDomainGroups } from './domain-groups.js'
import { computeDomainCardViewModel } from './domain-card-view-model.js'
import { domainGroupCardId } from './domain-card-id.js'
import { dashboardSourceAllowsTabActions, isClosedSavedDashboardTab } from './dashboard-source.js'
import { getFilteredCloseableTabsForQuery, tabMatchesCompiledFilter } from './filter-match.js'
import { compileFilterQuery } from './filter-query.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { DashboardCardEntry, DashboardChipOrderByCard, DashboardChipPriorityMap, DashboardData, DashboardSource, DashboardTab, DashboardViewModel, DomainGroup, HistorySearchStatus, WorkingSetSnapshot } from './types'
import type { PinnedPageChipIndex } from './page-chip-pins.js'
import type { CompiledFilterQuery } from './filter-query.js'

export { buildDomainGroups } from './domain-groups.js'
export { computeDomainCardViewModel, dashboardChipOrderKeyForTab } from './domain-card-view-model.js'
export { tabMatchesFilter } from './filter-match.js'

/**
 * buildDashboardViewModel({ realTabs, domainGroups, filter }) — derives the
 * header stats, global action targets, and prebuilt card VMs in one pass.
 *
 * This keeps the dashboard honest and lighter-weight: the App root, header,
 * and missions grids all consume the same matched / unmatched card VMs
 * instead of each caller re-running computeDomainCardViewModel() over the
 * same groups.
 */
/**
 * @param {{ realTabs: DashboardTab[], domainGroups?: DomainGroup[], filter?: string, source?: DashboardSource, currentWindowId?: number | null }} opts
 * @returns {DashboardViewModel}
 */
type DashboardViewModelOptions = {
  realTabs: DashboardTab[]
  domainGroups?: DomainGroup[]
  filter?: string
  source?: DashboardSource
  currentWindowId?: number | null
  chipOrder?: DashboardChipOrderByCard
  chipPriority?: DashboardChipPriorityMap
  pinnedSections?: ReadonlySet<string>
  pinnedPageChips?: PinnedPageChipIndex
}
type FetchDashboardDataOptions = {
  pinnedDomains?: string[]
  bookmarkPreviousOrder?: Map<string, number>
  historyPreviousOrder?: Map<string, number>
  includeBookmarkMatches?: boolean
  includeHistoryMatches?: boolean
  searchQuery?: string
  historyRange?: string
  historySearchStatus?: HistorySearchStatus
  dashboardTabs?: DashboardTab[]
  bookmarkTabs?: DashboardTab[]
  historyTabs?: DashboardTab[]
  currentWindowId?: number | null
  savedPagesStore?: SavedPagesStore
}

export function buildDashboardViewModel({ realTabs, domainGroups: groups = [], filter = '', source = 'tabs', currentWindowId = null, chipOrder, chipPriority, pinnedSections, pinnedPageChips }: DashboardViewModelOptions): DashboardViewModel {
  const filterQuery = compileFilterQuery(filter)
  const filtering = filterQuery.active
  const openTabs = realTabs.filter((t) => !isClosedSavedDashboardTab(t))
  // Active = not parked by a tab-suspender extension. Counted over the same
  // openTabs base as totalTabs so it reads as "loaded out of open".
  const activeTabs = openTabs.filter((t) => !t.suspended).length
  const visibleTabs = filtering ? openTabs.filter((t) => !t.isApp && tabMatchesCompiledFilter(t, filterQuery)) : openTabs
  // Standalone apps open in dedicated windows; counting them inflates the
  // window stat with windows that hold no regular tabs. Exclude them from
  // both totals so the header reads as "browser windows" only.
  const totalWindows = new Set(openTabs.filter((t) => !t.isApp).map((t) => t.windowId)).size
  const visibleWindows = new Set(visibleTabs.filter((t) => !t.isApp).map((t) => t.windowId)).size
  const allowMutations = dashboardSourceAllowsTabActions(source)

  const matchedCards: DashboardCardEntry[] = []
  const unmatchedCards: DashboardCardEntry[] = []
  const globalDedupeUrls: string[] = []
  let dedupCount = 0
  for (const group of groups) {
    const groupChipOrder = chipOrder?.get(domainGroupCardId(group))
    const sharedCardOptions = {
      filter,
      filterQuery,
      source,
      allowMutations,
      currentWindowId,
      ...(groupChipOrder === undefined ? {} : { chipOrder: groupChipOrder }),
      ...(chipPriority === undefined ? {} : { chipPriority }),
      ...(pinnedSections === undefined ? {} : { pinnedSections }),
      ...(pinnedPageChips === undefined ? {} : { pinnedPageChips })
    }
    const matchedVm = computeDomainCardViewModel(group, { ...sharedCardOptions, mode: 'matched' })
    if (!matchedVm.isHidden) {
      matchedCards.push({ group, vm: matchedVm })
      if (allowMutations) {
        dedupCount += matchedVm.closableExtras || 0
        if (matchedVm.closableDupeUrls?.length) globalDedupeUrls.push(...matchedVm.closableDupeUrls)
      }
    }

    if (!filtering) continue

    const unmatchedVm = computeDomainCardViewModel(group, { ...sharedCardOptions, mode: 'unmatched' })
    if (!unmatchedVm.isHidden) unmatchedCards.push({ group, vm: unmatchedVm })
  }

  const filteredCloseTabs = allowMutations ? getFilteredCloseableTabsForQuery(realTabs, filterQuery) : []
  const filteredCloseUrls = filteredCloseTabs.map((tab) => tab.url)
  const filteredCloseTargets = filteredCloseTabs.flatMap((tab) => typeof tab.id === 'number'
    ? [{ tabId: tab.id, tabUrl: tab.url }]
    : [])

  return {
    source,
    stats: {
      totalTabs: openTabs.length,
      activeTabs,
      visibleTabs: visibleTabs.length,
      totalWindows,
      visibleWindows,
      totalDomains: groups.length,
      visibleDomains: matchedCards.length,
      dedupCount,
      filteredCloseCount: filteredCloseTargets.length,
      hasCards: groups.length > 0,
      filtering
    },
    matchedCards,
    unmatchedCards,
    showOtherTabs: unmatchedCards.length > 0,
    globalDedupeUrls,
    filteredCloseUrls,
    filteredCloseTargets
  }
}

export function dashboardChipPriorityFromWorkingSet(workingSet: WorkingSetSnapshot | null | undefined): DashboardChipPriorityMap {
  if (!workingSet?.items?.length) return new Map()
  const priority = new Map<string, number>()
  function addPriorityKey(key: string, score: number) {
    if (!key) return
    priority.set(key, Math.max(priority.get(key) || 0, score))
  }
  for (const item of workingSet.items) {
    if (!Number.isFinite(item.score) || item.score <= 0) continue
    addPriorityKey(item.key, item.score)
    addPriorityKey(item.tabUrl, item.score)
    addPriorityKey(item.rawUrl, item.score)
  }
  return priority
}

export async function getCurrentWindowIdResult(): Promise<BrowserReadResult<number | null>> {
  const currentWindowResult = await getCurrentWindowResult()
  const currentWindowId = currentWindowResult.value?.id
  if (!currentWindowResult.ok || !Number.isInteger(currentWindowId) || (currentWindowId as number) < 0) {
    return { ok: false, value: null }
  }
  return { ok: true, value: currentWindowId as number }
}

async function getCurrentWindowId(): Promise<number | null> {
  return (await getCurrentWindowIdResult()).value
}

async function dashboardTabsForData(dashboardTabs?: DashboardTab[]): Promise<DashboardTab[]> {
  if (dashboardTabs) return dashboardTabs
  const openTabsSnapshot = await fetchOpenTabsSnapshot()
  return getDashboardTabsFromOpenTabs(openTabsSnapshot)
}

function dashboardItemIdentityKey(tab: Pick<DashboardTab, 'url' | 'rawUrl'>): string {
  return savedPageKeyForUrl(unwrapSuspenderUrl(tab.url || tab.rawUrl || ''))
}

function addMatchingItemIdentityKeys(keys: Set<string>, tabs: DashboardTab[], filterQuery: CompiledFilterQuery): void {
  if (!filterQuery.active) return
  for (const tab of tabs) {
    if (!tabMatchesCompiledFilter(tab, filterQuery)) continue
    const key = dashboardItemIdentityKey(tab)
    if (key) keys.add(key)
  }
}

function removePriorSourceMatches(tabs: DashboardTab[], priorKeys: ReadonlySet<string>): DashboardTab[] {
  if (priorKeys.size === 0) return tabs
  return tabs.filter((tab) => {
    const key = dashboardItemIdentityKey(tab)
    return !key || !priorKeys.has(key)
  })
}

export function dedupeCompanionSearchTabs(
  realTabs: DashboardTab[],
  historyTabs: DashboardTab[],
  bookmarkTabs: DashboardTab[],
  filter: string
): { historyTabs: DashboardTab[], bookmarkTabs: DashboardTab[] } {
  const filterQuery = compileFilterQuery(filter)
  const priorCompanionKeys = new Set<string>()
  addMatchingItemIdentityKeys(priorCompanionKeys, realTabs, filterQuery)
  const dedupedHistoryTabs = removePriorSourceMatches(historyTabs, priorCompanionKeys)
  addMatchingItemIdentityKeys(priorCompanionKeys, dedupedHistoryTabs, filterQuery)
  const dedupedBookmarkTabs = removePriorSourceMatches(bookmarkTabs, priorCompanionKeys)
  return {
    historyTabs: dedupedHistoryTabs,
    bookmarkTabs: dedupedBookmarkTabs
  }
}

export type DashboardDataBuild = {
  dashboard: Required<DashboardData>
  savedPageUpdates: SavedPageMetadataUpdates
}

export async function buildDashboardDataFromTabs(
  dashboardTabs: DashboardTab[],
  currentWindowId: number | null,
  previousOrder: Map<string, number> = new Map(),
  {
    pinnedDomains = [],
    bookmarkPreviousOrder = new Map(),
    historyPreviousOrder = new Map(),
    includeBookmarkMatches = false,
    includeHistoryMatches = false,
    searchQuery = '',
    historyRange = DEFAULT_HISTORY_RANGE,
    historySearchStatus = 'ready',
    bookmarkTabs = [],
    historyTabs = [],
    savedPagesStore
  }: FetchDashboardDataOptions = {}
): Promise<DashboardDataBuild> {
  const historyQuery = includeHistoryMatches ? searchQuery.trim() : ''
  const resolvedSavedPagesStore = savedPagesStore ?? await loadSavedPagesStore()
  const companionBookmarkTabs = includeBookmarkMatches ? bookmarkTabs : []
  const companionHistoryTabs = includeHistoryMatches ? historyTabs : []
  const savedPagesMerge = mergeSavedPagesWithTabs(dashboardTabs, resolvedSavedPagesStore)
  const realTabs = savedPagesMerge.tabs
  const annotatedBookmarkTabs = annotateSavedPageHints(companionBookmarkTabs, savedPagesMerge.store)
  const domainGroups = buildDomainGroups(realTabs, { previousOrder, pinnedDomains })
  const bookmarkDomainGroups = buildDomainGroups(annotatedBookmarkTabs, { previousOrder: bookmarkPreviousOrder, pinnedDomains })
  const historyDomainGroups = buildDomainGroups(companionHistoryTabs, { previousOrder: historyPreviousOrder, pinnedDomains })
  return {
    dashboard: {
      realTabs,
      domainGroups,
      currentWindowId,
      bookmarkTabs: annotatedBookmarkTabs,
      bookmarkDomainGroups,
      bookmarkSearchReady: includeBookmarkMatches,
      historyTabs: companionHistoryTabs,
      historyDomainGroups,
      historySearchQuery: historyQuery,
      historyRange,
      historySearchStatus: includeHistoryMatches ? historySearchStatus : 'idle',
      savedKeys: savedPageKeysFromStore(savedPagesMerge.store)
    },
    savedPageUpdates: { base: resolvedSavedPagesStore, merged: savedPagesMerge.store }
  }
}

/**
 * fetchDashboardData() — refresh chrome.tabs state and return the
 * current dashboard snapshot consumed by the React App root.
 *
 * @param {Map<string, number>} [previousOrder]
 * @param {DashboardSource} [source]
 * @param {{ pinnedDomains?: string[], bookmarkPreviousOrder?: Map<string, number>, historyPreviousOrder?: Map<string, number>, includeBookmarkMatches?: boolean, includeHistoryMatches?: boolean, searchQuery?: string, historyRange?: string }} [opts]
 * @returns {Promise<Required<DashboardData>>}
 */
export async function fetchDashboardData(
  previousOrder: Map<string, number> = new Map(),
  source: DashboardSource = 'tabs',
  {
    pinnedDomains = [],
    bookmarkPreviousOrder = new Map(),
    historyPreviousOrder = new Map(),
    includeBookmarkMatches = false,
    includeHistoryMatches = false,
    searchQuery = '',
    historyRange = DEFAULT_HISTORY_RANGE,
    historySearchStatus = 'ready',
    dashboardTabs,
    bookmarkTabs = [],
    historyTabs = [],
    currentWindowId,
    savedPagesStore
  }: FetchDashboardDataOptions = {}
): Promise<Required<DashboardData>> {
  if (source === 'bookmarks') {
    const resolvedSavedPagesStore = savedPagesStore ?? await loadSavedPagesStore()
    const realTabs = annotateSavedPageHints(bookmarkTabs, resolvedSavedPagesStore)
    const domainGroups = buildDomainGroups(realTabs, { previousOrder, pinnedDomains })
    return {
      realTabs,
      domainGroups,
      currentWindowId: null,
      bookmarkTabs: [],
      bookmarkDomainGroups: [],
      bookmarkSearchReady: false,
      historyTabs: [],
      historyDomainGroups: [],
      historySearchQuery: '',
      historyRange: DEFAULT_HISTORY_RANGE,
      historySearchStatus: 'idle',
      // savedKeys is sourced from the pre-merge store here; the history panel only
      // renders in the 'tabs' source, and merging never changes the saved-page key
      // set (it only updates record fields), so the keys match the tabs branch.
      savedKeys: savedPageKeysFromStore(resolvedSavedPagesStore)
    }
  }

  const [resolvedDashboardTabs, resolvedCurrentWindowId] = await Promise.all([
    dashboardTabsForData(dashboardTabs),
    currentWindowId === undefined ? getCurrentWindowId() : Promise.resolve(currentWindowId)
  ])
  const { dashboard, savedPageUpdates } = await buildDashboardDataFromTabs(resolvedDashboardTabs, resolvedCurrentWindowId, previousOrder, {
    pinnedDomains,
    bookmarkPreviousOrder,
    historyPreviousOrder,
    includeBookmarkMatches,
    includeHistoryMatches,
    searchQuery,
    historyRange,
    historySearchStatus,
    bookmarkTabs,
    historyTabs,
    ...(savedPagesStore === undefined ? {} : { savedPagesStore })
  })
  // Page fetchers are the only Saved Pages metadata writers; builds stay pure
  // and the worker discards its copy of these updates.
  void persistSavedPageMetadataUpdates(savedPageUpdates.base, savedPageUpdates.merged).catch(() => {})
  return dashboard
}
