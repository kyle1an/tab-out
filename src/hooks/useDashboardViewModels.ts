import { useEffect, useMemo, type RefObject } from 'react'
import { buildDashboardViewModel } from '../extension/render.js'
import type { DashboardCardEntry, DashboardData, DashboardSource, DomainGroup } from '../extension/types'
import type { MissionOrderMap } from './useDashboardRefresh'

const EMPTY_TABS: DashboardData['realTabs'] = []
const EMPTY_DOMAIN_GROUPS: DomainGroup[] = []
const EMPTY_CARD_ENTRIES: DashboardCardEntry[] = []

function stableGroupId(group: DomainGroup): string {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')
}

type DashboardViewModelOptions = {
  dashboard: DashboardData | null
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  isReady: boolean
}

export function useDashboardViewModels({ dashboard, source, filter, historyRange, historyFilterEnabled, isReady }: DashboardViewModelOptions) {
  const realTabs = dashboard?.realTabs || EMPTY_TABS
  const domainGroups = dashboard?.domainGroups || EMPTY_DOMAIN_GROUPS
  const bookmarkTabs = dashboard?.bookmarkTabs || EMPTY_TABS
  const bookmarkDomainGroups = dashboard?.bookmarkDomainGroups || EMPTY_DOMAIN_GROUPS
  const historyTabs = dashboard?.historyTabs || EMPTY_TABS
  const historyDomainGroups = dashboard?.historyDomainGroups || EMPTY_DOMAIN_GROUPS

  const dashboardVm = useMemo(
    () =>
      buildDashboardViewModel({
        realTabs,
        domainGroups,
        filter,
        source
      }),
    [domainGroups, filter, realTabs, source]
  )

  const bookmarkSearchVm = useMemo(
    () =>
      source === 'tabs' && filter && dashboard?.bookmarkSearchReady
        ? buildDashboardViewModel({
            realTabs: bookmarkTabs,
            domainGroups: bookmarkDomainGroups,
            filter,
            source: 'bookmarks'
          })
        : null,
    [bookmarkDomainGroups, bookmarkTabs, dashboard?.bookmarkSearchReady, filter, source]
  )

  const historySearchVm = useMemo(
    () =>
      source === 'tabs' && filter && historyFilterEnabled && dashboard?.historySearchQuery === filter.trim() && dashboard?.historyRange === historyRange
        ? buildDashboardViewModel({
            realTabs: historyTabs,
            domainGroups: historyDomainGroups,
            filter,
            source: 'history'
          })
        : null,
    [filter, historyDomainGroups, historyFilterEnabled, historyRange, historyTabs, dashboard?.historyRange, dashboard?.historySearchQuery, source]
  )

  const matchedCards = dashboardVm.matchedCards
  const unmatchedCards = dashboardVm.unmatchedCards
  const bookmarkMatchedCards = bookmarkSearchVm?.matchedCards || EMPTY_CARD_ENTRIES
  const historyMatchedCards = historySearchVm?.matchedCards || EMPTY_CARD_ENTRIES
  const showBookmarkMatches = isReady && source === 'tabs' && !!filter && bookmarkMatchedCards.length > 0
  const showHistoryMatches = isReady && source === 'tabs' && !!filter && historyMatchedCards.length > 0

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
    showHistoryRange: isReady && source === 'tabs' && !!filter,
    showPrimaryEmptyState: !((showBookmarkMatches || showHistoryMatches) && matchedCards.length === 0),
    primaryMissionsClass: 'missions' + (matchedCards.length === 0 ? ' missions-empty' : '')
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
    previousOrderRef.current[source] = new Map(matchedCards.map(({ group }, index) => [stableGroupId(group), index]))
    if (source === 'tabs' && bookmarkMatchedCards.length > 0) {
      previousOrderRef.current.bookmarks = new Map(bookmarkMatchedCards.map(({ group }, index) => [stableGroupId(group), index]))
    }
    if (source === 'tabs' && historyMatchedCards.length > 0) {
      previousOrderRef.current.history = new Map(historyMatchedCards.map(({ group }, index) => [stableGroupId(group), index]))
    }
  }, [bookmarkMatchedCards, historyMatchedCards, matchedCards, previousOrderRef, source])
}
