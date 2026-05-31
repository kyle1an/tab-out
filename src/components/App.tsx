import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, useTransition, type ComponentPropsWithoutRef, type Ref } from 'react'
import { createRoot } from 'react-dom/client'
import { fetchClosedTabs, isClosedTabFetchSuppressed, subscribeClosedTabChanges, type ClosedTabEntry } from '../extension/closed-tabs.js'
import { useMissionsMasonry } from '../extension/layout.js'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { showToast } from '../extension/toast.js'
import { DEFAULT_HISTORY_RANGE, isHistoryFilterEnabled } from '../extension/history-source.js'
import { animateDomainCardMoves, cancelDomainCardMoves, prepareDomainCardMoveAnimation } from '../extension/card-move-animation'
import { closeFilteredTabs, dedupeTabs } from '../extension/tab-actions'
import { fetchDashboardSnapshot, useDashboardRefresh } from '../hooks/useDashboardRefresh'
import { useDashboardViewModels, useMissionOrderMemory, type DashboardChipOrderMemoryMap } from '../hooks/useDashboardViewModels'
import { useFilterRouting } from '../hooks/useFilterRouting'
import { usePinnedDomains } from '../hooks/usePinnedDomains'
import { usePinnedSections } from '../hooks/usePinnedSections'
import { useHoverMatch, type HoverMatchState } from '../hooks/useHoverMatch'
import { useScrollShadow } from '../hooks/useScrollShadow'
import { HeaderBar } from './HeaderBar'
import { Missions } from './Missions'
import { TabHistoryPanel } from './TabHistoryPanel'
import { TooltipProvider } from './ui/tooltip'
import { UrlPreview } from './UrlPreview'
import { cn } from '@/lib/utils'
import type {
  DashboardCardEntry,
  DashboardData,
  DashboardSource,
  DashboardStats,
  HoverUrlChangeHandler,
  HoverUrlSource,
  LayoutChangeHandler,
  TabHistorySnapshot,
  TogglePinnedDomainHandler,
  TogglePinnedSectionHandler
} from './types'
import type { WorkingSetSnapshot } from '../extension/types'
import type { CardPositionMap, MissionContainer } from '../extension/card-move-animation'
import type { MissionOrderMap } from '../hooks/useDashboardRefresh'

type MissionContainerRef = {
  current: HTMLDivElement | null
}

const PROGRESSIVE_CARD_THRESHOLD = 80
const PROGRESSIVE_CARD_INITIAL_COUNT = 24
const PROGRESSIVE_CARD_CHUNK_SIZE = 24

