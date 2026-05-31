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
   • getFilteredCloseableUrls — exact URLs the global filtered-close
                                action should remove
   • pickFavicon — tab.favIconUrl (preserves data: URIs) /
                   chrome.runtime.getURL('/_favicon/?pageUrl=...')
   ================================================================ */

import { fetchOpenTabs, getDashboardTabs, getRealTabs } from './tabs.js'
import { fetchBookmarksSourceItems } from './bookmarks.js'
import { DEFAULT_HISTORY_RANGE, fetchHistorySourceItems } from './history-source.js'
import { annotateSavedPageHints, loadSavedPagesStore, mergeSavedPagesWithTabs, savedPagesStoresEqual, saveSavedPagesStore } from './saved-pages.js'
import { buildDomainGroups } from './domain-groups.js'
import { computeDomainCardViewModel } from './domain-card-view-model.js'
import { domainGroupCardId } from './domain-card-id.js'
import { dashboardSourceAllowsTabActions, isClosedSavedDashboardTab } from './dashboard-source.js'
import { getFilteredCloseableUrls, tabMatchesSourceFilter } from './filter-match.js'
import { readLocalCustomGroups } from './local-config.js'
import type { CustomGroupRule, DashboardCardEntry, DashboardChipOrderByCard, DashboardChipPriorityMap, DashboardData, DashboardSource, DashboardTab, DashboardViewModel, DomainGroup } from './types'

export { pickFavicon } from './favicons.js'
export { buildDomainGroups } from './domain-groups.js'
export { computeDomainCardViewModel, dashboardChipOrderKeyForChip, dashboardChipOrderKeyForTab } from './domain-card-view-model.js'
export { getFilteredCloseableUrls, tabMatchesFilter, tabMatchesLegacyFilter, tabMatchesSourceFilter } from './filter-match.js'

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
}

export function buildDashboardViewModel({ realTabs = getRealTabs(), domainGroups: groups = [], filter = '', source = 'tabs', currentWindowId = null, chipOrder, chipPriority, pinnedSections }: DashboardViewModelOptions = {}): DashboardViewModel {
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
    const matchedVm = computeDomainCardViewModel(group, { filter, mode: 'matched', allowMutations, currentWindowId, chipOrder: groupChipOrder, chipPriority, pinnedSections })
    if (!matchedVm.isHidden) {
      matchedCards.push({ group, vm: matchedVm })
      if (allowMutations) {
        dedupCount += matchedVm.closableExtras || 0
        if (matchedVm.closableDupeUrls?.length) globalDedupeUrls.push(...matchedVm.closableDupeUrls)
      }
    }

    if (!filtering) continue

    const unmatchedVm = computeDomainCardViewModel(group, { filter, mode: 'unmatched', allowMutations, currentWindowId, chipOrder: groupChipOrder, chipPriority, pinnedSections })
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

/**
 * @returns {{ customGroups: CustomGroupRule[] }}
 */
function getDashboardGroupingConfig(): { customGroups: CustomGroupRule[] } {
  return {
    customGroups: readLocalCustomGroups()
  }
}

async function getCurrentWindowId(): Promise<number | null> {
  try {
    const currentWindow = await chrome.windows.getCurrent()
    return typeof currentWindow.id === 'number' ? currentWindow.id : null
  } catch {
    return null
  }
}

/**
 * fetchDashboardData() — refresh chrome.tabs state and return the
 * current dashboard snapshot consumed by the React App root.
 *
 * @param {Map<string, number>} [previousOrder]
 * @param {DashboardSource} [source]
 * @param {{ pinnedDomains?: string[], bookmarkPreviousOrder?: Map<string, number>, historyPreviousOrder?: Map<string, number>, includeBookmarkMatches?: boolean, includeHistoryMatches?: boolean, searchQuery?: string, historyRange?: string }} [opts]
 * @returns {Promise<{ realTabs: DashboardTab[], domainGroups: DomainGroup[], bookmarkTabs: DashboardTab[], bookmarkDomainGroups: DomainGroup[], bookmarkSearchReady: boolean, historyTabs: DashboardTab[], historyDomainGroups: DomainGroup[], historySearchQuery: string, historyRange: string }>}
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
    historyRange = DEFAULT_HISTORY_RANGE
  }: {
    pinnedDomains?: string[]
    bookmarkPreviousOrder?: Map<string, number>
    historyPreviousOrder?: Map<string, number>
    includeBookmarkMatches?: boolean
    includeHistoryMatches?: boolean
    searchQuery?: string
    historyRange?: string
  } = {}
): Promise<Required<DashboardData>> {
  const groupingConfig = getDashboardGroupingConfig()
  if (source === 'bookmarks') {
    const [bookmarkTabs, savedPagesStore] = await Promise.all([
      fetchBookmarksSourceItems(),
      loadSavedPagesStore()
    ])
    const realTabs = annotateSavedPageHints(bookmarkTabs, savedPagesStore)
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
      historyRange: DEFAULT_HISTORY_RANGE
    }
  }

  const historyQuery = includeHistoryMatches ? searchQuery.trim() : ''
  const [, currentWindowId, savedPagesStore, bookmarkTabs, historyTabs] = await Promise.all([
    fetchOpenTabs(),
    getCurrentWindowId(),
    loadSavedPagesStore(),
    includeBookmarkMatches ? fetchBookmarksSourceItems() : Promise.resolve([]),
    includeHistoryMatches ? fetchHistorySourceItems(searchQuery, historyRange) : Promise.resolve([])
  ])
  const savedPagesMerge = mergeSavedPagesWithTabs(getDashboardTabs(), savedPagesStore)
  if (!savedPagesStoresEqual(savedPagesStore, savedPagesMerge.store)) {
    void saveSavedPagesStore(savedPagesMerge.store).catch(() => {})
  }
  const realTabs = savedPagesMerge.tabs
  const annotatedBookmarkTabs = annotateSavedPageHints(bookmarkTabs, savedPagesMerge.store)
  const domainGroups = buildDomainGroups(realTabs, { previousOrder, pinnedDomains, ...groupingConfig })
  const bookmarkDomainGroups = buildDomainGroups(annotatedBookmarkTabs, { previousOrder: bookmarkPreviousOrder, pinnedDomains, ...groupingConfig })
  const historyDomainGroups = buildDomainGroups(historyTabs, { previousOrder: historyPreviousOrder, pinnedDomains, ...groupingConfig })
  return {
    realTabs,
    domainGroups,
    currentWindowId,
    bookmarkTabs: annotatedBookmarkTabs,
    bookmarkDomainGroups,
    bookmarkSearchReady: includeBookmarkMatches,
    historyTabs,
    historyDomainGroups,
    historySearchQuery: historyQuery,
    historyRange
  }
}
