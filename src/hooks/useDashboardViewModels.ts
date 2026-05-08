import { useEffect, type RefObject } from 'react'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { canUseBookmarkSearchResults, canUseHistorySearchResults, shouldShowHistoryRange } from '../extension/filter-search.js'
import { buildDashboardViewModel } from '../extension/render.js'
import type { DashboardCardEntry, DashboardData, DashboardSource, DomainGroup } from '../extension/types'
import type { MissionOrderMap } from './useDashboardRefresh'

const EMPTY_TABS: DashboardData['realTabs'] = []
const EMPTY_DOMAIN_GROUPS: DomainGroup[] = []
const EMPTY_CARD_ENTRIES: DashboardCardEntry[] = []

type DashboardViewModelOptions = {
  dashboard: DashboardData | null
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  isReady: boolean
}

export function useDashboardViewModels({ dashboard, source, filter, historyRange, historyFilterEnabled, isReady }: DashboardViewModelOptions) {
  const filterSearchOptions = { source, filter, historyRange, historyFilterEnabled }
  const realTabs = dashboard?.realTabs || EMPTY_TABS
  const domainGroups = dashboard?.domainGroups || EMPTY_DOMAIN_GROUPS
  const bookmarkTabs = dashboard?.bookmarkTabs || EMPTY_TABS
  const bookmarkDomainGroups = dashboard?.bookmarkDomainGroups || EMPTY_DOMAIN_GROUPS
  const historyTabs = dashboard?.historyTabs || EMPTY_TABS
  const historyDomainGroups = dashboard?.historyDomainGroups || EMPTY_DOMAIN_GROUPS

  const dashboardVm = buildDashboardViewModel({
    realTabs,
    domainGroups,
    filter,
    source
  })

  const bookmarkSearchVm =
    canUseBookmarkSearchResults(dashboard, filterSearchOptions)
      ? buildDashboardViewModel({
          realTabs: bookmarkTabs,
          domainGroups: bookmarkDomainGroups,
          filter,
          source: 'bookmarks'
        })
      : null

  const historySearchVm =
    canUseHistorySearchResults(dashboard, filterSearchOptions)
      ? buildDashboardViewModel({
          realTabs: historyTabs,
          domainGroups: historyDomainGroups,
          filter,
          source: 'history'
        })
      : null

  const matchedCards = dashboardVm.matchedCards
  const unmatchedCards = dashboardVm.unmatchedCards
  const bookmarkMatchedCards = bookmarkSearchVm?.matchedCards || EMPTY_CARD_ENTRIES
  const historyMatchedCards = historySearchVm?.matchedCards || EMPTY_CARD_ENTRIES
  const showBookmarkMatches = isReady && canUseBookmarkSearchResults(dashboard, filterSearchOptions) && bookmarkMatchedCards.length > 0
  const showHistoryMatches = isReady && canUseHistorySearchResults(dashboard, filterSearchOptions) && historyMatchedCards.length > 0

  return {
    dashboardVm,
    stats: dashboardVm.stats,
    matchedCards,
    unmatchedCards,
    bookmarkMatchedCards,
    historyMatchedCards,
    showOtherTabs: isReady && dashboardVm.showOtherTabs,
    showBookmarkMatches,
    showHistoryMatches,
    showHistoryRange: isReady && shouldShowHistoryRange(filterSearchOptions),
    showPrimaryEmptyState: !((showBookmarkMatches || showHistoryMatches) && matchedCards.length === 0)
  }
}

type MissionOrderMemoryOptions = {
  previousOrderRef: RefObject<MissionOrderMap>
  source: DashboardSource
  matchedCards: DashboardCardEntry[]
  bookmarkMatchedCards: DashboardCardEntry[]
  historyMatchedCards: DashboardCardEntry[]
}

export function useMissionOrderMemory({ previousOrderRef, source, matchedCards, bookmarkMatchedCards, historyMatchedCards }: MissionOrderMemoryOptions): void {
  useEffect(() => {
    previousOrderRef.current[source] = new Map(matchedCards.map(({ group }, index) => [domainGroupCardId(group), index]))
    if (source === 'tabs' && bookmarkMatchedCards.length > 0) {
      previousOrderRef.current.bookmarks = new Map(bookmarkMatchedCards.map(({ group }, index) => [domainGroupCardId(group), index]))
    }
    if (source === 'tabs' && historyMatchedCards.length > 0) {
      previousOrderRef.current.history = new Map(historyMatchedCards.map(({ group }, index) => [domainGroupCardId(group), index]))
    }
  }, [bookmarkMatchedCards, historyMatchedCards, matchedCards, previousOrderRef, source])
}