type MissionBlockProps = {
  activeHoverSource: HoverUrlSource | null
  activeHoverUrl: string
  activeHoverUrls: readonly string[]
  cards: DashboardCardEntry[]
  filter: string
  gridEmpty?: boolean
  gridId: string
  gridRef?: Ref<HTMLDivElement>
  onHoverUrlChange: HoverUrlChangeHandler
  onLayoutChange: LayoutChangeHandler
  onTogglePinnedDomain: TogglePinnedDomainHandler
  onTogglePinnedSection: TogglePinnedSectionHandler
  showEmptyState: boolean
  source: DashboardSource
}
type DashboardMissionSection = {
  cards: DashboardCardEntry[]
  gridEmpty?: boolean
  gridId: string
  gridRef?: Ref<HTMLDivElement>
  label?: string
  sectionClassName?: string
  sectionId?: string
  showEmptyState: boolean
  source: DashboardSource
}
type DashboardMissionSectionsOptions = {
  bookmarkMatchedCards: DashboardCardEntry[]
  bookmarkMatchesFlush: boolean
  bookmarkMissionsRef: Ref<HTMLDivElement>
  filter: string
  historyMatchedCards: DashboardCardEntry[]
  historyMatchesFlush: boolean
  historyMissionsRef: Ref<HTMLDivElement>
  isReady: boolean
  matchedCards: DashboardCardEntry[]
  otherTabsFlush: boolean
  primaryMissionsEmpty: boolean
  primaryMissionsRef: Ref<HTMLDivElement>
  showBookmarkMatches: boolean
  showHistoryMatches: boolean
  showOtherTabs: boolean
  showPrimaryEmptyState: boolean
  source: DashboardSource
  unmatchedCards: DashboardCardEntry[]
  unmatchedMissionsRef: Ref<HTMLDivElement>
}
type DashboardMissionsListProps = {
  activeHoverSource: HoverUrlSource | null
  activeHoverUrl: string
  activeHoverUrls: readonly string[]
  filter: string
  onHoverUrlChange: HoverUrlChangeHandler
  onLayoutChange: LayoutChangeHandler
  onTogglePinnedDomain: TogglePinnedDomainHandler
  onTogglePinnedSection: TogglePinnedSectionHandler
  sections: DashboardMissionSection[]
}
type ProgressiveCardsOptions = {
  chunkSize?: number
  enabled?: boolean
  initialCount?: number
  resetKey: string
  threshold?: number
}
type AppDashboardState = {
  closedTabs: readonly ClosedTabEntry[]
  dashboard: DashboardData | null
  historyRange: string
  source: DashboardSource
  tabHistory: TabHistorySnapshot | null
  workingSet: WorkingSetSnapshot | null
}
type AppDashboardAction =
  | { type: 'closedTabs'; closedTabs: readonly ClosedTabEntry[] }
  | { type: 'dashboard'; dashboard: DashboardData | null }
  | { type: 'historyRange'; historyRange: string }
  | { type: 'source'; source: DashboardSource }
  | { type: 'tabHistory'; tabHistory: TabHistorySnapshot | null }
  | { type: 'workingSet'; workingSet: WorkingSetSnapshot | null }
  | {
      type: 'sourceSnapshot'
      dashboard: DashboardData | null
      source: DashboardSource
      tabHistory: TabHistorySnapshot | null
      workingSet: WorkingSetSnapshot | null
    }

function initialAppDashboardState(dashboard: DashboardData | null): AppDashboardState {
  return {
    closedTabs: [],
    dashboard,
    historyRange: DEFAULT_HISTORY_RANGE,
    source: 'tabs',
    tabHistory: null,
    workingSet: null
  }
}

function appDashboardReducer(state: AppDashboardState, action: AppDashboardAction): AppDashboardState {
  switch (action.type) {
    case 'closedTabs':
      return state.closedTabs === action.closedTabs ? state : { ...state, closedTabs: action.closedTabs }
    case 'dashboard':
      return state.dashboard === action.dashboard ? state : { ...state, dashboard: action.dashboard }
    case 'historyRange':
      return state.historyRange === action.historyRange ? state : { ...state, historyRange: action.historyRange }
    case 'source':
      return state.source === action.source ? state : { ...state, source: action.source }
    case 'tabHistory':
      return state.tabHistory === action.tabHistory ? state : { ...state, tabHistory: action.tabHistory }
    case 'workingSet':
      return state.workingSet === action.workingSet ? state : { ...state, workingSet: action.workingSet }
    case 'sourceSnapshot':
      return {
        ...state,
        dashboard: action.dashboard,
        source: action.source,
        tabHistory: action.tabHistory,
        workingSet: action.workingSet
      }
  }
}

function readMissionContainers(...refs: MissionContainerRef[]): MissionContainer[] {
  return refs.map((ref) => ref.current)
}

function MissionsDivider({ label }: { label: string }) {
  return (
    <div className="missions-divider pointer-events-none mb-4 flex items-center gap-3 text-xs font-medium tracking-[0.6px] text-tab-muted uppercase">
      <hr className="missions-divider-rule h-px flex-1 border-0 bg-(--warm-gray)" />
      <span className="missions-divider-label shrink-0 whitespace-nowrap">{label}</span>
      <hr className="missions-divider-rule h-px flex-1 border-0 bg-(--warm-gray)" />
    </div>
  )
}

