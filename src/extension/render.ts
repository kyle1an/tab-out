/* ================================================================
   Render — data pipeline + derived dashboard selectors.

   This module is renderer-agnostic: it owns the tab-fetching and
   view-model derivation, while the component tree mounts elsewhere.

   Exports:
   • fetchDashboardData — refreshes chrome.tabs state and returns the
                          current { realTabs, domainGroups } snapshot
   • buildDomainGroups — group tabs into domain cards with injectable
                         custom rules for focused tests
   • buildDashboardViewModel — one-pass derivation for header stats,
                               global actions, and prebuilt card VMs
   • computeDomainCardViewModel — per-card VM, takes { filter, mode }
                                  and returns match-scoped fields
   ================================================================ */

import { getCurrentWindow } from './browser-tabs-gateway.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs, getRealTabs } from './tabs.js'
import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import { annotateSavedPageHints, loadSavedPagesStore, mergeSavedPagesWithTabs, savedPageKeyForUrl, savedPageKeysFromStore, savedPagesStoresEqual, saveSavedPagesStore, type SavedPagesStore } from './saved-pages.js'
import { buildDomainGroups } from './domain-groups.js'
import { computeDomainCardViewModel } from './domain-card-view-model.js'
import { domainGroupCardId } from './domain-card-id.js'
import { dashboardSourceAllowsTabActions, isClosedSavedDashboardTab } from './dashboard-source.js'
import { getFilteredCloseableUrls, tabMatchesSourceFilter } from './filter-match.js'
import { readLocalCustomGroups } from './local-config.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { CustomGroupRule, DashboardCardEntry, DashboardChipOrderByCard, DashboardChipPriorityMap, DashboardData, DashboardSource, DashboardTab, DashboardViewModel, DomainGroup, WorkingSetSnapshot } from './types'
import type { PinnedPageChipIndex } from './page-chip-pins.js'

export { buildDomainGroups } from './domain-groups.js'
export { computeDomainCardViewModel, dashboardChipOrderKeyForTab } from './domain-card-view-model.js'
export { tabMatchesFilter, tabMatchesLegacyFilter } from './filter-match.js'

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
 * @param {{ realTabs?: DashboardTab[], domainGroups?: DomainGroup[], filter?: string, source?: DashboardSource, currentWindowId?: number | null }} [opts]
 * @returns {DashboardViewModel}
 */
type DashboardViewModelOptions = {
  realTabs?: DashboardTab[]
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
  dashboardTabs?: DashboardTab[]
  bookmarkTabs?: DashboardTab[]
  historyTabs?: DashboardTab[]
  currentWindowId?: number | null
  savedPagesStore?: SavedPagesStore
}

export function buildDashboardViewModel({ realTabs = getRealTabs(), domainGroups: groups = [], filter = '', source = 'tabs', currentWindowId = null, chipOrder, chipPriority, pinnedSections, pinnedPageChips }: DashboardViewModelOptions = {}): DashboardViewModel {
  const filtering = filter.trim().length > 0
  const openTabs = realTabs.filter((t) => !isClosedSavedDashboardTab(t))
  // Active = not parked by a tab-suspender extension. Counted over the same
  // openTabs base as totalTabs so it reads as "loaded out of open".
  const activeTabs = openTabs.filter((t) => !t.suspended).length
  const visibleTabs = filtering ? openTabs.filter((t) => !t.isApp && tabMatchesSourceFilter(t, filter)) : openTabs
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
    const matchedVm = computeDomainCardViewModel(group, { filter, mode: 'matched', source, allowMutations, currentWindowId, chipOrder: groupChipOrder, chipPriority, pinnedSections, pinnedPageChips })
    if (!matchedVm.isHidden) {
      matchedCards.push({ group, vm: matchedVm })
      if (allowMutations) {
        dedupCount += matchedVm.closableExtras || 0
        if (matchedVm.closableDupeUrls?.length) globalDedupeUrls.push(...matchedVm.closableDupeUrls)
      }
    }

    if (!filtering) continue

    const unmatchedVm = computeDomainCardViewModel(group, { filter, mode: 'unmatched', source, allowMutations, currentWindowId, chipOrder: groupChipOrder, chipPriority, pinnedSections, pinnedPageChips })
    if (!unmatchedVm.isHidden) unmatchedCards.push({ group, vm: unmatchedVm })
  }

  const filteredCloseUrls = allowMutations ? getFilteredCloseableUrls(realTabs, filter) : []

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
      filteredCloseCount: filteredCloseUrls.length,
      hasCards: groups.length > 0,
      filtering
    },
    matchedCards,
    unmatchedCards,
    showOtherTabs: unmatchedCards.length > 0,
    globalDedupeUrls,
    filteredCloseUrls
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

/**
 * @returns {{ customGroups: CustomGroupRule[] }}
 */
function getDashboardGroupingConfig(): { customGroups: CustomGroupRule[] } {
  return {
    customGroups: readLocalCustomGroups()
  }
}

