import { DEFAULT_HISTORY_RANGE } from './history-range.js'
import { dashboardSourceAllowsSideSearches } from './dashboard-source.js'
import type { DashboardData, DashboardSource } from './types'

export type FilterSearchOptions = {
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
}

export type FilterSearchRequest = {
  query: string
  historyQuery: string
  historyRange: string
  includeBookmarkMatches: boolean
  includeHistoryMatches: boolean
}

function isTabFilterSearch({ source, filter }: Pick<FilterSearchOptions, 'source' | 'filter'>): boolean {
  return dashboardSourceAllowsSideSearches(source) && filter.trim() !== ''
}

export function buildFilterSearchRequest({
  source,
  filter,
  historyRange = DEFAULT_HISTORY_RANGE,
  historyFilterEnabled,
}: FilterSearchOptions): FilterSearchRequest {
  const includeSideSearches = isTabFilterSearch({ source, filter })
  const includeHistoryMatches = includeSideSearches && historyFilterEnabled

  return {
    query: filter,
    historyQuery: includeHistoryMatches ? filter.trim() : '',
    historyRange,
    includeBookmarkMatches: includeSideSearches,
    includeHistoryMatches,
  }
}

export function canUseBookmarkSearchResults(dashboard: DashboardData | null, options: FilterSearchOptions): boolean {
  return isTabFilterSearch(options) && !!dashboard?.bookmarkSearchReady
}

function historySearchStatus(dashboard: DashboardData | null) {
  return dashboard?.historySearchStatus ?? (dashboard?.historySearchQuery ? 'ready' : 'idle')
}

function historySearchMatchesRequest(dashboard: DashboardData | null, options: FilterSearchOptions): boolean {
  const request = buildFilterSearchRequest(options)
  return (
    request.includeHistoryMatches &&
    dashboard?.historySearchQuery === request.historyQuery &&
    dashboard?.historyRange === request.historyRange
  )
}

export function isHistorySearchRequestSettled(dashboard: DashboardData | null, options: FilterSearchOptions): boolean {
  return historySearchMatchesRequest(dashboard, options) && historySearchStatus(dashboard) !== 'idle'
}

export function canUseHistorySearchResults(dashboard: DashboardData | null, options: FilterSearchOptions): boolean {
  return isHistorySearchRequestSettled(dashboard, options) && historySearchStatus(dashboard) === 'ready'
}

export function canDisplayHistorySearchResults(dashboard: DashboardData | null, options: FilterSearchOptions): boolean {
  const request = buildFilterSearchRequest(options)
  return (
    request.includeHistoryMatches &&
    dashboard?.historySearchQuery === request.historyQuery &&
    historySearchStatus(dashboard) !== 'idle'
  )
}

export function dashboardNeedsFilterSearchRefresh(dashboard: DashboardData | null, options: FilterSearchOptions): boolean {
  const request = buildFilterSearchRequest(options)
  if (!dashboard || !request.includeBookmarkMatches) return false

  const bookmarkSearchReady = !!dashboard.bookmarkSearchReady
  const historySearchReady = !request.includeHistoryMatches || isHistorySearchRequestSettled(dashboard, options)

  return !(bookmarkSearchReady && historySearchReady)
}

export function shouldShowHistoryRange(options: Pick<FilterSearchOptions, 'source' | 'filter'>): boolean {
  return isTabFilterSearch(options)
}