function MissionsGrid({ className, empty = false, ref, ...props }: ComponentPropsWithoutRef<'div'> & { empty?: boolean; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className={cn(
        'missions relative mt-0 mb-0 [--masonry-gap:10px] [--masonry-ideal-col-width:304px] [--masonry-min-col-width:260px] max-[560px]:[--masonry-ideal-col-width:280px] max-[560px]:[--masonry-min-col-width:240px] min-[1200px]:[--masonry-ideal-col-width:340px] min-[1200px]:[--masonry-min-col-width:280px]',
        empty && 'missions-empty',
        className
      )}
      {...props}
    />
  )
}

function useProgressiveCards(
  cards: DashboardCardEntry[],
  {
    chunkSize = PROGRESSIVE_CARD_CHUNK_SIZE,
    enabled = false,
    initialCount = PROGRESSIVE_CARD_INITIAL_COUNT,
    resetKey,
    threshold = PROGRESSIVE_CARD_THRESHOLD
  }: ProgressiveCardsOptions
) {
  const progressive = enabled && cards.length > threshold
  const initialVisibleCount = progressive ? Math.min(initialCount, cards.length) : cards.length
  const [state, setState] = useState({ resetKey, count: initialVisibleCount })
  const visibleCount = state.resetKey === resetKey ? Math.min(state.count, cards.length) : initialVisibleCount

  useEffect(() => {
    if (!progressive || visibleCount >= cards.length) return

    let disposed = false
    const appendNextChunk = () => {
      if (disposed) return
      setState((current) => {
        const currentCount = current.resetKey === resetKey ? current.count : initialVisibleCount
        const nextCount = Math.min(cards.length, currentCount + chunkSize)
        if (current.resetKey === resetKey && current.count === nextCount) return current
        return {
          resetKey,
          count: nextCount
        }
      })
    }

    const idleId = window.requestIdleCallback(appendNextChunk, { timeout: 160 })
    return () => {
      disposed = true
      window.cancelIdleCallback(idleId)
    }
  }, [cards.length, chunkSize, initialVisibleCount, progressive, resetKey, visibleCount])

  return {
    cards: progressive ? cards.slice(0, visibleCount) : cards
  }
}

function progressiveCardListKey(cards: DashboardCardEntry[]) {
  const first = cards[0]?.group
  const last = cards[cards.length - 1]?.group
  return `${cards.length}:${first ? domainGroupCardId(first) : ''}:${last ? domainGroupCardId(last) : ''}`
}

function MissionBlock({
  activeHoverSource,
  activeHoverUrl,
  activeHoverUrls,
  cards,
  filter,
  gridEmpty = false,
  gridId,
  gridRef,
  onHoverUrlChange,
  onLayoutChange,
  onTogglePinnedDomain,
  onTogglePinnedSection,
  showEmptyState,
  source
}: MissionBlockProps) {
  const progressiveEnabled = source !== 'tabs'
  const progressiveCards = useProgressiveCards(cards, {
    enabled: progressiveEnabled,
    resetKey: `${source}:${filter}:${progressiveCardListKey(cards)}`
  })

  return (
    <MissionsGrid empty={gridEmpty} id={gridId} ref={gridRef}>
      <Missions
        cards={progressiveCards.cards}
        filter={filter}
        source={source}
        showEmptyState={showEmptyState}
        onHoverUrlChange={onHoverUrlChange}
        activeHoverUrl={activeHoverUrl}
        activeHoverUrls={activeHoverUrls}
        activeHoverSource={activeHoverSource}
        onLayoutChange={onLayoutChange}
        onTogglePinnedDomain={onTogglePinnedDomain}
        onTogglePinnedSection={onTogglePinnedSection}
      />
    </MissionsGrid>
  )
}

