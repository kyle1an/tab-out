import { useLayoutEffect, useMemo, type RefObject } from 'react'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { dashboardChipOrderAltKeyForChip, dashboardChipOrderKeyForChip } from '../extension/domain-card-view-model.js'
import { canDisplayHistorySearchResults, canUseBookmarkSearchResults, canUseHistorySearchResults, isHistorySearchRequestSettled, shouldShowHistoryRange } from '../extension/filter-search.js'
import { tabMatchesSourceFilter } from '../extension/filter-match.js'
import { buildDashboardViewModel, dashboardChipPriorityFromWorkingSet, dedupeCompanionSearchTabs } from '../extension/render.js'
import type { DashboardCardEntry, DashboardCardVM, DashboardChipData, DashboardChipOrderByCard, DashboardData, DashboardSource, DomainGroup, HistorySearchSummary, WorkingSetSnapshot } from '../extension/types'
import type { PinnedPageChipIndex } from '../extension/page-chip-pins.js'
import type { MissionOrderMap } from '../extension/dashboard-intake.js'

const EMPTY_TABS: DashboardData['realTabs'] = []
const EMPTY_DOMAIN_GROUPS: DomainGroup[] = []
const EMPTY_CARD_ENTRIES: DashboardCardEntry[] = []
const EMPTY_CHIP_ORDER_BY_CARD: DashboardChipOrderByCard = new Map()

function retainDomainGroupTabs(groups: DomainGroup[], tabs: DashboardData['realTabs']): DomainGroup[] {
  const retainedTabs = new Set(tabs)
  return groups.flatMap((group) => {
    const groupTabs = group.tabs.filter((tab) => retainedTabs.has(tab))
    if (groupTabs.length === 0) return []
    return groupTabs.length === group.tabs.length ? [group] : [{ ...group, tabs: groupTabs }]
  })
}

export type DashboardChipOrderMemoryMap = Record<DashboardSource, DashboardChipOrderByCard>

type DashboardViewModelOptions = {
  dashboard: DashboardData | null
  source: DashboardSource
  filter: string
  historyRange: string
  historyFilterEnabled: boolean
  historySearchPending?: boolean
  isReady: boolean
  chipOrder: DashboardChipOrderMemoryMap
  workingSet?: WorkingSetSnapshot | null
  pinnedSections?: ReadonlySet<string>
  pinnedPageChips?: PinnedPageChipIndex
  freezeTabsChipOrder?: boolean
}

