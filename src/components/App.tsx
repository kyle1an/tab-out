import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, useTransition, type ComponentPropsWithoutRef, type ReactNode, type Ref } from 'react'
import { createRoot } from 'react-dom/client'
import { fetchClosedTabs, isClosedTabFetchSuppressed, subscribeClosedTabChanges, type ClosedTabEntry } from '../extension/closed-tabs.js'
import { useMissionsMasonry } from '../extension/layout.js'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { showToast } from '../extension/toast.js'
import { DEFAULT_HISTORY_RANGE, isHistoryFilterEnabled } from '../extension/history-source.js'
import { animateDomainCardMoves, cancelDomainCardMoves, prepareDomainCardMoveAnimation } from '../extension/card-move-animation'
import { closeFilteredTabs, dedupeTabs } from '../extension/tab-actions'
import { fetchDashboardSnapshot, useDashboardRefresh, type DashboardStartupSnapshot } from '../hooks/useDashboardRefresh'
import { useDashboardLocalState, type DashboardLocalState } from '../hooks/useDashboardLocalState'
import { useDashboardViewModels, useMissionOrderMemory, type DashboardChipOrderMemoryMap } from '../hooks/useDashboardViewModels'
import { useFilterRouting } from '../hooks/useFilterRouting'
import { useHoverMatch } from '../hooks/useHoverMatch'
import { useScrollShadow } from '../hooks/useScrollShadow'
import { HeaderBar, HistoryRangeSelect } from './HeaderBar'
import { Missions } from './Missions'
import { TabHistoryPanel } from './TabHistoryPanel'
import { TooltipProvider } from './ui/tooltip'
import { UrlPreview } from './UrlPreview'
import { DashboardActionsProvider, HoverStateProvider } from './DashboardInteractionContext'
import { STARTUP_ORDER_DEBUG_CAPTURE, recordStartupOrderDebugVmSample, startStartupOrderDebugDomSampling } from './startup-order-debug'
import { cn } from '@/lib/utils'
import type {
  DashboardCardEntry,
  DashboardData,
  DashboardSource,
  DashboardStats,
  TabHistorySnapshot
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
  cards: DashboardCardEntry[]
  filter: string
  gridEmpty?: boolean
  gridId: string
  gridRef?: Ref<HTMLDivElement>
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
  showHistoryRange: boolean
  showOtherTabs: boolean
  showPrimaryEmptyState: boolean
  source: DashboardSource
  unmatchedCards: DashboardCardEntry[]
  unmatchedMissionsRef: Ref<HTMLDivElement>
}
type DashboardMissionsListProps = {
  filter: string
  historyRangeAction?: ReactNode
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
      type: 'startupSnapshot'
      snapshot: DashboardStartupSnapshot
    }
  | {
      type: 'sourceSnapshot'
      dashboard: DashboardData | null
      source: DashboardSource
      tabHistory: TabHistorySnapshot | null
      workingSet: WorkingSetSnapshot | null
    }