function dashboardMissionSections({
  bookmarkMatchedCards,
  bookmarkMatchesFlush,
  bookmarkMissionsRef,
  historyMatchedCards,
  historyMatchesFlush,
  historyMissionsRef,
  isReady,
  matchedCards,
  otherTabsFlush,
  primaryMissionsEmpty,
  primaryMissionsRef,
  showBookmarkMatches,
  showHistoryMatches,
  showOtherTabs,
  showPrimaryEmptyState,
  source,
  unmatchedCards,
  unmatchedMissionsRef
}: DashboardMissionSectionsOptions): DashboardMissionSection[] {
  if (!isReady) return []

  const sections: DashboardMissionSection[] = [
    {
      cards: matchedCards,
      gridEmpty: primaryMissionsEmpty,
      gridId: 'openTabsMissions',
      gridRef: primaryMissionsRef,
      showEmptyState: showPrimaryEmptyState,
      source
    }
  ]

  if (showBookmarkMatches) {
    sections.push({
      cards: bookmarkMatchedCards,
      gridId: 'bookmarkMatchesMissions',
      gridRef: bookmarkMissionsRef,
      label: 'Bookmarks',
      sectionClassName: cn('missions-other missions-bookmarks mt-6', bookmarkMatchesFlush && 'mt-0'),
      sectionId: 'bookmarkMatchesSection',
      showEmptyState: false,
      source: 'bookmarks'
    })
  }

  if (showHistoryMatches) {
    sections.push({
      cards: historyMatchedCards,
      gridId: 'historyMatchesMissions',
      gridRef: historyMissionsRef,
      label: 'History',
      sectionClassName: cn('missions-other missions-history mt-6', historyMatchesFlush && 'mt-0'),
      sectionId: 'historyMatchesSection',
      showEmptyState: false,
      source: 'history'
    })
  }

  if (showOtherTabs) {
    sections.push({
      cards: unmatchedCards,
      gridId: 'openTabsMissionsUnmatched',
      gridRef: unmatchedMissionsRef,
      label: 'Other tabs',
      sectionClassName: cn('missions-other mt-6', otherTabsFlush && 'mt-0'),
      sectionId: 'openTabsMissionsOther',
      showEmptyState: false,
      source
    })
  }

  return sections
}

function DashboardMissionsList({
  activeHoverSource,
  activeHoverUrl,
  activeHoverUrls,
  filter,
  onHoverUrlChange,
  onLayoutChange,
  onTogglePinnedDomain,
  onTogglePinnedSection,
  sections
}: DashboardMissionsListProps) {
  if (sections.length === 0) return null

  return (
    <>
      {sections.map((section) => {
        const block = (
          <MissionBlock
            key={section.gridId}
            activeHoverSource={activeHoverSource}
            activeHoverUrl={activeHoverUrl}
            activeHoverUrls={activeHoverUrls}
            cards={section.cards}
            filter={filter}
            gridEmpty={section.gridEmpty}
            gridId={section.gridId}
            gridRef={section.gridRef}
            onHoverUrlChange={onHoverUrlChange}
            onLayoutChange={onLayoutChange}
            onTogglePinnedDomain={onTogglePinnedDomain}
            onTogglePinnedSection={onTogglePinnedSection}
            showEmptyState={section.showEmptyState}
            source={section.source}
          />
        )

        if (!section.label) return block
        return (
          <div className={section.sectionClassName} id={section.sectionId} key={section.sectionId}>
            <MissionsDivider label={section.label} />
            {block}
          </div>
        )
      })}
    </>
  )
}

type DashboardShellProps = {
  closedTabs: readonly ClosedTabEntry[]
  filter: string
  filterFocusRequest: number
  filterInput: string
  handleHoverUrlChange: HoverUrlChangeHandler
  handleScrollRegionRef: (node: HTMLDivElement | null) => void
  historyRange: string
  hoverMatch: HoverMatchState
  isReady: boolean
  isScrolled: boolean
  missionSections: DashboardMissionSection[]
  onCloseFiltered: () => void
  onDedupAll: () => void
  onSourceChange: (nextSource: DashboardSource) => void
  onTabsChange: () => void
  scheduleMissionsMasonry: LayoutChangeHandler
  setFilterInput: (value: string) => void
  setHistoryRange: (value: string) => void
  setTabHistory: (snapshot: TabHistorySnapshot | null) => void
  showHistoryRange: boolean
  source: DashboardSource
  stats: DashboardStats
  tabHistory: TabHistorySnapshot | null
  togglePinnedDomain: TogglePinnedDomainHandler
  togglePinnedSection: TogglePinnedSectionHandler
  urlPreview: { url: string; visible: boolean }
  workingSet: WorkingSetSnapshot | null
}

