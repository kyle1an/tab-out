import type { DashboardSource, DashboardTab } from './types'

type DashboardSourceType = DashboardTab['sourceType']

export function dashboardSourceAllowsTabActions(source: DashboardSource) {
  return source === 'tabs'
}

export function dashboardSourceAllowsSideSearches(source: DashboardSource) {
  return source === 'tabs'
}

export function dashboardSourceItemName(source: DashboardSource, tabName = 'tab') {
  if (source === 'bookmarks') return 'bookmark'
  if (source === 'history') return 'history result'
  return tabName
}

export function dashboardSourceEmptyNoun(source: DashboardSource) {
  if (source === 'bookmarks') return 'bookmarks'
  if (source === 'history') return 'history results'
  return 'tabs'
}

export function dashboardItemNameForTabs(tabs: ReadonlyArray<Pick<DashboardTab, 'sourceType'>>, tabName = 'tab') {
  if (tabs.length > 0 && tabs.every((tab) => tab.sourceType === 'bookmark')) return 'bookmark'
  if (tabs.length > 0 && tabs.every((tab) => tab.sourceType === 'history')) return 'history result'
  if (tabs.length > 0 && tabs.every((tab) => tab.sourceType === 'saved-page')) return 'saved page'
  return tabName
}

export function isReadOnlyDashboardSourceType(sourceType: DashboardSourceType) {
  return sourceType === 'bookmark' || sourceType === 'history' || sourceType === 'saved-page'
}

export function isClosedSavedDashboardTab(tab: Pick<DashboardTab, 'sourceType' | 'closedSaved'>): boolean {
  return tab.sourceType === 'saved-page' || !!tab.closedSaved
}
