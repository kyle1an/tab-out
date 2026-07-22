import { isGroupedTab } from './groups.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import { compileFilterQuery, searchableTextForDashboardItem } from './filter-query.js'

import type { DashboardTab } from './types'
import type { CompiledFilterQuery } from './filter-query.js'

export function tabMatchesCompiledFilter(
  tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>,
  query: CompiledFilterQuery
): boolean {
  if (!query.active) return true
  if (query.terms.length === 0) return false

  const searchableText = searchableTextForDashboardItem(tab)
  return query.terms.every((term) => term.matchValues.some((value) => searchableText.includes(value)))
}

export function tabMatchesFilter(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>, filter: string): boolean {
  return tabMatchesCompiledFilter(tab, compileFilterQuery(filter))
}

export function tabMatchesSourceFilter(
  tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>,
  filter: string
): boolean {
  return tabMatchesFilter(tab, filter)
}

export function getFilteredCloseableUrlsForQuery(realTabs: DashboardTab[], query: CompiledFilterQuery): string[] {
  return getFilteredCloseableTabsForQuery(realTabs, query).map((tab) => tab.url)
}

export function getFilteredCloseableTabsForQuery(realTabs: DashboardTab[], query: CompiledFilterQuery): DashboardTab[] {
  if (!query.active) return []
  return realTabs
    .filter((t) => !t.isApp)
    .filter((t) => !isClosedSavedDashboardTab(t))
    .filter((t) => !isGroupedTab(t))
    .filter((t) => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
    .filter((t) => tabMatchesCompiledFilter(t, query))
}