export function useDashboardViewModels({ dashboard, source, filter, historyRange, historyFilterEnabled, historySearchPending = false, isReady, chipOrder, workingSet, pinnedSections, pinnedPageChips, freezeTabsChipOrder }: DashboardViewModelOptions) {
  const filterSearchOptions = { source, filter, historyRange, historyFilterEnabled }
  const realTabs = dashboard?.realTabs || EMPTY_TABS
  const domainGroups = dashboard?.domainGroups || EMPTY_DOMAIN_GROUPS
  const currentWindowId = dashboard?.currentWindowId ?? null
  const bookmarkTabs = dashboard?.bookmarkTabs || EMPTY_TABS
  const bookmarkDomainGroups = dashboard?.bookmarkDomainGroups || EMPTY_DOMAIN_GROUPS
  const historyTabs = dashboard?.historyTabs || EMPTY_TABS
  const historyDomainGroups = dashboard?.historyDomainGroups || EMPTY_DOMAIN_GROUPS
  const chipPriority = useMemo(
    () => (source === 'tabs' ? dashboardChipPriorityFromWorkingSet(workingSet) : undefined),
    [source, workingSet]
  )
  // During the startup priority freeze, frozen Working Set priority plus the deterministic
  // fallback already fix the chip order. Remembered chip-order memory is empty at first paint
  // but populated by the time live hydration re-renders, so honoring it there re-sorts the
  // visible chip window and shifts Website Path sections. Hold it off until the freeze lifts.
  const mainChipOrder = freezeTabsChipOrder && source === 'tabs' ? EMPTY_CHIP_ORDER_BY_CARD : chipOrder[source] || EMPTY_CHIP_ORDER_BY_CARD

  // The full view-model build walks every group/card/chip, so it must not run on
  // unrelated App renders (hover, pre-debounce filter keystrokes): a fresh object
  // graph here re-renders the whole compiled tree below. The chip-order maps are
  // mutable caches with stable identity; the deps deliberately re-read their
  // contents only when a build input (dashboard/filter/source/pins) changes,
  // which is when reordering is meant to apply (see the startup-order contract).
  const dashboardVm = useMemo(
    () => buildDashboardViewModel({
      realTabs,
      domainGroups,
      filter,
      source,
      currentWindowId,
      chipOrder: mainChipOrder,
      ...(chipPriority ? { chipPriority } : {}),
      ...(pinnedSections ? { pinnedSections } : {}),
      ...(pinnedPageChips ? { pinnedPageChips } : {})
    }),
    [realTabs, domainGroups, filter, source, currentWindowId, mainChipOrder, chipPriority, pinnedSections, pinnedPageChips]
  )

  const companionSources = useMemo(
    () => {
      const displayHistory = canDisplayHistorySearchResults(dashboard, { source, filter, historyRange, historyFilterEnabled })
      const deduped = dedupeCompanionSearchTabs(
        realTabs,
        displayHistory ? historyTabs : EMPTY_TABS,
        bookmarkTabs,
        filter
      )
      return {
        bookmarkTabs: deduped.bookmarkTabs,
        bookmarkDomainGroups: retainDomainGroupTabs(bookmarkDomainGroups, deduped.bookmarkTabs),
        historyTabs: deduped.historyTabs,
        historyDomainGroups: retainDomainGroupTabs(historyDomainGroups, deduped.historyTabs)
      }
    },
    [dashboard, source, filter, historyRange, historyFilterEnabled, realTabs, bookmarkTabs, bookmarkDomainGroups, historyTabs, historyDomainGroups]
  )

  const bookmarkSearchVm = useMemo(
    () => canUseBookmarkSearchResults(dashboard, { source, filter, historyRange, historyFilterEnabled })
      ? buildDashboardViewModel({
          realTabs: companionSources.bookmarkTabs,
          domainGroups: companionSources.bookmarkDomainGroups,
          filter,
          source: 'bookmarks',
          chipOrder: chipOrder.bookmarks || EMPTY_CHIP_ORDER_BY_CARD,
          ...(pinnedSections ? { pinnedSections } : {}),
          ...(pinnedPageChips ? { pinnedPageChips } : {})
        })
      : null,
    [dashboard, source, filter, historyRange, historyFilterEnabled, companionSources, chipOrder.bookmarks, pinnedSections, pinnedPageChips]
  )

  const historySearch = useMemo(
    () => {
      const displayResults = canDisplayHistorySearchResults(dashboard, { source, filter, historyRange, historyFilterEnabled })
      const requestSettled = isHistorySearchRequestSettled(dashboard, { source, filter, historyRange, historyFilterEnabled })
      const resultsFilter = canUseHistorySearchResults(dashboard, { source, filter, historyRange, historyFilterEnabled })
        ? filter
        : dashboard?.historySearchQuery || filter
      const totalMatches = displayResults
        ? historyTabs.filter((tab) => tabMatchesSourceFilter(tab, resultsFilter)).length
        : 0
      const visibleMatches = displayResults
        ? companionSources.historyTabs.filter((tab) => tabMatchesSourceFilter(tab, resultsFilter)).length
        : 0
      const searchFailed = requestSettled && dashboard?.historySearchStatus === 'error'
      const canUpdateDisplayedResults = displayResults && (!searchFailed || totalMatches > 0)
      const phase: HistorySearchSummary['phase'] = searchFailed && !historySearchPending
        ? 'error'
        : historySearchPending || !requestSettled
          ? canUpdateDisplayedResults ? 'updating' : 'searching'
          : 'ready'
      const summary: HistorySearchSummary | null = historyFilterEnabled && shouldShowHistoryRange({ source, filter })
        ? {
            phase,
            totalMatches,
            visibleMatches,
            dedupedMatches: Math.max(0, totalMatches - visibleMatches)
          }
        : null
      return {
        displayResults,
        resultsFilter,
        summary,
        viewModel: displayResults ? buildDashboardViewModel({
          realTabs: companionSources.historyTabs,
          domainGroups: companionSources.historyDomainGroups,
          filter: resultsFilter,
          source: 'history',
          chipOrder: chipOrder.history || EMPTY_CHIP_ORDER_BY_CARD,
          ...(pinnedSections ? { pinnedSections } : {}),
          ...(pinnedPageChips ? { pinnedPageChips } : {})
        }) : null
      }
    },
    [dashboard, source, filter, historyRange, historyFilterEnabled, historySearchPending, historyTabs, companionSources, chipOrder.history, pinnedSections, pinnedPageChips]
  )

  const matchedCards = dashboardVm.matchedCards
  const bookmarkMatchedCards = bookmarkSearchVm?.matchedCards || EMPTY_CARD_ENTRIES
  const historyMatchedCards = historySearch.viewModel?.matchedCards || EMPTY_CARD_ENTRIES
  const showBookmarkMatches = isReady && canUseBookmarkSearchResults(dashboard, filterSearchOptions) && bookmarkMatchedCards.length > 0
  const showHistoryMatches = isReady && historySearch.displayResults && historyMatchedCards.length > 0

  return {
    dashboardVm,
    stats: dashboardVm.stats,
    matchedCards,
    bookmarkMatchedCards,
    historyMatchedCards,
    historySearchSummary: historySearch.summary,
    historyResultsFilter: historySearch.resultsFilter,
    showBookmarkMatches,
    showHistoryMatches,
    showHistoryRange: isReady && shouldShowHistoryRange(filterSearchOptions),
    showPrimaryEmptyState: !((showBookmarkMatches || showHistoryMatches) && matchedCards.length === 0)
  }
}

type MissionOrderMemoryOptions = {
  previousOrderRef: RefObject<MissionOrderMap>
  chipOrderRef: RefObject<DashboardChipOrderMemoryMap>
  enabled: boolean
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
      const altKey = dashboardChipOrderAltKeyForChip(chip)
      if (!order.has(key)) {
        order.set(key, index)
        if (altKey) order.getOrInsert(altKey, index)
        index++
      }
      for (const variant of chip.titleVariantChips || []) {
        const variantKey = dashboardChipOrderKeyForChip(variant)
        const variantAltKey = dashboardChipOrderAltKeyForChip(variant)
        if (!order.has(variantKey)) {
          order.set(variantKey, index)
          if (variantAltKey) order.getOrInsert(variantAltKey, index)
          index++
        }
      }
    }
    if (order.size > 0) orderByCard.set(domainGroupCardId(group), order)
  }
  return orderByCard
}

export function useMissionOrderMemory({ previousOrderRef, chipOrderRef, enabled, source, filter, matchedCards, bookmarkMatchedCards, historyMatchedCards }: MissionOrderMemoryOptions): void {
  useLayoutEffect(() => {
    if (!enabled) return
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
  }, [bookmarkMatchedCards, chipOrderRef, enabled, filter, historyMatchedCards, matchedCards, previousOrderRef, source])
}