function initialAppDashboardState(snapshot: DashboardStartupSnapshot | null): AppDashboardState {
  return {
    closedTabs: snapshot?.closedTabs ?? [],
    dashboard: snapshot?.dashboard ?? null,
    historyRange: DEFAULT_HISTORY_RANGE,
    source: 'tabs',
    tabHistory: snapshot?.tabHistory ?? null,
    workingSet: snapshot?.workingSet ?? null
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
    case 'startupSnapshot':
      return {
        ...state,
        closedTabs: action.snapshot.closedTabs,
        dashboard: action.snapshot.dashboard,
        tabHistory: action.snapshot.tabHistory,
        workingSet: action.snapshot.workingSet
      }
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

function MissionsDivider({ action, label }: { action?: ReactNode; label: string }) {
  return (
    <div className={cn('missions-divider mb-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 text-xs font-medium tracking-[0.6px] text-tab-muted uppercase', action && 'min-h-(--header-control-height)')}>
      <div className={cn('missions-divider-line flex min-w-0 items-center', action && 'gap-2')}>
        {action && <div className="missions-divider-action shrink-0 text-tab-ink normal-case tracking-normal font-normal">{action}</div>}
        <hr className="missions-divider-rule h-px flex-1 border-0 bg-(--warm-gray)" />
      </div>
      <span className="missions-divider-label pointer-events-none shrink-0 whitespace-nowrap">{label}</span>
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
  cards,
  filter,
  gridEmpty = false,
  gridId,
  gridRef,
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
  showHistoryRange,
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

  if (showHistoryRange || showHistoryMatches) {
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

function DashboardMissionsList({ filter, historyRangeAction, sections }: DashboardMissionsListProps) {
  if (sections.length === 0) return null

  return (
    <>
      {sections.map((section) => {
        const block = (
          <MissionBlock
            key={section.gridId}
            cards={section.cards}
            filter={filter}
            gridEmpty={section.gridEmpty}
            gridId={section.gridId}
            gridRef={section.gridRef}
            showEmptyState={section.showEmptyState}
            source={section.source}
          />
        )

        if (!section.label) return block
        const action = section.sectionId === 'historyMatchesSection' ? historyRangeAction : undefined
        return (
          <div className={section.sectionClassName} id={section.sectionId} key={section.sectionId}>
            <MissionsDivider action={action} label={section.label} />
            {block}
          </div>
        )
      })}
    </>
  )
}

type DashboardShellProps = {
  closedTabs: readonly ClosedTabEntry[]
  savedKeys?: readonly string[]
  filter: string
  filterFocusRequest: number
  filterInput: string
  handleScrollRegionRef: (node: HTMLDivElement | null) => void
  historyRange: string
  isReady: boolean
  isScrolled: boolean
  missionSections: DashboardMissionSection[]
  onCloseFiltered: () => void
  onDedupAll: () => void
  onSourceChange: (nextSource: DashboardSource) => void
  onTabsChange: () => void
  setFilterInput: (value: string) => void
  setHistoryRange: (value: string) => void
  setTabHistory: (snapshot: TabHistorySnapshot | null) => void
  showHistoryRange: boolean
  source: DashboardSource
  stats: DashboardStats
  tabHistory: TabHistorySnapshot | null
  urlPreview: { url: string; visible: boolean }
  workingSet: WorkingSetSnapshot | null
}

function DashboardShell({
  closedTabs,
  savedKeys,
  filter,
  filterFocusRequest,
  filterInput,
  handleScrollRegionRef,
  historyRange,
  isReady,
  isScrolled,
  missionSections,
  onCloseFiltered,
  onDedupAll,
  onSourceChange,
  onTabsChange,
  setFilterInput,
  setHistoryRange,
  setTabHistory,
  showHistoryRange,
  source,
  stats,
  tabHistory,
  urlPreview,
  workingSet
}: DashboardShellProps) {
  // Reserve the Tabs-source history column during the initial dashboard fetch so
  // the header does not shift when the first snapshot arrives.
  const showTabHistory = source === 'tabs'
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
            workingSet={historyWorkingSet}
            filter={filter}
            savedKeys={savedKeys}
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
              'pinned-top relative z-10 flex-none mr-[calc(0px-var(--dashboard-edge-bleed))] pt-[12px] pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-scrollbar-size))] pb-[12px] [--header-shadow-padding-fade:calc(var(--dashboard-edge-bleed)_+_var(--dashboard-scroll-gutter)_+_var(--dashboard-scrollbar-size))] [--header-shadow-left-reserve:56px] [--header-shadow-left-fade:18px]',
              isScrolled && 'is-scrolled shadow-none',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))]'
                : 'ml-[calc(0px-var(--header-shadow-left-reserve))] pl-(--header-shadow-left-reserve)',
              showTabHistory && '[clip-path:inset(0_0_-16px_calc(0px_-_var(--header-shadow-left-reserve)))] focus-within:[clip-path:inset(-4px_-4px_-16px_calc(0px_-_var(--header-shadow-left-reserve)_-_4px))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-padding-fade:calc(var(--dashboard-edge-bleed)_+_var(--dashboard-scrollbar-size))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-left-reserve:var(--dashboard-edge-bleed)] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:ml-[calc(0px-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:pl-(--dashboard-edge-bleed) max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scrollbar-size))]'
            )}
          >
            <HeaderBar
              source={source}
              stats={stats}
              ready={isReady}
              filter={filterInput}
              filterFocusRequest={filterFocusRequest}
              historyRange={historyRange}
              onFilterChange={setFilterInput}
              onSourceChange={onSourceChange}
              onCloseFiltered={onCloseFiltered}
              onDedupAll={onDedupAll}
            />
          </div>

          <div
            data-tabout-part="scroll-region"
            className={cn(
              'scroll-region relative z-1 flex-auto min-h-0 overflow-x-hidden overflow-y-auto overscroll-x-none overscroll-y-contain mr-[calc(0px-var(--dashboard-edge-bleed))] pt-[6px] pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))] pb-[50px] [scrollbar-gutter:stable] max-[900px]:[.dashboard-main_>&]:mr-[calc(var(--dashboard-scrollbar-size)-var(--dashboard-scrollbar-thumb-size)-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-size)+var(--dashboard-scrollbar-thumb-size))]',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed)-var(--dashboard-card-shadow-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-card-shadow-bleed))]'
                : 'ml-[calc(0px-var(--dashboard-card-shadow-bleed))] pl-(--dashboard-card-shadow-bleed)'
            )}
            ref={handleScrollRegionRef}
          >
            <DashboardMissionsList
              filter={filter}
              historyRangeAction={showHistoryRange ? (
                <HistoryRangeSelect
                  value={historyRange}
                  onValueChange={setHistoryRange}
                />
              ) : undefined}
              sections={missionSections}
            />
          </div>
        </div>
      </div>

      <UrlPreview url={urlPreview.url} visible={urlPreview.visible} />
    </TooltipProvider>
  )
}

