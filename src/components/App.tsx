import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { closeDuplicateTabs, closeTabsExact } from '../extension/tabs.js'
import { useMissionsMasonry } from '../extension/layout.js'
import { showToast } from '../extension/toast.js'
import { markClosure } from '../extension/undo.js'
import { buildDashboardViewModel } from '../extension/render.js'
import { DEFAULT_HISTORY_RANGE, isHistoryFilterEnabled } from '../extension/history-source.js'
import { animateDomainCardMoves, cancelDomainCardMoves, prepareDomainCardMoveAnimation } from '../extension/card-move-animation'
import { fetchDashboardSnapshot, useDashboardRefresh } from '../hooks/useDashboardRefresh'
import { useFilterRouting } from '../hooks/useFilterRouting'
import { usePinnedDomains } from '../hooks/usePinnedDomains'
import { useUrlPreview } from '../hooks/useUrlPreview'
import { HeaderBar } from './HeaderBar'
import { Missions } from './Missions'
import { TabHistoryPanel } from './TabHistoryPanel'
import { UrlPreview } from './UrlPreview'
import type { DashboardCardEntry, DashboardData, DashboardSource, DomainGroup, TabHistorySnapshot } from './types'
import type { CardPositionMap, MissionContainer } from '../extension/card-move-animation'
import type { MissionOrderMap } from '../hooks/useDashboardRefresh'

function stableGroupId(group: DomainGroup) {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')
}

