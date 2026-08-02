/* ================================================================
   Dashboard Data Fetch — page-only browser reads and persistence.

   Shared dashboard builds live in render.ts so startup snapshot work can run
   in the service worker without importing the page's mutation runtime.
   ================================================================ */

import { buildDomainGroups } from './domain-groups.js'
import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import { buildDashboardDataFromTabs, getCurrentWindowIdResult, type BuildDashboardDataOptions } from './render.js'
import { annotateSavedPageHints, loadSavedPagesStore, savedPageKeysFromStore } from './saved-pages.js'
import { persistSavedPageMetadataUpdates } from './saved-pages-mutations.js'
import { fetchOpenTabsSnapshot, getDashboardTabsFromOpenTabs } from './tabs.js'
import type { DashboardData, DashboardSource, DashboardTab } from './types'

type FetchDashboardDataOptions = BuildDashboardDataOptions & {
  dashboardTabs?: DashboardTab[]
  currentWindowId?: number | null
}

async function getCurrentWindowId(): Promise<number | null> {
  return (await getCurrentWindowIdResult()).value
}

async function dashboardTabsForData(dashboardTabs?: DashboardTab[]): Promise<DashboardTab[]> {
  if (dashboardTabs) return dashboardTabs
  const openTabsSnapshot = await fetchOpenTabsSnapshot()
  return getDashboardTabsFromOpenTabs(openTabsSnapshot)
}

/** Refresh browser tab state and return the current page-side dashboard snapshot. */
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
      // Merging only updates Saved Page record fields, so the pre-merge keys
      // also describe the history panel's saved state.
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
