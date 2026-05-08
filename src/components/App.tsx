import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { createRoot } from 'react-dom/client'
import { useMissionsMasonry } from '../extension/layout.js'
import { showToast } from '../extension/toast.js'
import { DEFAULT_HISTORY_RANGE, isHistoryFilterEnabled } from '../extension/history-source.js'
import { animateDomainCardMoves, cancelDomainCardMoves, prepareDomainCardMoveAnimation } from '../extension/card-move-animation'
import { closeFilteredTabs, dedupeTabs } from '../extension/tab-actions'
import { fetchDashboardSnapshot, useDashboardRefresh } from '../hooks/useDashboardRefresh'
import { useDashboardViewModels, useMissionOrderMemory } from '../hooks/useDashboardViewModels'
import { useFilterRouting } from '../hooks/useFilterRouting'
import { usePinnedDomains } from '../hooks/usePinnedDomains'
import { useUrlPreview } from '../hooks/useUrlPreview'
import { HeaderBar } from './HeaderBar'
import { Missions } from './Missions'
import { TabHistoryPanel } from './TabHistoryPanel'
import { UrlPreview } from './UrlPreview'
import { cn } from '../lib/cn'
import type { DashboardData, DashboardSource, TabHistorySnapshot } from './types'
import type { CardPositionMap, MissionContainer } from '../extension/card-move-animation'
import type { MissionOrderMap } from '../hooks/useDashboardRefresh'

type MissionContainerRef = {
  current: HTMLDivElement | null
}

function readMissionContainers(...refs: MissionContainerRef[]): MissionContainer[] {
  return refs.map((ref) => ref.current)
}

function MissionsDivider({ label }: { label: string }) {
  return (
    <div className="missions-divider pointer-events-none mb-4 flex items-center gap-3 text-[11px] font-medium tracking-[0.6px] text-tab-muted uppercase" role="separator">
      <span className="missions-divider-rule h-px flex-1 bg-(--warm-gray)" />
      <span className="missions-divider-label shrink-0 whitespace-nowrap">{label}</span>
      <span className="missions-divider-rule h-px flex-1 bg-(--warm-gray)" />
    </div>
  )
}

const MissionsGrid = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'> & { empty?: boolean }>(function MissionsGrid({ className, empty = false, ...props }, ref) {
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
})

