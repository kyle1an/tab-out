import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ComponentPropsWithoutRef, type Ref } from 'react'
import { createRoot } from 'react-dom/client'
import { useMissionsMasonry } from '../extension/layout.js'
import { showToast } from '../extension/toast.js'
import { DEFAULT_HISTORY_RANGE, isHistoryFilterEnabled } from '../extension/history-source.js'
import { animateDomainCardMoves, cancelDomainCardMoves, prepareDomainCardMoveAnimation } from '../extension/card-move-animation'
import { closeFilteredTabs, dedupeTabs } from '../extension/tab-actions'
import { fetchDashboardSnapshot, useDashboardRefresh } from '../hooks/useDashboardRefresh'
import { useDashboardViewModels, useMissionOrderMemory, type DashboardChipOrderMemoryMap } from '../hooks/useDashboardViewModels'
import { useFilterRouting } from '../hooks/useFilterRouting'
import { usePinnedDomains } from '../hooks/usePinnedDomains'
import { useUrlPreview } from '../hooks/useUrlPreview'
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
  HoverUrlChangeHandler,
  HoverUrlSource,
  LayoutChangeHandler,
  TabHistorySnapshot,
  TogglePinnedDomainHandler
} from './types'
import type { WorkingSetSnapshot } from '../extension/types'
import type { CardPositionMap, MissionContainer } from '../extension/card-move-animation'
import type { MissionOrderMap } from '../hooks/useDashboardRefresh'

type MissionContainerRef = {
  current: HTMLDivElement | null
}

type HoverMatchState = {
  url: string
  urls: string[]
  source: HoverUrlSource | null
}
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
  sections: DashboardMissionSection[]
}
type AppDashboardState = {
  dashboard: DashboardData | null
  historyRange: string
  source: DashboardSource
  tabHistory: TabHistorySnapshot | null
  workingSet: WorkingSetSnapshot | null
}
type AppDashboardAction =
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
    dashboard,
    historyRange: DEFAULT_HISTORY_RANGE,
    source: 'tabs',
    tabHistory: null,
    workingSet: null
  }
}

