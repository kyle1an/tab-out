import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { readAppStartup, readBuildTimeAppStartup, subscribeAppStartup, type AppStartupState } from '../app-startup.js'
import { closedTabFetchSuppressionRemainingMs, fetchClosedTabsResult, subscribeClosedTabChanges, type ClosedTabEntry } from '../extension/closed-tabs.js'
import { useMissionsMasonry } from '../extension/layout.js'
import { showToast } from '../extension/toast.js'
import { HISTORY_RANGE_OPTIONS, isHistoryFilterEnabled, saveHistoryRangePreference } from '../extension/history-range.js'
import { animateDomainCardMoves, cancelDomainCardMoves, hasActiveDomainCardMoves, prepareDomainCardMoveAnimation } from '../extension/card-move-animation'
import {
  animateIntraCardMoves,
  animateQueuedPageChipRefreshMoves,
  prepareIntraCardMoveAnimationByKey,
  type PreparedIntraCardMove
} from '../extension/intra-card-move-animation.js'
import { closeFilteredTabs, dedupeTabs } from '../extension/tab-actions'
import { settleDashboardRefresh } from '../extension/dashboard-controller.js'
import { buildFilterResultCandidates, type FilterResultCandidate } from '../extension/filter-result-navigation.js'
import { dashboardNeedsFilterSearchRefresh } from '../extension/filter-search.js'
import { appDashboardStore } from '../extension/dashboard-intake.js'
import { fetchDashboardSnapshot, useDashboardRefresh, type DashboardStartupSnapshot } from '../hooks/useDashboardRefresh'
import { useDashboardLocalState } from '../hooks/useDashboardLocalState'
import type { DashboardLocalState } from '../extension/dashboard-local-state.js'
import { useDashboardViewModels, useMissionOrderMemory, type DashboardChipOrderMemoryMap } from '../hooks/useDashboardViewModels'
import { useFilterRouting } from '../hooks/useFilterRouting'
import { useHoverMatch } from '../hooks/useHoverMatch'
import type { UrlPreviewStore } from '../hooks/useUrlPreview'
import { HeaderBar } from './HeaderBar'
import { HistorySearchStatus } from './HistorySearchStatus'
import { MissionBlock } from './MissionBlock'
import { validatePageChipTextLayoutsAfterMasonry } from './page-chip-layout-validation'
import { TabHistoryPanel } from './TabHistoryPanel'
import { TooltipProvider } from './ui/tooltip'
import { UrlPreview } from './UrlPreview'
import { AppErrorBoundary } from './AppErrorBoundary'
import { DashboardActionsProvider, HoverStateProvider } from './DashboardInteractionContext'
import { STARTUP_ORDER_DEBUG_CAPTURE, recordStartupOrderDebugVmSample, recordStartupTiming, startStartupOrderDebugDomSampling } from './startup-order-debug'
import { cn } from '@/lib/utils'
import type {
  DashboardCardEntry,
  DashboardSource,
  DashboardStats,
  TabHistorySnapshot
} from './types'
import type { HistorySearchSummary, WorkingSetSnapshot } from '../extension/types'
import type { CardPositionMap, MissionContainer } from '../extension/card-move-animation'
import type { MissionOrderMap } from '../hooks/useDashboardRefresh'

type MissionContainerRef = {
  current: HTMLDivElement | null
}

const EMPTY_CLOSED_TABS: readonly ClosedTabEntry[] = []

// Module-stable dispatch: every Dashboard arrival applies through the intake
// store, and the alias stays non-reactive for hook dependency purposes.
const dispatchAppDashboard = appDashboardStore.dispatch

type HistoryRangeSelectModule = typeof import('./HistoryRangeSelect')

let historyRangeSelectImport: Promise<HistoryRangeSelectModule> | null = null

function loadHistoryRangeSelect(): Promise<HistoryRangeSelectModule> {
  return historyRangeSelectImport ??= import('./HistoryRangeSelect')
}

const HistoryRangeSelect = lazy(() => loadHistoryRangeSelect().then((module) => ({ default: module.HistoryRangeSelect })))

type DashboardMissionSection = {
  cards: DashboardCardEntry[]
  filter?: string
  gridEmpty?: boolean
  gridId: string
  gridRef?: Ref<HTMLDivElement>
  historySearchSummary?: HistorySearchSummary | null
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
  historyResultsFilter: string
  historySearchSummary: HistorySearchSummary | null
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
  onRetryHistorySearch: () => void
  sections: DashboardMissionSection[]
}
type SourceSwitchRequestContext = {
  filter: string
  historyFilterEnabled: boolean
  historyRange: string
  pinnedDomains: readonly string[]
}
type SourceSwitchSnapshotResult =
  | { status: 'cancelled' }
  | { status: 'failed' }
  | {
      status: 'ready'
      snapshot: Awaited<ReturnType<typeof fetchDashboardSnapshot>>
    }