export function App({
  initialStartupSnapshot = null,
  initialLocalState = null
}: {
  initialStartupSnapshot?: DashboardStartupSnapshot | null
  initialLocalState?: DashboardLocalState | null
}) {
  const [appDashboard, dispatchAppDashboard] = useReducer(appDashboardReducer, initialStartupSnapshot, initialAppDashboardState)
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
  function setStartupSnapshot(snapshot: DashboardStartupSnapshot) {
    dispatchAppDashboard({ type: 'startupSnapshot', snapshot })
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
  const startupRefreshRequestedRef = useRef(false)
  const refreshClosedTabs = useCallback(async function refreshClosedTabs() {
    if (isClosedTabFetchSuppressed()) return
    const seq = ++closedTabsSeqRef.current
    // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await seq comparison is a stale-response race guard; it must run after the await.
    const next = await fetchClosedTabs()
    if (seq !== closedTabsSeqRef.current) return
    setClosedTabs(next)
  }, [])

  useEffect(() => {
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

  const [startupPriorityWorkingSet, setStartupPriorityWorkingSet] = useState<WorkingSetSnapshot | null>(() => initialStartupSnapshot?.workingSet ?? null)
  const handleBeforeFilterCommit = useCallback(function handleBeforeFilterCommit() {
    setStartupPriorityWorkingSet(null)
    primeCardMoveAnimation()
  }, [primeCardMoveAnimation])
  const { filterInput, filter, filterFocusRequest, setFilterInput } = useFilterRouting({ onBeforeFilterCommit: handleBeforeFilterCommit })
  const effectiveStartupPriorityWorkingSet = source === 'tabs' && filter.trim() === '' ? startupPriorityWorkingSet : null
  function resetMissionOrder() {
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
    chipOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
  }
  const {
    localStateLoaded,
    localState,
    pinnedDomains,
    pinnedSections,
    pinnedPageChips,
    togglePinnedDomain,
    reorderPinnedDomain,
    togglePinnedSection,
    togglePinnedPageChip
  } = useDashboardLocalState({
    initialState: initialLocalState,
    onBeforeApplyPinnedDomains: ({ animate }) => {
      resetMissionOrder()
      if (animate) primeCardMoveAnimation()
    },
    onDomainPinSaveError: () => showToast('Could not save pinned domain'),
    onSectionPinSaveError: () => showToast('Could not save pinned section'),
    onPageChipPinSaveError: () => showToast('Could not save pinned page')
  })
  // react-doctor-disable-next-line react-hooks-js/refs -- the order/chip refs are mutable caches the refresh reads at call time, intentionally outside React's render-tracked state.
  const refreshDashboard = useDashboardRefresh({
    dashboard,
    source,
    filter,
    historyRange,
    historyFilterEnabled,
    pinnedDomains,
    localStateLoaded,
    localState,
    // react-doctor-disable-next-line react-hooks-js/refs -- previousOrder is a mutable ordering cache read at refresh time, not render-derived state.
    previousOrder: previousOrderRef.current,
    setDashboard,
    setStartupSnapshot,
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
    // react-doctor-disable-next-line react-hooks-js/refs -- chipOrder is a mutable per-source ordering cache read at view-model build time, not render-derived state.
    chipOrder: chipOrderRef.current,
    workingSet: effectiveStartupPriorityWorkingSet ?? workingSet,
    freezeTabsChipOrder: !!effectiveStartupPriorityWorkingSet,
    pinnedSections,
    pinnedPageChips
  })

  useLayoutEffect(() => {
    recordStartupOrderDebugVmSample(STARTUP_ORDER_DEBUG_CAPTURE, {
      dashboard,
      source,
      filter,
      isReady,
      matchedCards,
      workingSet: effectiveStartupPriorityWorkingSet ?? workingSet
    })
  }, [dashboard, effectiveStartupPriorityWorkingSet, filter, isReady, matchedCards, source, workingSet])

  useLayoutEffect(() => {
    return startStartupOrderDebugDomSampling(STARTUP_ORDER_DEBUG_CAPTURE)
  }, [])

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
    setStartupPriorityWorkingSet(null)
    clearHoverUrlNow()
    void (async () => {
      try {
        if (requestId !== sourceSwitchSeqRef.current) return
        // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await requestId comparison is a stale-response race guard; it must run after the await.
        const { dashboard: nextDashboard, tabHistory: nextTabHistory, workingSet: nextWorkingSet } = await fetchDashboardSnapshot({
          source: nextSource,
          filter,
          historyRange,
          historyFilterEnabled,
          pinnedDomains,
          previousOrder: previousOrderRef.current
        })
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
      } catch {}
    })()
  }

  const primaryMissionsEmpty = matchedCards.length === 0
  const showHistorySection = showHistoryRange || showHistoryMatches
  const bookmarkMatchesFlush = primaryMissionsEmpty && !showHistorySection
  const historyMatchesFlush = primaryMissionsEmpty
  const otherTabsFlush = primaryMissionsEmpty && !showBookmarkMatches && !showHistorySection
  // react-doctor-disable-next-line react-hooks-js/refs -- the mission grid refs are forwarded to the masonry container elements; they're attached by React, not read for render output.
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
    showHistoryRange,
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

  useEffect(() => {
    if (startupRefreshRequestedRef.current || !localStateLoaded) return
    startupRefreshRequestedRef.current = true
    void refreshDashboard({ startupSnapshot: true })
  }, [localStateLoaded, refreshDashboard])

  return (
    <DashboardActionsProvider
      value={{
        onHoverUrlChange: handleHoverUrlChange,
        onLayoutChange: scheduleMissionsMasonry,
        onTogglePinnedDomain: togglePinnedDomain,
        onReorderPinnedDomain: reorderPinnedDomain,
        onTogglePinnedSection: togglePinnedSection,
        onTogglePinnedPageChip: togglePinnedPageChip
      }}
    >
      <HoverStateProvider value={hoverMatch}>
        <DashboardShell
          closedTabs={closedTabs}
          savedKeys={dashboard?.savedKeys}
          filter={filter}
          filterFocusRequest={filterFocusRequest}
          filterInput={filterInput}
          handleScrollRegionRef={handleScrollRegionRef}
          historyRange={historyRange}
          isReady={isReady}
          isScrolled={isScrolled}
          missionSections={missionSections}
          onCloseFiltered={onCloseFiltered}
          onDedupAll={onDedupAll}
          onSourceChange={onSourceChange}
          onTabsChange={() => refreshDashboard({ animateCards: true })}
          setFilterInput={setFilterInput}
          setHistoryRange={setHistoryRange}
          setTabHistory={setTabHistory}
          showHistoryRange={showHistoryRange}
          source={source}
          stats={stats}
          tabHistory={tabHistory}
          urlPreview={urlPreview}
          workingSet={workingSet}
        />
      </HoverStateProvider>
    </DashboardActionsProvider>
  )
}

export function mountApp(initialStartupSnapshot: DashboardStartupSnapshot | null = null, initialLocalState: DashboardLocalState | null = null) {
  const el = document.getElementById('appRoot')
  if (!el) return
  createRoot(el).render(<App initialStartupSnapshot={initialStartupSnapshot} initialLocalState={initialLocalState} />)
}