function appDashboardReducer(state: AppDashboardState, action: AppDashboardAction): AppDashboardState {
  switch (action.type) {
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
  showEmptyState,
  source
}: MissionBlockProps) {
  return (
    <MissionsGrid empty={gridEmpty} id={gridId} ref={gridRef}>
      <Missions
        cards={cards}
        filter={filter}
        source={source}
        showEmptyState={showEmptyState}
        onHoverUrlChange={onHoverUrlChange}
        activeHoverUrl={activeHoverUrl}
        activeHoverUrls={activeHoverUrls}
        activeHoverSource={activeHoverSource}
        onLayoutChange={onLayoutChange}
        onTogglePinnedDomain={onTogglePinnedDomain}
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

export function App({ initialDashboard = null }: { initialDashboard?: DashboardData | null }) {
  const [appDashboard, dispatchAppDashboard] = useReducer(appDashboardReducer, initialDashboard, initialAppDashboardState)
  const { dashboard, historyRange, source, tabHistory, workingSet } = appDashboard
  const { urlPreview, setUrlPreview, clearUrlPreviewNow } = useUrlPreview()
  const [hoverMatch, setHoverMatch] = useState<HoverMatchState>({ url: '', urls: [], source: null })
  const [isScrolled, setIsScrolled] = useState(false)
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
  const scrollRegionRef = useRef<HTMLDivElement | null>(null)
  const primaryMissionsRef = useRef<HTMLDivElement | null>(null)
  const bookmarkMissionsRef = useRef<HTMLDivElement | null>(null)
  const historyMissionsRef = useRef<HTMLDivElement | null>(null)
  const unmatchedMissionsRef = useRef<HTMLDivElement | null>(null)
  const handleScrollRegionRef = useCallback((node: HTMLDivElement | null) => {
    scrollRegionRef.current = node
    const next = (node?.scrollTop || 0) > 0
    setIsScrolled((prev) => (prev === next ? prev : next))
  }, [])
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

  function sameHoverUrls(a: readonly string[], b: readonly string[]) {
    return a.length === b.length && a.every((url, index) => url === b[index])
  }

  function handleHoverUrlChange(url: string, source: HoverUrlSource = 'chip', matchUrls?: readonly string[]) {
    const nextUrl = url || ''
    const nextUrls = nextUrl
      ? [...new Set((matchUrls && matchUrls.length > 0 ? matchUrls : [nextUrl]).filter(Boolean))]
      : []
    const nextSource = nextUrls.length > 0 ? source : null
    setHoverMatch((current) => (
      current.url === nextUrl && current.source === nextSource && sameHoverUrls(current.urls, nextUrls)
        ? current
        : { url: nextUrl, urls: nextUrls, source: nextSource }
    ))
    setUrlPreview(nextUrl)
  }

  const clearHoverUrlNow = useCallback(function clearHoverUrlNow() {
    setHoverMatch((current) => (current.url || current.urls.length > 0 || current.source ? { url: '', urls: [], source: null } : current))
    clearUrlPreviewNow()
  }, [clearUrlPreviewNow])

  const { filterInput, filter, filterFocusRequest, setFilterInput } = useFilterRouting({ onBeforeFilterCommit: primeCardMoveAnimation })
  function resetMissionOrder() {
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
    chipOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
  }
  const { pinnedDomains, pinsLoaded, togglePinnedDomain } = usePinnedDomains({
    onBeforeApplyPinnedDomains: resetMissionOrder,
    onSaveError: () => showToast('Could not save pinned domain')
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

  useEffect(() => {
    const scrollEl = scrollRegionRef.current
    if (!scrollEl) return
    const scrollTarget = scrollEl

    function onScroll() {
      const next = scrollTarget.scrollTop > 0
      setIsScrolled((prev) => (prev === next ? prev : next))
    }

    scrollTarget.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollTarget.removeEventListener('scroll', onScroll)
  }, [])

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
    workingSet
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
      dispatchAppDashboard({
        type: 'sourceSnapshot',
        dashboard: nextDashboard,
        source: nextSource,
        tabHistory: nextTabHistory,
        workingSet: nextWorkingSet
      })
    })
  }

  const showTabHistory = isReady && source === 'tabs'
  const historyWorkingSet = source === 'tabs' && filter.trim() === '' ? workingSet : null
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
    <TooltipProvider>
      <div
        data-tabout="dashboard-shell"
        className={cn(
          'dashboard-shell',
          showTabHistory && 'has-history max-[900px]:[--dashboard-page-gutter:20px] max-[900px]:[--dashboard-history-edge-gutter:12px] max-[900px]:[--dashboard-scrollbar-inset:6px] max-[900px]:[&.has-history]:grid-cols-[minmax(0,1fr)] max-[900px]:[&.has-history]:gap-0',
          source === 'bookmarks' && 'is-bookmarks'
        )}
      >
        {showTabHistory && (
          <TabHistoryPanel
            snapshot={tabHistory}
            onSnapshotChange={setTabHistory}
            onHoverUrlChange={handleHoverUrlChange}
            activeHoverUrl={hoverMatch.url}
            activeHoverUrls={hoverMatch.urls}
            activeHoverSource={hoverMatch.source}
            workingSet={historyWorkingSet}
            onTabsChange={() => refreshDashboard({ animateCards: true })}
          />
        )}
        <div className={cn('dashboard-main', showTabHistory && 'max-[900px]:[.dashboard-shell.has-history_&]:[grid-column:1] max-[900px]:[.dashboard-shell.has-history_&]:px-[var(--dashboard-page-gutter)]')}>
          <div
            className={cn(
              'pinned-top',
              isScrolled && 'is-scrolled',
              showTabHistory && 'max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-padding-fade:var(--dashboard-edge-bleed)] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-left-reserve:var(--dashboard-edge-bleed)] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:ml-[calc(0px-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:px-[var(--dashboard-edge-bleed)]'
            )}
          >
            <HeaderBar
              source={source}
              totalTabs={stats.totalTabs}
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
            className="scroll-region max-[900px]:[.dashboard-main_>&]:mr-[calc(var(--dashboard-scrollbar-inset)-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))] max-[900px]:[&::-webkit-scrollbar]:w-1"
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
              sections={missionSections}
            />
          </div>
        </div>
      </div>

      <UrlPreview url={urlPreview.url} visible={urlPreview.visible} />
    </TooltipProvider>
  )
}

export function mountApp(initialDashboard: DashboardData | null = null) {
  const el = document.getElementById('appRoot')
  if (!el) return
  createRoot(el).render(<App initialDashboard={initialDashboard} />)
}