function DashboardShell({
  closedTabs,
  filter,
  filterFocusRequest,
  filterInput,
  handleHoverUrlChange,
  handleScrollRegionRef,
  historyRange,
  hoverMatch,
  isReady,
  isScrolled,
  missionSections,
  onCloseFiltered,
  onDedupAll,
  onSourceChange,
  onTabsChange,
  scheduleMissionsMasonry,
  setFilterInput,
  setHistoryRange,
  setTabHistory,
  showHistoryRange,
  source,
  stats,
  tabHistory,
  togglePinnedDomain,
  togglePinnedSection,
  urlPreview,
  workingSet
}: DashboardShellProps) {
  const showTabHistory = isReady && source === 'tabs'
  const historyWorkingSet = source === 'tabs' ? workingSet : null
  return (
    <TooltipProvider>
      <div
        data-tabout="dashboard-shell"
        className={cn(
          'dashboard-shell relative z-1 mx-auto grid min-h-0 w-full max-w-(--dashboard-shell-max-width) flex-auto',
          showTabHistory
            ? 'has-history items-stretch gap-4 grid-cols-[minmax(calc(220px_+_var(--dashboard-history-edge-gutter)),calc(260px_+_var(--dashboard-history-edge-gutter)))_minmax(0,1fr)] max-[900px]:[--dashboard-page-gutter:20px] max-[900px]:[--dashboard-history-edge-gutter:12px] max-[900px]:[--dashboard-scrollbar-inset:var(--dashboard-scrollbar-size)] max-[900px]:[&.has-history]:grid-cols-[minmax(0,1fr)] max-[900px]:[&.has-history]:gap-0'
            : 'grid-cols-[minmax(0,1fr)]',
          source === 'bookmarks' && 'is-bookmarks'
        )}
      >
        {showTabHistory && (
          <TabHistoryPanel
            snapshot={tabHistory}
            closedTabs={closedTabs}
            onSnapshotChange={setTabHistory}
            onHoverUrlChange={handleHoverUrlChange}
            activeHoverUrl={hoverMatch.url}
            activeHoverUrls={hoverMatch.urls}
            activeHoverSource={hoverMatch.source}
            workingSet={historyWorkingSet}
            filter={filter}
            onTabsChange={onTabsChange}
          />
        )}
        <div
          className={cn(
            'dashboard-main flex min-h-0 min-w-0 flex-col',
            showTabHistory
              ? 'col-2 pr-(--dashboard-page-gutter) pl-0 max-[900px]:[.dashboard-shell.has-history_&]:col-1 max-[900px]:[.dashboard-shell.has-history_&]:px-(--dashboard-page-gutter)'
              : 'col-1 px-(--dashboard-page-gutter)'
          )}
        >
          <div
            className={cn(
              'pinned-top relative z-10 flex-none mr-[calc(0px-var(--dashboard-edge-bleed))] pt-[12px] pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))] pb-[12px] [--header-shadow-padding-fade:calc(var(--dashboard-edge-bleed)_+_var(--dashboard-scroll-gutter))] [--header-shadow-left-reserve:56px] [--header-shadow-left-fade:18px]',
              isScrolled && 'is-scrolled shadow-none',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))]'
                : 'ml-[calc(0px-var(--header-shadow-left-reserve))] pl-(--header-shadow-left-reserve)',
              showTabHistory && '[clip-path:inset(0_0_-16px_calc(0px_-_var(--header-shadow-left-reserve)))] focus-within:[clip-path:inset(-4px_-4px_-16px_calc(0px_-_var(--header-shadow-left-reserve)_-_4px))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-padding-fade:var(--dashboard-edge-bleed)] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-left-reserve:var(--dashboard-edge-bleed)] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:ml-[calc(0px-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:px-(--dashboard-edge-bleed)'
            )}
          >
            <HeaderBar
              source={source}
              totalTabs={stats.totalTabs}
              activeTabs={stats.activeTabs}
              visibleTabs={stats.visibleTabs}
              totalWindows={stats.totalWindows}
              visibleWindows={stats.visibleWindows}
              totalDomains={stats.totalDomains}
              visibleDomains={stats.visibleDomains}
              dedupCount={stats.dedupCount}
              filteredCloseCount={stats.filteredCloseCount}
              hasCards={stats.hasCards}
              filtering={stats.filtering}
              ready={isReady}
              filter={filterInput}
              filterFocusRequest={filterFocusRequest}
              historyRange={historyRange}
              showHistoryRange={showHistoryRange}
              onFilterChange={setFilterInput}
              onHistoryRangeChange={setHistoryRange}
              onSourceChange={onSourceChange}
              onCloseFiltered={onCloseFiltered}
              onDedupAll={onDedupAll}
            />
          </div>

          <div
            data-tabout-part="scroll-region"
            className={cn(
              'scroll-region relative z-1 flex-auto min-h-0 overflow-x-hidden overflow-y-auto overscroll-x-none overscroll-y-contain mr-[calc(0px-var(--dashboard-edge-bleed))] pt-[6px] pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))] pb-[50px] [scrollbar-gutter:stable] [scrollbar-color:var(--dashboard-scrollbar-thumb-bg)_transparent] [scrollbar-width:auto] max-[900px]:[.dashboard-main_>&]:mr-[calc(var(--dashboard-scrollbar-inset)-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))]',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed)-var(--dashboard-card-shadow-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-card-shadow-bleed))]'
                : 'ml-[calc(0px-var(--dashboard-card-shadow-bleed))] pl-(--dashboard-card-shadow-bleed)'
            )}
            ref={handleScrollRegionRef}
          >
            <DashboardMissionsList
              activeHoverSource={hoverMatch.source}
              activeHoverUrl={hoverMatch.url}
              activeHoverUrls={hoverMatch.urls}
              filter={filter}
              onHoverUrlChange={handleHoverUrlChange}
              onLayoutChange={scheduleMissionsMasonry}
              onTogglePinnedDomain={togglePinnedDomain}
              onTogglePinnedSection={togglePinnedSection}
              sections={missionSections}
            />
          </div>
        </div>
      </div>

      <UrlPreview url={urlPreview.url} visible={urlPreview.visible} />
    </TooltipProvider>
  )
}