export async function getCurrentWindowId(): Promise<number | null> {
  const currentWindow = await getCurrentWindow()
  return typeof currentWindow?.id === 'number' ? currentWindow.id : null
}

async function saveSavedPagesStoreBestEffort(store: Parameters<typeof saveSavedPagesStore>[0]): Promise<void> {
  try {
    await saveSavedPagesStore(store)
  } catch {}
}

async function dashboardTabsForData(dashboardTabs?: DashboardTab[]): Promise<DashboardTab[]> {
  if (dashboardTabs) return dashboardTabs
  const openTabsSnapshot = await fetchOpenTabsSnapshot()
  return getDashboardTabsFromOpenTabs(openTabsSnapshot)
}

function dashboardItemIdentityKey(tab: Pick<DashboardTab, 'url' | 'rawUrl'>): string {
  return savedPageKeyForUrl(unwrapSuspenderUrl(tab.url || tab.rawUrl || ''))
}

function addMatchingItemIdentityKeys(keys: Set<string>, tabs: DashboardTab[], filter: string): void {
  if (!filter.trim()) return
  for (const tab of tabs) {
    if (!tabMatchesSourceFilter(tab, filter)) continue
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
    bookmarkTabs = [],
    historyTabs = [],
    savedPagesStore
  }: FetchDashboardDataOptions = {}
): Promise<Required<DashboardData>> {
  const groupingConfig = getDashboardGroupingConfig()
  const historyQuery = includeHistoryMatches ? searchQuery.trim() : ''
  const resolvedSavedPagesStore = savedPagesStore ?? await loadSavedPagesStore()
  const companionBookmarkTabs = includeBookmarkMatches ? bookmarkTabs : []
  const companionHistoryTabs = includeHistoryMatches ? historyTabs : []
  const savedPagesMerge = mergeSavedPagesWithTabs(dashboardTabs, resolvedSavedPagesStore)
  if (!savedPagesStoresEqual(resolvedSavedPagesStore, savedPagesMerge.store)) {
    void saveSavedPagesStoreBestEffort(savedPagesMerge.store)
  }
  const realTabs = savedPagesMerge.tabs
  const annotatedBookmarkTabs = annotateSavedPageHints(companionBookmarkTabs, savedPagesMerge.store)
  const priorCompanionKeys = new Set<string>()
  addMatchingItemIdentityKeys(priorCompanionKeys, realTabs, searchQuery)
  const dedupedHistoryTabs = includeHistoryMatches ? removePriorSourceMatches(companionHistoryTabs, priorCompanionKeys) : companionHistoryTabs
  addMatchingItemIdentityKeys(priorCompanionKeys, dedupedHistoryTabs, searchQuery)
  const dedupedBookmarkTabs = includeBookmarkMatches ? removePriorSourceMatches(annotatedBookmarkTabs, priorCompanionKeys) : annotatedBookmarkTabs
  const domainGroups = buildDomainGroups(realTabs, { previousOrder, pinnedDomains, ...groupingConfig })
  const bookmarkDomainGroups = buildDomainGroups(dedupedBookmarkTabs, { previousOrder: bookmarkPreviousOrder, pinnedDomains, ...groupingConfig })
  const historyDomainGroups = buildDomainGroups(dedupedHistoryTabs, { previousOrder: historyPreviousOrder, pinnedDomains, ...groupingConfig })
  return {
    realTabs,
    domainGroups,
    currentWindowId,
    bookmarkTabs: dedupedBookmarkTabs,
    bookmarkDomainGroups,
    bookmarkSearchReady: includeBookmarkMatches,
    historyTabs: dedupedHistoryTabs,
    historyDomainGroups,
    historySearchQuery: historyQuery,
    historyRange,
    savedKeys: savedPageKeysFromStore(savedPagesMerge.store)
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
    dashboardTabs,
    bookmarkTabs = [],
    historyTabs = [],
    currentWindowId,
    savedPagesStore
  }: FetchDashboardDataOptions = {}
): Promise<Required<DashboardData>> {
  const groupingConfig = getDashboardGroupingConfig()
  if (source === 'bookmarks') {
    const resolvedSavedPagesStore = savedPagesStore ?? await loadSavedPagesStore()
    const realTabs = annotateSavedPageHints(bookmarkTabs, resolvedSavedPagesStore)
    const domainGroups = buildDomainGroups(realTabs, { previousOrder, pinnedDomains, ...groupingConfig })
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
  return buildDashboardDataFromTabs(resolvedDashboardTabs, resolvedCurrentWindowId, previousOrder, {
    pinnedDomains,
    bookmarkPreviousOrder,
    historyPreviousOrder,
    includeBookmarkMatches,
    includeHistoryMatches,
    searchQuery,
    historyRange,
    bookmarkTabs,
    historyTabs,
    savedPagesStore
  })
}
