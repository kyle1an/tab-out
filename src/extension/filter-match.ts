import { getRealTabs } from './tabs.js'
import { isGroupedTab } from './groups.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { matchValuesForFilterTerm, parseFilterQuery, searchableTextForDashboardItem } from './filter-query.js'

import type { DashboardTab } from './types'

export function tabMatchesFilter(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>, filter: string): boolean {
  if (!filter.trim()) return true
  const query = parseFilterQuery(filter)
  if (query.terms.length === 0) return false

  const searchableText = searchableTextForDashboardItem(tab)
  return query.terms.every((term) => matchValuesForFilterTerm(term).some((value) => searchableText.includes(value)))
}

export function tabMatchesSourceFilter(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>, filter: string): boolean {
  return tabMatchesFilter(tab, filter)
}

/**
 * getFilteredCloseableUrls(realTabs, filter) — URLs of tabs the global
 * "Close N filtered tabs" action should close: filter-matching,
 * ungrouped, non-chrome. Returns [] when no filter is active.
 */
export function getFilteredCloseableUrls(realTabs: DashboardTab[] = getRealTabs(), filter = ''): string[] {
  if (!filter.trim()) return []
  return realTabs
    .filter((t) => !t.isApp)
    .filter((t) => !isClosedSavedDashboardTab(t))
    .filter((t) => !isGroupedTab(t))
    .filter((t) => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
    .filter((t) => tabMatchesSourceFilter(t, filter))
    .map((t) => t.url)
}