export function App({ initialDashboard = null }: { initialDashboard?: DashboardData | null }) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(initialDashboard)
  const [source, setSource] = useState<DashboardSource>('tabs')
  const [historyRange, setHistoryRange] = useState(DEFAULT_HISTORY_RANGE)
  const { urlPreview, setUrlPreview, clearUrlPreviewNow } = useUrlPreview()
  const [isScrolled, setIsScrolled] = useState(false)
  const [tabHistory, setTabHistory] = useState<TabHistorySnapshot | null>(null)
  const sourceSwitchSeqRef = useRef(0)
  const layoutMoveRectsRef = useRef<CardPositionMap | null>(null)
  const previousOrderRef = useRef<MissionOrderMap>({
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map()
  })
  const scrollRegionRef = useRef<HTMLDivElement | null>(null)
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

  function currentMissionContainers() {
    return readMissionContainers(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef)
  }

  function primeCardMoveAnimation() {
    layoutMoveRectsRef.current = prepareDomainCardMoveAnimation(currentMissionContainers())
  }

  const { filterInput, filter, filterFocusRequest, setFilterInput } = useFilterRouting({ onBeforeFilterCommit: primeCardMoveAnimation })
  function resetMissionOrder() {
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
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
    onBeforeAnimatedRefresh: primeCardMoveAnimation,
    onBeforePinnedRefresh: clearUrlPreviewNow
  })

  useEffect(() => {
    const scrollEl = scrollRegionRef.current
    if (!scrollEl) return
    const scrollTarget = scrollEl

    function onScroll() {
      const next = scrollTarget.scrollTop > 0
      setIsScrolled((prev) => (prev === next ? prev : next))
    }

    onScroll()
    scrollTarget.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollTarget.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    if (!isReady) return
    clearUrlPreviewNow()
    const containers = readMissionContainers(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef)
    const previousRects = layoutMoveRectsRef.current
    layoutMoveRectsRef.current = null
    if (!previousRects) cancelDomainCardMoves(containers)
    packMissionsMasonryNow({ unpin: true })
    if (previousRects) animateDomainCardMoves(containers, previousRects)
  }, [dashboard, filter, source, isReady, clearUrlPreviewNow, packMissionsMasonryNow])

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
    isReady
  })

  async function onCloseFiltered() {
    await closeFilteredTabs(dashboardVm.filteredCloseUrls)
  }

  async function onDedupAll() {
    await dedupeTabs({ urls: dashboardVm.globalDedupeUrls, preservePinnedTabOut: true })
  }

  async function onSourceChange(nextSource: DashboardSource) {
    if (nextSource === source) return
    const requestId = ++sourceSwitchSeqRef.current
    const previousRects = prepareDomainCardMoveAnimation(currentMissionContainers())
    clearUrlPreviewNow()
    const { dashboard: nextDashboard, tabHistory: nextTabHistory } = await fetchDashboardSnapshot({
      source: nextSource,
      filter,
      historyRange,
      historyFilterEnabled,
      pinnedDomains,
      previousOrder: previousOrderRef.current
    })
    if (requestId !== sourceSwitchSeqRef.current) return
    layoutMoveRectsRef.current = previousRects
    setDashboard(nextDashboard)
    setTabHistory(nextTabHistory)
    setSource(nextSource)
  }

  const showTabHistory = isReady && source === 'tabs'
  const primaryMissionsEmpty = matchedCards.length === 0
  const bookmarkMatchesFlush = primaryMissionsEmpty
  const historyMatchesFlush = primaryMissionsEmpty && !showBookmarkMatches
  const otherTabsFlush = primaryMissionsEmpty && !showBookmarkMatches && !showHistoryMatches

  useMissionOrderMemory({
    previousOrderRef,
    source,
    matchedCards,
    bookmarkMatchedCards,
    historyMatchedCards
  })

  return (
    <>
      <div
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
            onHoverUrlChange={setUrlPreview}
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

          <div className="scroll-region max-[900px]:[.dashboard-main_>&]:mr-[calc(var(--dashboard-scrollbar-inset)-var(--dashboard-edge-bleed))] max-[900px]:[.dashboard-main_>&]:pr-[calc(var(--dashboard-edge-bleed)-var(--dashboard-scrollbar-inset))] max-[900px]:[&::-webkit-scrollbar]:w-1" ref={scrollRegionRef}>
            {isReady && (
              <>
                <MissionsGrid empty={primaryMissionsEmpty} id="openTabsMissions" ref={primaryMissionsRef}>
                  <Missions
                    cards={matchedCards}
                    filter={filter}
                    source={source}
                    showEmptyState={showPrimaryEmptyState}
                    onHoverUrlChange={setUrlPreview}
                    onLayoutChange={scheduleMissionsMasonry}
                    onTogglePinnedDomain={togglePinnedDomain}
                  />
                </MissionsGrid>

                {showBookmarkMatches && (
                  <div className={cn('missions-other missions-bookmarks mt-6', bookmarkMatchesFlush && 'mt-0')} id="bookmarkMatchesSection">
                    <MissionsDivider label="Bookmarks" />
                    <MissionsGrid id="bookmarkMatchesMissions" ref={bookmarkMissionsRef}>
                      <Missions
                        cards={bookmarkMatchedCards}
                        filter={filter}
                        source="bookmarks"
                        showEmptyState={false}
                        onHoverUrlChange={setUrlPreview}
                        onLayoutChange={scheduleMissionsMasonry}
                        onTogglePinnedDomain={togglePinnedDomain}
                      />
                    </MissionsGrid>
                  </div>
                )}

                {showHistoryMatches && (
                  <div className={cn('missions-other missions-history mt-6', historyMatchesFlush && 'mt-0')} id="historyMatchesSection">
                    <MissionsDivider label="History" />
                    <MissionsGrid id="historyMatchesMissions" ref={historyMissionsRef}>
                      <Missions
                        cards={historyMatchedCards}
                        filter={filter}
                        source="history"
                        showEmptyState={false}
                        onHoverUrlChange={setUrlPreview}
                        onLayoutChange={scheduleMissionsMasonry}
                        onTogglePinnedDomain={togglePinnedDomain}
                      />
                    </MissionsGrid>
                  </div>
                )}

                {showOtherTabs && (
                  <div className={cn('missions-other mt-6', otherTabsFlush && 'mt-0')} id="openTabsMissionsOther">
                    <MissionsDivider label="Other tabs" />
                    <MissionsGrid id="openTabsMissionsUnmatched" ref={unmatchedMissionsRef}>
                      <Missions
                        cards={unmatchedCards}
                        filter={filter}
                        source={source}
                        showEmptyState={false}
                        onHoverUrlChange={setUrlPreview}
                        onLayoutChange={scheduleMissionsMasonry}
                        onTogglePinnedDomain={togglePinnedDomain}
                      />
                    </MissionsGrid>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <UrlPreview url={urlPreview.url} visible={urlPreview.visible} />
    </>
  )
}

export function mountApp(initialDashboard: DashboardData | null = null) {
  const el = document.getElementById('appRoot')
  if (!el) return
  createRoot(el).render(<App initialDashboard={initialDashboard} />)
}