export function App({ initialDashboard = null }: { initialDashboard?: DashboardData | null }) {
  const [appDashboard, dispatchAppDashboard] = useReducer(appDashboardReducer, initialDashboard, initialAppDashboardState)
  const { closedTabs, dashboard, historyRange, source, tabHistory, workingSet } = appDashboard
  const [, startSourceTransition] = useTransition()
  const { hoverMatch, urlPreview, handleHoverUrlChange, clearHoverUrlNow } = useHoverMatch()
  const { isScrolled, handleScrollRegionRef } = useScrollShadow()
  function setClosedTabs(next: readonly ClosedTabEntry[]) {
    dispatchAppDashboard({ type: 'closedTabs', closedTabs: next })
  }
  function setDashboard(nextDashboard: DashboardData | null) {
    dispatchAppDashboard({ type: 'dashboard', dashboard: nextDashboard })
  }
  function setHistoryRange(nextHistoryRange: string) {
    dispatchAppDashboard({ type: 'historyRange', historyRange: nextHistoryRange })
  }
  function setTabHistory(nextTabHistory: TabHistorySnapshot | null) {
    dispatchAppDashboard({ type: 'tabHistory', tabHistory: nextTabHistory })
  }
  function setWorkingSet(nextWorkingSet: WorkingSetSnapshot | null) {
    dispatchAppDashboard({ type: 'workingSet', workingSet: nextWorkingSet })
  }
  const closedTabsSeqRef = useRef(0)
  const refreshClosedTabs = useCallback(async function refreshClosedTabs() {
    if (isClosedTabFetchSuppressed()) return
    const seq = ++closedTabsSeqRef.current
    // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await seq comparison is a stale-response race guard; it must run after the await.
    const next = await fetchClosedTabs()
    if (seq !== closedTabsSeqRef.current) return
    setClosedTabs(next)
  }, [])

  useEffect(() => {
    void refreshClosedTabs()
    return subscribeClosedTabChanges(() => { void refreshClosedTabs() })
  }, [refreshClosedTabs])

  const sourceSwitchSeqRef = useRef(0)
  const layoutMoveRectsRef = useRef<CardPositionMap | null>(null)
  const previousOrderRef = useRef<MissionOrderMap>({
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map()
  })
  const chipOrderRef = useRef<DashboardChipOrderMemoryMap>({
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map()
  })
  const primaryMissionsRef = useRef<HTMLDivElement | null>(null)
  const bookmarkMissionsRef = useRef<HTMLDivElement | null>(null)
  const historyMissionsRef = useRef<HTMLDivElement | null>(null)
  const unmatchedMissionsRef = useRef<HTMLDivElement | null>(null)
  const isReady = !!dashboard
  const historyFilterEnabled = isHistoryFilterEnabled(historyRange)
  const { packMissionsMasonryNow, scheduleMissionsMasonry } = useMissionsMasonry(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef, {
    onBeforePack: prepareDomainCardMoveAnimation,
    onAfterPack: animateDomainCardMoves
  })

  const currentMissionContainers = useCallback(function currentMissionContainers() {
    return readMissionContainers(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef)
  }, [])

  const primeCardMoveAnimation = useCallback(function primeCardMoveAnimation() {
    layoutMoveRectsRef.current = prepareDomainCardMoveAnimation(currentMissionContainers())
  }, [currentMissionContainers])

  const { filterInput, filter, filterFocusRequest, setFilterInput } = useFilterRouting({ onBeforeFilterCommit: primeCardMoveAnimation })
  function resetMissionOrder() {
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
    chipOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
  }
  const { pinnedDomains, pinsLoaded, togglePinnedDomain } = usePinnedDomains({
    onBeforeApplyPinnedDomains: resetMissionOrder,
    onSaveError: () => showToast('Could not save pinned domain')
  })
  const { pinnedSections, togglePinnedSection } = usePinnedSections({
    onSaveError: () => showToast('Could not save pinned section')
  })
  const refreshDashboard = useDashboardRefresh({
    dashboard,
    source,
    filter,
    historyRange,
    historyFilterEnabled,
    pinnedDomains,
    pinsLoaded,
    previousOrder: previousOrderRef.current,
    setDashboard,
    setTabHistory,
    setWorkingSet,
    onBeforeAnimatedRefresh: primeCardMoveAnimation,
    onBeforePinnedRefresh: clearHoverUrlNow
  })

  useLayoutEffect(() => {
    if (!isReady) return
    clearHoverUrlNow()
    const containers = readMissionContainers(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef)
    const previousRects = layoutMoveRectsRef.current
    layoutMoveRectsRef.current = null
    if (!previousRects) cancelDomainCardMoves(containers)
    packMissionsMasonryNow({ unpin: true })
    if (previousRects) animateDomainCardMoves(containers, previousRects)
  }, [dashboard, filter, source, isReady, clearHoverUrlNow, packMissionsMasonryNow])

  const {
    dashboardVm,
    stats,
    matchedCards,
    unmatchedCards,
    bookmarkMatchedCards,
    historyMatchedCards,
    showOtherTabs,
    showBookmarkMatches,
    showHistoryMatches,
    showHistoryRange,
    showPrimaryEmptyState
  } = useDashboardViewModels({
    dashboard,
    source,
    filter,
    historyRange,
    historyFilterEnabled,
    isReady,
    chipOrder: chipOrderRef.current,
    workingSet,
    pinnedSections
  })

  async function onCloseFiltered() {
    await closeFilteredTabs(dashboardVm.filteredCloseUrls)
  }

  async function onDedupAll() {
    await dedupeTabs({ urls: dashboardVm.globalDedupeUrls, preservePinnedTabOut: true })
  }

  function onSourceChange(nextSource: DashboardSource) {
    if (nextSource === source) return
    const requestId = ++sourceSwitchSeqRef.current
    const previousRects = prepareDomainCardMoveAnimation(currentMissionContainers())
    clearHoverUrlNow()
    void fetchDashboardSnapshot({
      source: nextSource,
      filter,
      historyRange,
      historyFilterEnabled,
      pinnedDomains,
      previousOrder: previousOrderRef.current
    }).then(({ dashboard: nextDashboard, tabHistory: nextTabHistory, workingSet: nextWorkingSet }) => {
      if (requestId !== sourceSwitchSeqRef.current) return
      layoutMoveRectsRef.current = previousRects
      startSourceTransition(() => {
        dispatchAppDashboard({
          type: 'sourceSnapshot',
          dashboard: nextDashboard,
          source: nextSource,
          tabHistory: nextTabHistory,
          workingSet: nextWorkingSet
        })
      })
    })
  }

  const primaryMissionsEmpty = matchedCards.length === 0
  const bookmarkMatchesFlush = primaryMissionsEmpty
  const historyMatchesFlush = primaryMissionsEmpty && !showBookmarkMatches
  const otherTabsFlush = primaryMissionsEmpty && !showBookmarkMatches && !showHistoryMatches
  const missionSections = dashboardMissionSections({
    bookmarkMatchedCards,
    bookmarkMatchesFlush,
    bookmarkMissionsRef,
    filter,
    historyMatchedCards,
    historyMatchesFlush,
    historyMissionsRef,
    isReady,
    matchedCards,
    otherTabsFlush,
    primaryMissionsEmpty,
    primaryMissionsRef,
    showBookmarkMatches,
    showHistoryMatches,
    showOtherTabs,
    showPrimaryEmptyState,
    source,
    unmatchedCards,
    unmatchedMissionsRef
  })

  useMissionOrderMemory({
    previousOrderRef,
    chipOrderRef,
    source,
    filter,
    matchedCards,
    bookmarkMatchedCards,
    historyMatchedCards
  })

  return (
    <DashboardShell
      closedTabs={closedTabs}
      filter={filter}
      filterFocusRequest={filterFocusRequest}
      filterInput={filterInput}
      handleHoverUrlChange={handleHoverUrlChange}
      handleScrollRegionRef={handleScrollRegionRef}
      historyRange={historyRange}
      hoverMatch={hoverMatch}
      isReady={isReady}
      isScrolled={isScrolled}
      missionSections={missionSections}
      onCloseFiltered={onCloseFiltered}
      onDedupAll={onDedupAll}
      onSourceChange={onSourceChange}
      onTabsChange={() => refreshDashboard({ animateCards: true })}
      scheduleMissionsMasonry={scheduleMissionsMasonry}
      setFilterInput={setFilterInput}
      setHistoryRange={setHistoryRange}
      setTabHistory={setTabHistory}
      showHistoryRange={showHistoryRange}
      source={source}
      stats={stats}
      tabHistory={tabHistory}
      togglePinnedDomain={togglePinnedDomain}
      togglePinnedSection={togglePinnedSection}
      urlPreview={urlPreview}
      workingSet={workingSet}
    />
  )
}

export function mountApp(initialDashboard: DashboardData | null = null) {
  const el = document.getElementById('appRoot')
  if (!el) return
  createRoot(el).render(<App initialDashboard={initialDashboard} />)
}
