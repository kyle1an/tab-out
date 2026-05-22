import { useEffect, type RefObject } from 'react'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { dashboardChipOrderKeyForChip } from '../extension/domain-card-view-model.js'
import { canUseBookmarkSearchResults, canUseHistorySearchResults, shouldShowHistoryRange } from '../extension/filter-search.js'
import { buildDashboardViewModel } from '../extension/render.js'
import type { DashboardCardEntry, DashboardCardVM, DashboardChipData, DashboardChipOrderByCard, DashboardData, DashboardSource, DomainGroup } from '../extension/types'
import type { MissionOrderMap } from './useDashboardRefresh'

const EMPTY_TABS: DashboardData['realTabs'] = []
const EMPTY_DOMAIN_GROUPS: DomainGroup[] = []
const EMPTY_CARD_ENTRIES: DashboardCardEntry[] = []
const EMPTY_CHIP_ORDER_BY_CARD: DashboardChipOrderByCard = new Map()

export type DashboardChipOrderMemoryMap = Record<DashboardSource, DashboardChipOrderByCard>

type DashboardViewModelOptions = {
  dashboard: DashboardData | null
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  isReady: boolean
  chipOrder: DashboardChipOrderMemoryMap
}

export function useDashboardViewModels({ dashboard, source, filter, historyRange, historyFilterEnabled, isReady, chipOrder }: DashboardViewModelOptions) {
  const filterSearchOptions = { source, filter, historyRange, historyFilterEnabled }
  const realTabs = dashboard?.realTabs || EMPTY_TABS
  const domainGroups = dashboard?.domainGroups || EMPTY_DOMAIN_GROUPS
  const currentWindowId = dashboard?.currentWindowId ?? null
  const bookmarkTabs = dashboard?.bookmarkTabs || EMPTY_TABS
  const bookmarkDomainGroups = dashboard?.bookmarkDomainGroups || EMPTY_DOMAIN_GROUPS
  const historyTabs = dashboard?.historyTabs || EMPTY_TABS
  const historyDomainGroups = dashboard?.historyDomainGroups || EMPTY_DOMAIN_GROUPS

  const dashboardVm = buildDashboardViewModel({
    realTabs,
    domainGroups,
    filter,
    source,
    currentWindowId,
    chipOrder: chipOrder[source] || EMPTY_CHIP_ORDER_BY_CARD
  })

  const bookmarkSearchVm =
    canUseBookmarkSearchResults(dashboard, filterSearchOptions)
      ? buildDashboardViewModel({
          realTabs: bookmarkTabs,
          domainGroups: bookmarkDomainGroups,
          filter,
          source: 'bookmarks',
          chipOrder: chipOrder.bookmarks || EMPTY_CHIP_ORDER_BY_CARD
        })
      : null

  const historySearchVm =
    canUseHistorySearchResults(dashboard, filterSearchOptions)
      ? buildDashboardViewModel({
          realTabs: historyTabs,
          domainGroups: historyDomainGroups,
          filter,
          source: 'history',
          chipOrder: chipOrder.history || EMPTY_CHIP_ORDER_BY_CARD
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
  chipOrderRef: RefObject<DashboardChipOrderMemoryMap>
  source: DashboardSource
  filter: string
  matchedCards: DashboardCardEntry[]
  bookmarkMatchedCards: DashboardCardEntry[]
  historyMatchedCards: DashboardCardEntry[]
}

function renderedChipsInCard(vm: DashboardCardVM): DashboardChipData[] {
  return (vm.sections || []).flatMap((section) => [
    ...section.flatVisibleChips,
    ...section.flatHiddenChips,
    ...section.clusters.flatMap((cluster) => [...cluster.visibleChips, ...cluster.hiddenChips]),
    ...(section.websitePathSections || []).flatMap((websitePathSection) => [
      ...websitePathSection.flatVisibleChips,
      ...websitePathSection.flatHiddenChips,
      ...websitePathSection.clusters.flatMap((cluster) => [...cluster.visibleChips, ...cluster.hiddenChips])
    ])
  ])
}

function chipOrderFromCards(cards: DashboardCardEntry[]): DashboardChipOrderByCard {
  const orderByCard: DashboardChipOrderByCard = new Map()
  for (const { group, vm } of cards) {
    const order = new Map<string, number>()
    let index = 0
    for (const chip of renderedChipsInCard(vm)) {
      const key = dashboardChipOrderKeyForChip(chip)
      if (!order.has(key)) order.set(key, index++)
      for (const variant of chip.titleVariantChips || []) {
        const variantKey = dashboardChipOrderKeyForChip(variant)
        if (!order.has(variantKey)) order.set(variantKey, index++)
      }
    }
    if (order.size > 0) orderByCard.set(domainGroupCardId(group), order)
  }
  return orderByCard
}

export function useMissionOrderMemory({ previousOrderRef, chipOrderRef, source, filter, matchedCards, bookmarkMatchedCards, historyMatchedCards }: MissionOrderMemoryOptions): void {
  useEffect(() => {
    previousOrderRef.current[source] = new Map(matchedCards.map(({ group }, index) => [domainGroupCardId(group), index]))
    if (filter.trim() === '') {
      chipOrderRef.current[source] = chipOrderFromCards(matchedCards)
    }
    if (source === 'tabs' && bookmarkMatchedCards.length > 0) {
      previousOrderRef.current.bookmarks = new Map(bookmarkMatchedCards.map(({ group }, index) => [domainGroupCardId(group), index]))
      chipOrderRef.current.bookmarks = chipOrderFromCards(bookmarkMatchedCards)
    }
    if (source === 'tabs' && historyMatchedCards.length > 0) {
      previousOrderRef.current.history = new Map(historyMatchedCards.map(({ group }, index) => [domainGroupCardId(group), index]))
      chipOrderRef.current.history = chipOrderFromCards(historyMatchedCards)
    }
  }, [bookmarkMatchedCards, chipOrderRef, filter, historyMatchedCards, matchedCards, previousOrderRef, source])
}