type MutableValue<T> = { current: T }

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function sourceSwitchRequestContextMatches(
  request: SourceSwitchRequestContext,
  current: SourceSwitchRequestContext
): boolean {
  return request.filter === current.filter &&
    request.historyFilterEnabled === current.historyFilterEnabled &&
    request.historyRange === current.historyRange &&
    sameStringList(request.pinnedDomains, current.pinnedDomains)
}

async function fetchLatestSourceSwitchSnapshot({
  nextSource,
  previousOrderRef,
  requestId,
  sourceSwitchContextRef,
  sourceSwitchSeqRef
}: {
  nextSource: DashboardSource
  previousOrderRef: MutableValue<MissionOrderMap>
  requestId: number
  sourceSwitchContextRef: MutableValue<SourceSwitchRequestContext>
  sourceSwitchSeqRef: MutableValue<number>
}): Promise<SourceSwitchSnapshotResult> {
  while (requestId === sourceSwitchSeqRef.current) {
    const currentContext = sourceSwitchContextRef.current
    const requestContext: SourceSwitchRequestContext = {
      ...currentContext,
      pinnedDomains: [...currentContext.pinnedDomains]
    }
    try {
      // react-doctor-disable-next-line react-doctor/async-defer-await, react-doctor/async-await-in-loop -- each retry supersedes the stale request context, so the next fetch must start only after the previous result is rejected.
      const snapshot = await fetchDashboardSnapshot({
        source: nextSource,
        filter: requestContext.filter,
        historyRange: requestContext.historyRange,
        historyFilterEnabled: requestContext.historyFilterEnabled,
        pinnedDomains: [...requestContext.pinnedDomains],
        previousOrder: previousOrderRef.current
      })
      if (requestId !== sourceSwitchSeqRef.current) return { status: 'cancelled' }
      if (!sourceSwitchRequestContextMatches(requestContext, sourceSwitchContextRef.current)) continue
      return { status: 'ready', snapshot }
    } catch {
      if (requestId !== sourceSwitchSeqRef.current) return { status: 'cancelled' }
      if (!sourceSwitchRequestContextMatches(requestContext, sourceSwitchContextRef.current)) continue
      return { status: 'failed' }
    }
  }
  return { status: 'cancelled' }
}

function startupViewModelMatchesLocalState(startupViewModel: DashboardStartupSnapshot['startupViewModel'], localState: DashboardLocalState | null): startupViewModel is NonNullable<DashboardStartupSnapshot['startupViewModel']> {
  return !!startupViewModel &&
    localState?.loaded === true &&
    sameStringList(startupViewModel.pinnedDomains, localState.pinnedDomains) &&
    sameStringList(startupViewModel.pinnedSectionIds, localState.pinnedSectionIds) &&
    sameStringList(startupViewModel.pinnedPageChipIds, localState.pinnedPageChipIds)
}

function readMissionContainers(...refs: MissionContainerRef[]): MissionContainer[] {
  return refs.map((ref) => ref.current)
}

function MissionsDivider({ action, label, status }: { action?: ReactNode; label: string; status?: ReactNode }) {
  return (
    <div className={cn('missions-divider mb-4 flex items-center gap-3 text-xs font-medium tracking-[0.6px] text-muted-foreground uppercase', (action || status) && 'min-h-(--header-control-height)')}>
      <span className="missions-divider-label pointer-events-none shrink-0 whitespace-nowrap">{label}</span>
      {action && <div className="missions-divider-action shrink-0 text-foreground normal-case tracking-normal font-normal">{action}</div>}
      <div className={cn('missions-divider-rail relative min-w-0 flex-1', status ? 'h-9.5' : 'h-px')}>
        <hr className="missions-divider-rule absolute inset-x-0 top-1/2 h-px -translate-y-1/2 border-0 bg-(--warm-gray)" />
        {status && <div className="missions-divider-status absolute inset-y-0 right-0 z-1 w-70 max-w-full normal-case tracking-normal">{status}</div>}
      </div>
    </div>
  )
}