const EMPTY_TABS: DashboardData['realTabs'] = []
const EMPTY_DOMAIN_GROUPS: DomainGroup[] = []
const EMPTY_CARD_ENTRIES: DashboardCardEntry[] = []

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
  const realTabs = dashboard?.realTabs || EMPTY_TABS
  const domainGroups = dashboard?.domainGroups || EMPTY_DOMAIN_GROUPS
  const bookmarkTabs = dashboard?.bookmarkTabs || EMPTY_TABS
  const bookmarkDomainGroups = dashboard?.bookmarkDomainGroups || EMPTY_DOMAIN_GROUPS
  const historyTabs = dashboard?.historyTabs || EMPTY_TABS
  const historyDomainGroups = dashboard?.historyDomainGroups || EMPTY_DOMAIN_GROUPS
  const isReady = !!dashboard
  const historyFilterEnabled = isHistoryFilterEnabled(historyRange)
  const { packMissionsMasonryNow, scheduleMissionsMasonry } = useMissionsMasonry(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef, {
    onBeforePack: prepareDomainCardMoveAnimation,
    onAfterPack: animateDomainCardMoves
  })

  const missionContainers = useCallback(function missionContainers(): MissionContainer[] {
    return [primaryMissionsRef.current, bookmarkMissionsRef.current, historyMissionsRef.current, unmatchedMissionsRef.current]
  }, [])

  const primeCardMoveAnimation = useCallback(function primeCardMoveAnimation() {
    layoutMoveRectsRef.current = prepareDomainCardMoveAnimation(missionContainers())
  }, [missionContainers])

  const { filterInput, filter, filterFocusRequest, setFilterInput } = useFilterRouting({ onBeforeFilterCommit: primeCardMoveAnimation })
  const resetMissionOrder = useCallback(function resetMissionOrder() {
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
  }, [])
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
    const containers = missionContainers()
    const previousRects = layoutMoveRectsRef.current
    layoutMoveRectsRef.current = null
    if (!previousRects) cancelDomainCardMoves(containers)
    packMissionsMasonryNow({ unpin: true })
    if (previousRects) animateDomainCardMoves(containers, previousRects)
  }, [domainGroups, bookmarkDomainGroups, historyDomainGroups, filter, source, isReady, clearUrlPreviewNow, missionContainers, packMissionsMasonryNow])

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

  async function onCloseFiltered() {
    const urls = dashboardVm.filteredCloseUrls
    if (urls.length === 0) {
      showToast('Nothing to close')
      return
    }
    const snapshot = await closeTabsExact(urls, { preserveGroups: true })
    if (snapshot.length > 0) {
      markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''}`)
    } else {
      showToast('Nothing to close')
    }
    await refreshDashboard({ animateCards: true })
  }

  async function onDedupAll() {
    const urls = dashboardVm.globalDedupeUrls
    if (urls.length === 0) return
    const snapshot = await closeDuplicateTabs(urls, true, { preservePinnedTabOut: true })
    markClosure(snapshot, `Closed ${snapshot.length} duplicate${snapshot.length !== 1 ? 's' : ''}`)
    await refreshDashboard({ animateCards: true })
  }

  async function onSourceChange(nextSource: DashboardSource) {
    if (nextSource === source) return
    const requestId = ++sourceSwitchSeqRef.current
    const previousRects = prepareDomainCardMoveAnimation(missionContainers())
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

  const stats = dashboardVm.stats
  const matchedCards = dashboardVm.matchedCards
  const unmatchedCards = dashboardVm.unmatchedCards
  const bookmarkMatchedCards = bookmarkSearchVm?.matchedCards || EMPTY_CARD_ENTRIES
  const historyMatchedCards = historySearchVm?.matchedCards || EMPTY_CARD_ENTRIES
  const showOtherTabs = isReady && dashboardVm.showOtherTabs
  const showBookmarkMatches = isReady && source === 'tabs' && !!filter && bookmarkMatchedCards.length > 0
  const showHistoryMatches = isReady && source === 'tabs' && !!filter && historyMatchedCards.length > 0
  const showHistoryRange = isReady && source === 'tabs' && !!filter
  const showPrimaryEmptyState = !((showBookmarkMatches || showHistoryMatches) && matchedCards.length === 0)
  const primaryMissionsClass = 'missions' + (matchedCards.length === 0 ? ' missions-empty' : '')
  const showTabHistory = isReady && source === 'tabs'
  const dashboardShellClass = ['dashboard-shell', showTabHistory ? 'has-history' : '', source === 'bookmarks' ? 'is-bookmarks' : ''].filter(Boolean).join(' ')

  useEffect(() => {
    previousOrderRef.current[source] = new Map(matchedCards.map(({ group }, index) => [stableGroupId(group), index]))
    if (source === 'tabs' && bookmarkMatchedCards.length > 0) {
      previousOrderRef.current.bookmarks = new Map(bookmarkMatchedCards.map(({ group }, index) => [stableGroupId(group), index]))
    }
    if (source === 'tabs' && historyMatchedCards.length > 0) {
      previousOrderRef.current.history = new Map(historyMatchedCards.map(({ group }, index) => [stableGroupId(group), index]))
    }
  }, [domainGroups, bookmarkDomainGroups, historyDomainGroups, filter, isReady, source, matchedCards, bookmarkMatchedCards, historyMatchedCards])

  return (
    <>
      <div className={dashboardShellClass}>
        {showTabHistory && (
          <TabHistoryPanel
            snapshot={tabHistory}
            onSnapshotChange={setTabHistory}
            onHoverUrlChange={setUrlPreview}
            onTabsChange={() => refreshDashboard({ animateCards: true })}
          />
        )}
        <div className="dashboard-main">
          <div className={'pinned-top' + (isScrolled ? ' is-scrolled' : '')}>
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

          <div className="scroll-region" ref={scrollRegionRef}>
            {isReady && (
              <>
                <div className={primaryMissionsClass} id="openTabsMissions" ref={primaryMissionsRef}>
                  <Missions
                    cards={matchedCards}
                    filter={filter}
                    source={source}
                    showEmptyState={showPrimaryEmptyState}
                    onHoverUrlChange={setUrlPreview}
                    onLayoutChange={scheduleMissionsMasonry}
                    onTogglePinnedDomain={togglePinnedDomain}
                  />
                </div>

                {showBookmarkMatches && (
                  <div className="missions-other missions-bookmarks" id="bookmarkMatchesSection">
                    <div className="missions-divider" role="separator">
                      <span className="missions-divider-rule" />
                      <span className="missions-divider-label">Bookmarks</span>
                      <span className="missions-divider-rule" />
                    </div>
                    <div className="missions" id="bookmarkMatchesMissions" ref={bookmarkMissionsRef}>
                      <Missions
                        cards={bookmarkMatchedCards}
                        filter={filter}
                        source="bookmarks"
                        showEmptyState={false}
                        onHoverUrlChange={setUrlPreview}
                        onLayoutChange={scheduleMissionsMasonry}
                        onTogglePinnedDomain={togglePinnedDomain}
                      />
                    </div>
                  </div>
                )}

                {showHistoryMatches && (
                  <div className="missions-other missions-history" id="historyMatchesSection">
                    <div className="missions-divider" role="separator">
                      <span className="missions-divider-rule" />
                      <span className="missions-divider-label">History</span>
                      <span className="missions-divider-rule" />
                    </div>
                    <div className="missions" id="historyMatchesMissions" ref={historyMissionsRef}>
                      <Missions
                        cards={historyMatchedCards}
                        filter={filter}
                        source="history"
                        showEmptyState={false}
                        onHoverUrlChange={setUrlPreview}
                        onLayoutChange={scheduleMissionsMasonry}
                        onTogglePinnedDomain={togglePinnedDomain}
                      />
                    </div>
                  </div>
                )}

                {showOtherTabs && (
                  <div className="missions-other" id="openTabsMissionsOther">
                    <div className="missions-divider" role="separator">
                      <span className="missions-divider-rule" />
                      <span className="missions-divider-label">Other tabs</span>
                      <span className="missions-divider-rule" />
                    </div>
                    <div className="missions" id="openTabsMissionsUnmatched" ref={unmatchedMissionsRef}>
                      <Missions
                        cards={unmatchedCards}
                        filter={filter}
                        source={source}
                        showEmptyState={false}
                        onHoverUrlChange={setUrlPreview}
                        onLayoutChange={scheduleMissionsMasonry}
                        onTogglePinnedDomain={togglePinnedDomain}
                      />
                    </div>
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