function HistoryRangeSelectFallback({ value }: { value: string }) {
  const label = HISTORY_RANGE_OPTIONS.find((option) => option.value === value)?.label || 'History range'
  return (
    <span
      data-tabout="history-range"
      className="box-border flex h-(--header-control-height) w-fit items-center justify-between gap-1.5 whitespace-nowrap rounded-(--header-control-radius) border border-(--warm-gray) bg-tab-card py-0 pr-2 pl-2.5 text-(length:--header-control-font-size) leading-(--header-control-line-height) [corner-shape:squircle]"
      aria-hidden="true"
    >
      <span>{label}</span>
      <svg className="size-4 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  )
}

function dashboardMissionSections({
  bookmarkMatchedCards,
  bookmarkMatchesFlush,
  bookmarkMissionsRef,
  historyMatchedCards,
  historyMatchesFlush,
  historyMissionsRef,
  historyResultsFilter,
  historySearchSummary,
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
      filter: historyResultsFilter,
      gridId: 'historyMatchesMissions',
      gridRef: historyMissionsRef,
      historySearchSummary,
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

function DashboardMissionsList({ filter, historyRangeAction, onRetryHistorySearch, sections }: DashboardMissionsListProps) {
  if (sections.length === 0) return null

  return (
    <>
      {sections.map((section) => {
        const block = (
          <MissionBlock
            key={section.gridId}
            cards={section.cards}
            filter={section.filter ?? filter}
            gridEmpty={section.gridEmpty}
            gridId={section.gridId}
            gridRef={section.gridRef}
            showEmptyState={section.showEmptyState}
            source={section.source}
          />
        )

        if (!section.label) return block
        const action = section.sectionId === 'historyMatchesSection' ? historyRangeAction : undefined
        const status = section.historySearchSummary ? (
          <HistorySearchStatus
            summary={section.historySearchSummary}
            onRetry={onRetryHistorySearch}
          />
        ) : undefined
        return (
          <div className={section.sectionClassName} id={section.sectionId} key={section.sectionId}>
            <MissionsDivider action={action} label={section.label} status={status} />
            {block}
          </div>
        )
      })}
    </>
  )
}

type DashboardShellProps = {
  closedTabs: readonly ClosedTabEntry[]
  commitFilterInput: () => void
  savedKeys?: readonly string[] | undefined
  filter: string
  filterInput: string
  filterResultCandidates: readonly FilterResultCandidate[]
  filterResultSearchSettled: boolean
  historyRange: string
  isReady: boolean
  missionSections: DashboardMissionSection[]
  onCloseFiltered: () => void
  onDedupAll: () => void
  onRetryHistorySearch: () => void
  onSourceChange: (nextSource: DashboardSource) => void
  onTabsChange: () => void
  setFilterInput: (value: string) => void
  setHistoryRange: (value: string) => void
  setTabHistory: (snapshot: TabHistorySnapshot | null) => void
  showHistoryRange: boolean
  source: DashboardSource
  sourceSelection: DashboardSource
  stats: DashboardStats
  tabHistory: TabHistorySnapshot | null
  urlPreviewStore: UrlPreviewStore
  workingSet: WorkingSetSnapshot | null
}

function DashboardShell({
  closedTabs,
  commitFilterInput,
  savedKeys,
  filter,
  filterInput,
  filterResultCandidates,
  filterResultSearchSettled,
  historyRange,
  isReady,
  missionSections,
  onCloseFiltered,
  onDedupAll,
  onRetryHistorySearch,
  onSourceChange,
  onTabsChange,
  setFilterInput,
  setHistoryRange,
  setTabHistory,
  showHistoryRange,
  source,
  sourceSelection,
  stats,
  tabHistory,
  urlPreviewStore,
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
        data-source={source}
        className={cn(
          'dashboard-shell relative z-1 mx-auto grid min-h-0 w-full max-w-(--dashboard-shell-max-width) flex-auto',
          showTabHistory
            ? 'has-history items-stretch gap-4 grid-cols-[minmax(calc(220px+var(--dashboard-history-edge-gutter)),calc(260px+var(--dashboard-history-edge-gutter)))_minmax(0,1fr)] max-[900px]:[--dashboard-page-gutter:20px] max-[900px]:[--dashboard-history-edge-gutter:12px] max-[900px]:[--dashboard-scrollbar-inset:var(--dashboard-scrollbar-size)] max-[900px]:[&.has-history]:grid-cols-[minmax(0,1fr)] max-[900px]:[&.has-history]:gap-0'
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
        <main
          aria-label="Dashboard"
          className={cn(
            'dashboard-main flex min-h-0 min-w-0 flex-col',
            showTabHistory
              ? 'col-2 pr-(--dashboard-page-gutter) pl-0 max-[900px]:[.dashboard-shell.has-history_&]:col-1 max-[900px]:[.dashboard-shell.has-history_&]:px-(--dashboard-page-gutter)'
              : 'col-1 px-(--dashboard-page-gutter)'
          )}
        >
          <div
            className={cn(
              'pinned-top relative z-10 flex-none mr-[calc(0px-var(--dashboard-edge-bleed))] pt-3 pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-scrollbar-size))] pb-3 [--header-shadow-padding-fade:calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-scrollbar-size))] [--header-shadow-left-reserve:56px] [--header-shadow-left-fade:18px]',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))]'
                : 'ml-[calc(0px-var(--header-shadow-left-reserve))] pl-(--header-shadow-left-reserve)',
              showTabHistory && '[clip-path:inset(0_0_-16px_calc(0px-var(--header-shadow-left-reserve)))] focus-within:[clip-path:inset(-4px_-4px_-16px_calc(0px-var(--header-shadow-left-reserve)-4px))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-padding-fade:calc(var(--dashboard-edge-bleed)+var(--dashboard-scrollbar-size))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:[--header-shadow-left-reserve:var(--dashboard-edge-bleed)] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:ml-[calc(0px-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:pl-(--dashboard-edge-bleed) max-[900px]:[.dashboard-shell.has-history_.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scrollbar-size))]'
            )}
          >
            <HeaderBar
              source={source}
              sourceSelection={sourceSelection}
              stats={stats}
              ready={isReady}
              filter={filterInput}
              committedFilter={filter}
              filterResultCandidates={filterResultCandidates}
              filterResultSearchSettled={filterResultSearchSettled}
              historyRange={historyRange}
              onFilterChange={setFilterInput}
              onFilterCommit={commitFilterInput}
              onSourceChange={onSourceChange}
              onCloseFiltered={onCloseFiltered}
              onDedupAll={onDedupAll}
            />
          </div>

          <div
            id="dashboardMissions"
            role="group"
            data-tabout-part="scroll-region"
            aria-label="Filter results"
            className={cn(
              'scroll-region relative z-1 flex-auto min-h-0 overflow-x-hidden overflow-y-auto overscroll-x-none overscroll-y-contain mr-[calc(0px-var(--dashboard-edge-bleed))] pt-1.5 pr-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter))] pb-12.5 scrollbar-gutter-stable max-[900px]:[.dashboard-main_>&]:mr-[calc(var(--dashboard-scrollbar-size)-var(--dashboard-scrollbar-thumb-size)-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-size)+var(--dashboard-scrollbar-thumb-size))]',
              source === 'bookmarks'
                ? 'ml-[calc(0px-var(--dashboard-edge-bleed)-var(--dashboard-card-shadow-bleed))] pl-[calc(var(--dashboard-edge-bleed)+var(--dashboard-scroll-gutter)+var(--dashboard-card-shadow-bleed))]'
                : 'ml-[calc(0px-var(--dashboard-card-shadow-bleed))] pl-(--dashboard-card-shadow-bleed)'
            )}
          >
            <DashboardMissionsList
              filter={filter}
              historyRangeAction={showHistoryRange ? (
                <Suspense fallback={<HistoryRangeSelectFallback value={historyRange} />}>
                  <HistoryRangeSelect
                    value={historyRange}
                    onValueChange={setHistoryRange}
                  />
                </Suspense>
              ) : undefined}
              onRetryHistorySearch={onRetryHistorySearch}
              sections={missionSections}
            />
          </div>
        </main>
      </div>

      <UrlPreview store={urlPreviewStore} />
    </TooltipProvider>
  )
}

export function App() {
  const startupState = useSyncExternalStore(
    subscribeAppStartup,
    readAppStartup,
    readBuildTimeAppStartup
  )
  const startupSnapshot = startupState?.snapshot ?? null
  const appDashboard = useSyncExternalStore(
    appDashboardStore.subscribe,
    appDashboardStore.read,
    appDashboardStore.readBuildTime
  )
  const { closedTabs, dashboard, historyRange, historySearchPending, source, sourceAppliedRequestId, sourceRequestId, sourceSelection, tabHistory, workingSet } = appDashboard
  const { hoverStateStore, urlPreviewStore, handleHoverUrlChange, clearHoverUrlNow } = useHoverMatch()
  function setClosedTabs(next: readonly ClosedTabEntry[]) {
    dispatchAppDashboard({ type: 'closedTabs', closedTabs: next })
  }
  const setHistoryRange = useCallback(async function setHistoryRange(nextHistoryRange: string) {
    dispatchAppDashboard({ type: 'historyRange', historyRange: nextHistoryRange })
    try {
      await saveHistoryRangePreference(nextHistoryRange)
    } catch {
      showToast("Couldn't remember History range")
    }
  }, [])
  const setTabHistory = useCallback(function setTabHistory(nextTabHistory: TabHistorySnapshot | null) {
    dispatchAppDashboard({ type: 'tabHistory', tabHistory: nextTabHistory })
  }, [])
  const closedTabsSeqRef = useRef(0)
  const closedTabsRetryTimerRef = useRef<number | null>(null)
  const firstDashboardLayoutRecordedRef = useRef(false)
  const startupRefreshRequestedRef = useRef(false)
  const refreshClosedTabs = useCallback(async function refreshClosedTabs(settleDelayMs = 0) {
    const seq = ++closedTabsSeqRef.current
    const suppressionRemainingMs = closedTabFetchSuppressionRemainingMs()
    const delayMs = Math.max(settleDelayMs, suppressionRemainingMs)
    if (!Number.isFinite(delayMs)) {
      // An unresolved sessions.restore has no safe deadline. Its settlement
      // emits another change notification that arms the finite trailing read.
      if (closedTabsRetryTimerRef.current !== null) {
        window.clearTimeout(closedTabsRetryTimerRef.current)
        closedTabsRetryTimerRef.current = null
      }
      return
    }
    if (delayMs > 0) {
      if (closedTabsRetryTimerRef.current !== null) window.clearTimeout(closedTabsRetryTimerRef.current)
      closedTabsRetryTimerRef.current = window.setTimeout(() => {
        closedTabsRetryTimerRef.current = null
        void refreshClosedTabs()
      }, Math.max(1, Math.ceil(delayMs)))
      return
    }
    if (closedTabsRetryTimerRef.current !== null) {
      window.clearTimeout(closedTabsRetryTimerRef.current)
      closedTabsRetryTimerRef.current = null
    }
    // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await seq comparison is a stale-response race guard; it must run after the await.
    const result = await fetchClosedTabsResult()
    if (seq !== closedTabsSeqRef.current) return
    if (result.ok) setClosedTabs(result.value)
  }, [])

  useEffect(() => {
    return subscribeClosedTabChanges((settleDelayMs) => { void refreshClosedTabs(settleDelayMs).catch(() => {}) })
  }, [refreshClosedTabs])

  useEffect(() => () => {
    if (closedTabsRetryTimerRef.current !== null) window.clearTimeout(closedTabsRetryTimerRef.current)
  }, [])

  const sourceSwitchSeqRef = useRef(0)
  const layoutMoveRectsRef = useRef<CardPositionMap | null>(null)
  const filterCardMoveRef = useRef(false)
  const intraCardMoveRef = useRef<PreparedIntraCardMove | null>(null)
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
  const [dashboardContentVisible, setDashboardContentVisible] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDashboardContentVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const visibleDashboard = dashboardContentVisible ? dashboard : null
  const isReady = !!visibleDashboard
  const historyFilterEnabled = isHistoryFilterEnabled(historyRange)
  const { packMissionsMasonryNow, scheduleMissionsMasonry } = useMissionsMasonry(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef, {
    onAfterLayout: validatePageChipTextLayoutsAfterMasonry,
    onBeforePack: prepareDomainCardMoveAnimation,
    onAfterPack: animateDomainCardMoves
  })

  const currentMissionContainers = useCallback(function currentMissionContainers() {
    return readMissionContainers(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef)
  }, [])

  const primeCardMoveAnimation = useCallback(function primeCardMoveAnimation() {
    layoutMoveRectsRef.current = prepareDomainCardMoveAnimation(currentMissionContainers())
  }, [currentMissionContainers])

  const [startupPriorityWorkingSet, setStartupPriorityWorkingSet] = useState<WorkingSetSnapshot | null>(null)
  const handleBeforeFilterCommit = useCallback(function handleBeforeFilterCommit() {
    setStartupPriorityWorkingSet(null)
    filterCardMoveRef.current = true
    primeCardMoveAnimation()
  }, [primeCardMoveAnimation])
  const { filterInput, filter, commitFilterInput, setFilterInput } = useFilterRouting({ onBeforeFilterCommit: handleBeforeFilterCommit })
  const handleFilterInputChange = useCallback(function handleFilterInputChange(nextFilterInput: string) {
    if (nextFilterInput.trim()) void loadHistoryRangeSelect().catch(() => {})
    setFilterInput(nextFilterInput)
  }, [setFilterInput])
  const effectiveStartupPriorityWorkingSet = source === 'tabs' && filter.trim() === '' ? startupPriorityWorkingSet : null
  const visibleWorkingSet = dashboardContentVisible ? effectiveStartupPriorityWorkingSet ?? workingSet : null
  const historyPanelWorkingSet = dashboardContentVisible ? workingSet : null
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
    applyStartupState,
    togglePinnedDomain,
    reorderPinnedDomain,
    togglePinnedSection,
    togglePinnedPageChip
  } = useDashboardLocalState({
    waitForInitialState: startupState === null,
    onBeforeApplyPinnedDomains: ({ animate }) => {
      resetMissionOrder()
      if (animate) primeCardMoveAnimation()
    },
    onBeforeApplyPinnedSections: (sectionId) => {
      intraCardMoveRef.current = prepareIntraCardMoveAnimationByKey(sectionId)
    },
    onBeforeApplyPinnedPageChips: (pageChipPinId) => {
      intraCardMoveRef.current = prepareIntraCardMoveAnimationByKey(pageChipPinId)
    },
    onDomainPinSaveError: () => showToast('Could not save pinned domain'),
    onSectionPinSaveError: () => showToast('Could not save pinned section'),
    onPageChipPinSaveError: () => showToast('Could not save pinned page')
  })
  const appliedStartupStateRef = useRef<AppStartupState | null>(null)
  useLayoutEffect(() => {
    if (!startupState || appliedStartupStateRef.current === startupState) return
    appliedStartupStateRef.current = startupState
    applyStartupState(startupState.localState)
    dispatchAppDashboard({
      type: 'startup',
      historyRange: startupState.historyRange,
      snapshot: startupState.snapshot
    })
  }, [applyStartupState, startupState])
  const appliedStartupPriorityRef = useRef<AppStartupState | null>(null)
  useLayoutEffect(() => {
    if (!startupState ||
      appliedStartupPriorityRef.current === startupState ||
      sourceRequestId !== 0 ||
      sourceAppliedRequestId !== 0 ||
      source !== 'tabs' ||
      sourceSelection !== 'tabs') return
    appliedStartupPriorityRef.current = startupState
    setStartupPriorityWorkingSet(startupState.snapshot?.workingSet ?? null)
  }, [source, sourceAppliedRequestId, sourceRequestId, sourceSelection, startupState])
  const sourceSwitchContextRef = useRef<SourceSwitchRequestContext>({
    filter,
    historyFilterEnabled,
    historyRange,
    pinnedDomains: [...pinnedDomains]
  })
  useLayoutEffect(() => {
    sourceSwitchContextRef.current = {
      filter,
      historyFilterEnabled,
      historyRange,
      pinnedDomains: [...pinnedDomains]
    }
  }, [filter, historyFilterEnabled, historyRange, pinnedDomains])
  const initialStartupViewModel = startupSnapshot?.startupViewModel
  const startupDashboardViewModel =
    visibleDashboard === startupSnapshot?.dashboard &&
    source === 'tabs' &&
    filter.trim() === '' &&
    !!effectiveStartupPriorityWorkingSet &&
    startupViewModelMatchesLocalState(initialStartupViewModel, localState)
      ? initialStartupViewModel.viewModel
      : null
  // react-doctor-disable-next-line react-hooks-js/refs -- the order/chip refs are mutable caches the refresh reads at call time, intentionally outside React's render-tracked state.
  const { refreshDashboard } = useDashboardRefresh({
    dashboard,
    source,
    filter,
    historyRange,
    historyFilterEnabled,
    pinnedDomains,
    localStateLoaded,
    // react-doctor-disable-next-line react-hooks-js/refs -- previousOrder is a mutable ordering cache read at refresh time, not render-derived state.
    previousOrder: previousOrderRef.current,
    onBeforePinnedRefresh: clearHoverUrlNow
  })
  useEffect(() => {
    return appDashboardStore.subscribeBeforeApply((event) => {
      if (event.reason === 'animated-refresh') {
        primeCardMoveAnimation()
        return
      }
      recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'live-startup-snapshot-applied', {
        detail: {
          closedTabs: event.snapshot.closedTabs.length,
          domainGroups: event.snapshot.dashboard.domainGroups.length,
          realTabs: event.snapshot.dashboard.realTabs.length,
          workingSet: event.snapshot.workingSet.items.length
        }
      })
    })
  }, [primeCardMoveAnimation])
  const retryHistorySearch = useCallback(function retryHistorySearch() {
    void refreshDashboard().catch(() => showToast('Could not update History'))
  }, [refreshDashboard])

  useLayoutEffect(() => {
    if (!isReady) return
    clearHoverUrlNow()
    const containers = readMissionContainers(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef)
    const previousRects = layoutMoveRectsRef.current
    layoutMoveRectsRef.current = null
    // Bookmark/history matches hydrate after the local tab filter commits. Keep
    // that data-only refresh from cancelling the filter move halfway through.
    const preserveActiveFilterMove = !previousRects &&
      filterCardMoveRef.current &&
      hasActiveDomainCardMoves(containers)
    if (!previousRects && !preserveActiveFilterMove) {
      filterCardMoveRef.current = false
      cancelDomainCardMoves(containers)
    }
    packMissionsMasonryNow({ unpin: true })
    if (previousRects) animateDomainCardMoves(containers, previousRects)
  }, [visibleDashboard, filter, source, isReady, historyFilterEnabled, clearHoverUrlNow, packMissionsMasonryNow])

  useLayoutEffect(() => {
    animateQueuedPageChipRefreshMoves()
  }, [visibleDashboard])

  const {
    dashboardVm,
    stats,
    matchedCards,
    unmatchedCards,
    bookmarkMatchedCards,
    historyMatchedCards,
    historyResultsFilter,
    historySearchSummary,
    showOtherTabs,
    showBookmarkMatches,
    showHistoryMatches,
    showHistoryRange,
    showPrimaryEmptyState
  } = useDashboardViewModels({
    dashboard: visibleDashboard,
    source,
    filter,
    historyRange,
    historyFilterEnabled,
    historySearchPending,
    isReady,
    // react-doctor-disable-next-line react-hooks-js/refs -- chipOrder is a mutable per-source ordering cache read at view-model build time, not render-derived state.
    chipOrder: chipOrderRef.current,
    workingSet: visibleWorkingSet,
    freezeTabsChipOrder: dashboardContentVisible && !!effectiveStartupPriorityWorkingSet,
    startupViewModel: startupDashboardViewModel,
    pinnedSections,
    pinnedPageChips
  })
  const filterResultCandidates = useMemo(
    () => filter.trim()
      ? buildFilterResultCandidates({
          primaryMatches: matchedCards,
          historyMatches: showHistoryMatches ? historyMatchedCards : [],
          bookmarkMatches: showBookmarkMatches ? bookmarkMatchedCards : []
        })
      : [],
    [
      bookmarkMatchedCards,
      filter,
      historyMatchedCards,
      matchedCards,
      showBookmarkMatches,
      showHistoryMatches
    ]
  )
  const filterResultSearchSettled = isReady && !dashboardNeedsFilterSearchRefresh(visibleDashboard, {
    source,
    filter,
    historyRange,
    historyFilterEnabled
  })
  const showSettledEmptyState = showPrimaryEmptyState &&
    filterResultSearchSettled &&
    historySearchSummary?.phase !== 'error'

  useLayoutEffect(() => {
    const prepared = intraCardMoveRef.current
    intraCardMoveRef.current = null
    animateIntraCardMoves(prepared)
  }, [pinnedSections, pinnedPageChips])

  useLayoutEffect(() => {
    if (firstDashboardLayoutRecordedRef.current || !visibleDashboard) return
    firstDashboardLayoutRecordedRef.current = true
    recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'first-dashboard-layout', {
      detail: {
        cachedStartupSnapshot: !!startupSnapshot,
        domainGroups: visibleDashboard.domainGroups.length,
        filterActive: filter.trim() !== '',
        matchedCards: matchedCards.length,
        realTabs: visibleDashboard.realTabs.length,
        source,
        startupViewModel: !!startupDashboardViewModel,
        workingSet: visibleWorkingSet?.items.length ?? 0
      }
    })
  }, [visibleDashboard, filter, startupSnapshot, matchedCards.length, source, startupDashboardViewModel, visibleWorkingSet])

  useLayoutEffect(() => {
    recordStartupOrderDebugVmSample(STARTUP_ORDER_DEBUG_CAPTURE, {
      dashboard: visibleDashboard,
      source,
      filter,
      isReady,
      matchedCards,
      workingSet: visibleWorkingSet
    })
  }, [visibleDashboard, filter, isReady, matchedCards, source, visibleWorkingSet])

  useLayoutEffect(() => {
    return startStartupOrderDebugDomSampling(STARTUP_ORDER_DEBUG_CAPTURE)
  }, [])

  const onCloseFiltered = useCallback(async function onCloseFiltered() {
    await closeFilteredTabs(dashboardVm.filteredCloseTargets)
  }, [dashboardVm.filteredCloseTargets])

  const onDedupAll = useCallback(async function onDedupAll() {
    await dedupeTabs({ urls: dashboardVm.globalDedupeUrls, preservePinnedTabOut: true })
  }, [dashboardVm.globalDedupeUrls])

  const onTabsChange = useCallback(function onTabsChange() {
    void settleDashboardRefresh(refreshDashboard({ animateCards: true }))
  }, [refreshDashboard])

  const onSourceChange = useCallback(function onSourceChange(nextSource: DashboardSource) {
    if (nextSource === sourceSelection) return
    const requestId = ++sourceSwitchSeqRef.current
    if (nextSource === source) {
      dispatchAppDashboard({ type: 'sourceRequestCancelled' })
      return
    }
    dispatchAppDashboard({ type: 'sourceRequest', requestId, source: nextSource })
    const previousRects = prepareDomainCardMoveAnimation(currentMissionContainers())
    setStartupPriorityWorkingSet(null)
    clearHoverUrlNow()
    void fetchLatestSourceSwitchSnapshot({
      nextSource,
      previousOrderRef,
      requestId,
      sourceSwitchContextRef,
      sourceSwitchSeqRef
    }).then((result) => {
      if (requestId !== sourceSwitchSeqRef.current || result.status === 'cancelled') return
      if (result.status === 'failed') {
        dispatchAppDashboard({
          type: 'sourceRequestFailed',
          requestId
        })
        showToast('Could not switch source')
        return
      }

      layoutMoveRectsRef.current = previousRects
      // Store arrivals commit synchronously (useSyncExternalStore updates are
      // never transitions); progressive card mounting bounds the render cost.
      dispatchAppDashboard({
        type: 'sourceSnapshot',
        dashboard: result.snapshot.dashboard,
        requestId,
        source: nextSource,
        ...(result.snapshot.tabHistory === undefined ? {} : { tabHistory: result.snapshot.tabHistory }),
        ...(result.snapshot.workingSet === undefined ? {} : { workingSet: result.snapshot.workingSet })
      })
    })
  }, [source, sourceSelection, clearHoverUrlNow, currentMissionContainers])

  const primaryMissionsEmpty = matchedCards.length === 0
  const showHistorySection = showHistoryRange || showHistoryMatches
  const bookmarkMatchesFlush = primaryMissionsEmpty && !showHistorySection
  const historyMatchesFlush = primaryMissionsEmpty
  const otherTabsFlush = primaryMissionsEmpty && !showBookmarkMatches && !showHistorySection
  // react-doctor-disable-next-line react-hooks-js/refs -- the mission grid refs are forwarded to the masonry container elements; they're attached by React, not read for render output.
  const missionSections = useMemo(() => dashboardMissionSections({
    bookmarkMatchedCards,
    bookmarkMatchesFlush,
    bookmarkMissionsRef,
    filter,
    historyMatchedCards,
    historyMatchesFlush,
    historyMissionsRef,
    historyResultsFilter,
    historySearchSummary,
    isReady,
    matchedCards,
    otherTabsFlush,
    primaryMissionsEmpty,
    primaryMissionsRef,
    showBookmarkMatches,
    showHistoryMatches,
    showHistoryRange,
    showOtherTabs,
    showPrimaryEmptyState: showSettledEmptyState,
    source,
    unmatchedCards,
    unmatchedMissionsRef
  }), [bookmarkMatchedCards, bookmarkMatchesFlush, filter, historyMatchedCards, historyMatchesFlush, historyResultsFilter, historySearchSummary, isReady, matchedCards, otherTabsFlush, primaryMissionsEmpty, showBookmarkMatches, showHistoryMatches, showHistoryRange, showOtherTabs, showSettledEmptyState, source, unmatchedCards])

  useMissionOrderMemory({
    previousOrderRef,
    chipOrderRef,
    enabled: dashboardContentVisible,
    source,
    filter,
    matchedCards,
    bookmarkMatchedCards,
    historyMatchedCards
  })

  useEffect(() => {
    if (startupRefreshRequestedRef.current || !dashboardContentVisible || !localStateLoaded) return
    startupRefreshRequestedRef.current = true
    recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'live-startup-refresh-requested', {
      detail: { localStateLoaded }
    })
    void settleDashboardRefresh(refreshDashboard({ startupSnapshot: true }))
  }, [dashboardContentVisible, localStateLoaded, refreshDashboard])

  // App bails out of React Compiler (the render-time ordering-cache ref reads
  // above are deliberate), so this context value is memoized manually — the
  // stable-actions contract in DashboardInteractionContext depends on it.
  const dashboardActions = useMemo(() => ({
    onHoverUrlChange: handleHoverUrlChange,
    onLayoutChange: scheduleMissionsMasonry,
    onTogglePinnedDomain: togglePinnedDomain,
    onReorderPinnedDomain: reorderPinnedDomain,
    onTogglePinnedSection: togglePinnedSection,
    onTogglePinnedPageChip: togglePinnedPageChip
  }), [handleHoverUrlChange, scheduleMissionsMasonry, togglePinnedDomain, reorderPinnedDomain, togglePinnedSection, togglePinnedPageChip])

  return (
    <DashboardActionsProvider value={dashboardActions}>
      <HoverStateProvider store={hoverStateStore}>
        <DashboardShell
          closedTabs={dashboardContentVisible ? closedTabs : EMPTY_CLOSED_TABS}
          commitFilterInput={commitFilterInput}
          savedKeys={visibleDashboard?.savedKeys}
          filter={filter}
          filterInput={filterInput}
          filterResultCandidates={filterResultCandidates}
          filterResultSearchSettled={filterResultSearchSettled}
          historyRange={historyRange}
          isReady={isReady}
          missionSections={missionSections}
          onCloseFiltered={onCloseFiltered}
          onDedupAll={onDedupAll}
          onRetryHistorySearch={retryHistorySearch}
          onSourceChange={onSourceChange}
          onTabsChange={onTabsChange}
          setFilterInput={handleFilterInputChange}
          setHistoryRange={setHistoryRange}
          setTabHistory={setTabHistory}
          showHistoryRange={showHistoryRange}
          source={source}
          sourceSelection={sourceSelection}
          stats={stats}
          tabHistory={dashboardContentVisible ? tabHistory : null}
          urlPreviewStore={urlPreviewStore}
          workingSet={historyPanelWorkingSet}
        />
      </HoverStateProvider>
    </DashboardActionsProvider>
  )
}

export function AppRoot() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  )
}

export function attachApp() {
  const el = document.getElementById('appRoot')
  if (!el) return
  hydrateRoot(el, <AppRoot />, {
    // Safety net for throws the boundary cannot catch (errors inside the
    // boundary/fallback itself) — keep the evidence in the console.
    onUncaughtError: (error, errorInfo) => {
      console.error('[tab-out] uncaught render error', error, errorInfo.componentStack)
    },
    onRecoverableError: (error, errorInfo) => {
      console.error('[tab-out] recoverable hydration error', error, errorInfo.componentStack)
    }
  })
}
