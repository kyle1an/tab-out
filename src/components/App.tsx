import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { closeDuplicateTabs, closeTabsExact } from '../../extension/tabs.js'
import { useMissionsMasonry } from '../../extension/layout.js'
import { showToast } from '../../extension/toast.js'
import { markClosure } from '../../extension/undo.js'
import { registerDashboardRefresh } from '../../extension/dashboard-controller.js'
import { buildDashboardViewModel, fetchDashboardData } from '../../extension/render.js'
import { fetchTabHistorySnapshot } from '../../extension/tab-history.js'
import { loadPinnedDomains, savePinnedDomains, togglePinnedDomainInList } from '../../extension/domain-pins.js'
import { DEFAULT_HISTORY_RANGE, isHistoryFilterEnabled } from '../../extension/history-source.js'
import {
  FOCUS_FILTER_PARAM,
  filterInputFromSearch,
  titleForFilterInput,
  urlForFilterInput
} from '../../extension/app-url.js'
import { HeaderBar } from './HeaderBar'
import { Missions } from './Missions'
import { TabHistoryPanel } from './TabHistoryPanel'
import { UrlPreview } from './UrlPreview'

type DashboardSource = 'tabs' | 'bookmarks' | 'history'
type RefreshOptions = { animateCards?: boolean }

const FILTER_UPDATE_DELAY_MS = 200
const FILTER_URL_SYNC_DELAY_MS = 600
const URL_PREVIEW_HIDE_DELAY_MS = 120
const CARD_MOVE_MS = 280
const activeCardMoveAnimations = new WeakMap()

function filterInputFromCurrentUrl() {
  return filterInputFromSearch(window.location.search)
}

function syncFilterInputToUrl(filterInput) {
  const nextUrl = urlForFilterInput(filterInput, window.location)
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
}

function shouldFocusFilterFromUrl() {
  return new URLSearchParams(window.location.search).get(FOCUS_FILTER_PARAM) === '1'
}

function clearFocusFilterParam() {
  const params = new URLSearchParams(window.location.search)
  if (!params.has(FOCUS_FILTER_PARAM)) return

  params.delete(FOCUS_FILTER_PARAM)
  const nextSearch = params.toString()
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
  window.history.replaceState(null, '', nextUrl)
}

function stableGroupId(group) {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')
}

function shouldReduceMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function snapshotDomainCardRects(containers) {
  const rects = new Map()
  if (shouldReduceMotion()) return rects

  containers.forEach((container) => {
    if (!container) return
    container.querySelectorAll('.domain-block:not(.closing)').forEach((block) => {
      const id = block.dataset.domainId
      if (!id) return
      const rect = block.getBoundingClientRect()
      if (!rects.has(id)) rects.set(id, [])
      rects.get(id).push({
        left: rect.left,
        top: rect.top
      })
    })
  })

  return rects
}

function cancelDomainCardMove(block) {
  const active = activeCardMoveAnimations.get(block)
  if (active) {
    cancelAnimationFrame(active.frameId)
    clearTimeout(active.timeoutId)
    block.removeEventListener('transitionend', active.onTransitionEnd)
    activeCardMoveAnimations.delete(block)
  }

  block.classList.remove('layout-moving', 'layout-moving-active')
  block.style.transform = ''
}

function cancelDomainCardMoves(containers) {
  containers.forEach((container) => {
    if (!container) return
    container.querySelectorAll('.domain-block.layout-moving').forEach(cancelDomainCardMove)
  })
}

function prepareDomainCardMoveAnimation(containers) {
  const previousRects = snapshotDomainCardRects(containers)
  cancelDomainCardMoves(containers)
  return previousRects
}

function takeClosestPreviousRect(previousRects, id, nextRect) {
  const candidates = id ? previousRects.get(id) : null
  if (!candidates || candidates.length === 0) return null

  let closestIndex = 0
  let closestDistance = Infinity
  candidates.forEach((candidate, index) => {
    const dx = candidate.left - nextRect.left
    const dy = candidate.top - nextRect.top
    const distance = dx * dx + dy * dy
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })

  const [closest] = candidates.splice(closestIndex, 1)
  if (candidates.length === 0) previousRects.delete(id)
  return closest
}

function animateDomainCardMoves(containers, previousRects) {
  if (!previousRects || previousRects.size === 0 || shouldReduceMotion()) return

  const moving = []
  containers.forEach((container) => {
    if (!container) return
    container.querySelectorAll('.domain-block:not(.closing)').forEach((block) => {
      const id = block.dataset.domainId

      cancelDomainCardMove(block)
      const next = block.getBoundingClientRect()
      const previous = takeClosestPreviousRect(previousRects, id, next)
      if (!previous) return

      const dx = previous.left - next.left
      const dy = previous.top - next.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return

      block.classList.add('layout-moving')
      block.style.transform = `translate(${dx}px, ${dy}px)`
      moving.push(block)
    })
  })

  if (moving.length === 0) return

  document.body.getBoundingClientRect()

  moving.forEach((block) => {
    function cleanup() {
      if (activeCardMoveAnimations.get(block) !== active) return
      activeCardMoveAnimations.delete(block)
      block.removeEventListener('transitionend', onTransitionEnd)
      block.classList.remove('layout-moving', 'layout-moving-active')
      block.style.transform = ''
    }
    function onTransitionEnd(e) {
      if (e.target === block && e.propertyName === 'transform') cleanup()
    }
    const active = {
      frameId: 0,
      timeoutId: 0,
      onTransitionEnd
    }

    block.addEventListener('transitionend', onTransitionEnd)
    active.frameId = requestAnimationFrame(() => {
      if (activeCardMoveAnimations.get(block) !== active) return
      block.classList.add('layout-moving-active')
      block.style.transform = 'translate(0, 0)'
    })
    active.timeoutId = window.setTimeout(cleanup, CARD_MOVE_MS + 80)
    activeCardMoveAnimations.set(block, active)
  })
}

export function App({ initialDashboard = null }) {
  const [dashboard, setDashboard] = useState(initialDashboard)
  const [source, setSource] = useState<DashboardSource>('tabs')
  const [filterInput, setFilterInput] = useState(filterInputFromCurrentUrl)
  const [filter, setFilter] = useState(filterInputFromCurrentUrl)
  const [historyRange, setHistoryRange] = useState(DEFAULT_HISTORY_RANGE)
  const [filterFocusRequest] = useState(() => (shouldFocusFilterFromUrl() ? 1 : 0))
  const [urlPreview, setUrlPreviewState] = useState({ url: '', visible: false })
  const [isScrolled, setIsScrolled] = useState(false)
  const [pinnedDomains, setPinnedDomains] = useState<string[]>([])
  const [pinsLoaded, setPinsLoaded] = useState(false)
  const [tabHistory, setTabHistory] = useState(null)
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => {})
  const urlPreviewHideTimerRef = useRef<number | null>(null)
  const sourceSwitchSeqRef = useRef(0)
  const layoutMoveRectsRef = useRef(null)
  const previousOrderRef = useRef({
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map()
  })
  const scrollRegionRef = useRef<HTMLDivElement | null>(null)
  const primaryMissionsRef = useRef<HTMLDivElement | null>(null)
  const bookmarkMissionsRef = useRef<HTMLDivElement | null>(null)
  const historyMissionsRef = useRef<HTMLDivElement | null>(null)
  const unmatchedMissionsRef = useRef<HTMLDivElement | null>(null)
  const realTabs = dashboard?.realTabs || []
  const domainGroups = dashboard?.domainGroups || []
  const bookmarkTabs = dashboard?.bookmarkTabs || []
  const bookmarkDomainGroups = dashboard?.bookmarkDomainGroups || []
  const historyTabs = dashboard?.historyTabs || []
  const historyDomainGroups = dashboard?.historyDomainGroups || []
  const isReady = !!dashboard
  const historyFilterEnabled = isHistoryFilterEnabled(historyRange)
  const { packMissionsMasonryNow, scheduleMissionsMasonry } = useMissionsMasonry(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef, {
    onBeforePack: prepareDomainCardMoveAnimation,
    onAfterPack: animateDomainCardMoves
  })

  function missionContainers() {
    return [primaryMissionsRef.current, bookmarkMissionsRef.current, historyMissionsRef.current, unmatchedMissionsRef.current]
  }

  function primeCardMoveAnimation() {
    layoutMoveRectsRef.current = prepareDomainCardMoveAnimation(missionContainers())
  }

  function clearUrlPreviewHideTimer() {
    if (urlPreviewHideTimerRef.current === null) return
    clearTimeout(urlPreviewHideTimerRef.current)
    urlPreviewHideTimerRef.current = null
  }

  function setUrlPreview(url) {
    const nextUrl = url || ''
    if (nextUrl) {
      clearUrlPreviewHideTimer()
      setUrlPreviewState((prev) => (prev.url === nextUrl && prev.visible ? prev : { url: nextUrl, visible: true }))
      return
    }

    clearUrlPreviewHideTimer()
    urlPreviewHideTimerRef.current = window.setTimeout(() => {
      urlPreviewHideTimerRef.current = null
      setUrlPreviewState((prev) => (prev.visible ? { ...prev, visible: false } : prev))
    }, URL_PREVIEW_HIDE_DELAY_MS)
  }

  function clearUrlPreviewNow() {
    clearUrlPreviewHideTimer()
    setUrlPreviewState((prev) => (prev.url || prev.visible ? { url: '', visible: false } : prev))
  }

  refreshRef.current = async ({ animateCards = false }: RefreshOptions = {}) => {
    if (document.visibilityState !== 'visible') return
    if (!pinsLoaded) return
    if (animateCards) primeCardMoveAnimation()
    const [next, nextTabHistory] = await Promise.all([
      fetchDashboardData(previousOrderRef.current[source] || new Map(), source, {
        pinnedDomains,
        bookmarkPreviousOrder: previousOrderRef.current.bookmarks || new Map(),
        historyPreviousOrder: previousOrderRef.current.history || new Map(),
        includeBookmarkMatches: source === 'tabs' && filter !== '',
        includeHistoryMatches: source === 'tabs' && filter !== '' && historyFilterEnabled,
        searchQuery: filter,
        historyRange
      }),
      fetchTabHistorySnapshot()
    ])
    setDashboard(next)
    setTabHistory(nextTabHistory)
  }

  useEffect(() => registerDashboardRefresh((options) => refreshRef.current(options)), [])

  useEffect(() => {
    let cancelled = false
    loadPinnedDomains().then((domains) => {
      if (cancelled) return
      previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
      setPinnedDomains(domains)
      setPinsLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    clearFocusFilterParam()
  }, [])

  useEffect(() => {
    if (!isReady || !pinsLoaded || source !== 'tabs' || !filter) return
    const historySearchReady = !historyFilterEnabled || (dashboard?.historySearchQuery === filter.trim() && dashboard?.historyRange === historyRange)
    if (dashboard?.bookmarkSearchReady && historySearchReady) return
    const frame = requestAnimationFrame(() => refreshRef.current())
    return () => cancelAnimationFrame(frame)
  }, [filter, historyRange, historyFilterEnabled, isReady, pinsLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (filterInput === filter) return
    if (filterInput === '') {
      primeCardMoveAnimation()
      setFilter('')
      return
    }
    const timer = window.setTimeout(() => {
      primeCardMoveAnimation()
      setFilter(filterInput)
    }, FILTER_UPDATE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [filterInput, filter])

  useEffect(() => {
    document.title = titleForFilterInput(filterInput)
  }, [filterInput])

  useEffect(() => {
    if (filterInput === '') {
      syncFilterInputToUrl('')
      return
    }

    const timer = window.setTimeout(() => syncFilterInputToUrl(filterInput), FILTER_URL_SYNC_DELAY_MS)
    return () => clearTimeout(timer)
  }, [filterInput])

  useEffect(() => {
    if (!pinsLoaded) return
    clearUrlPreviewNow()
    requestAnimationFrame(() => refreshRef.current())
  }, [pinnedDomains, pinsLoaded])

  useEffect(() => () => clearUrlPreviewHideTimer(), [])

  useEffect(() => {
    const scrollEl = scrollRegionRef.current
    if (!scrollEl) return

    function onScroll() {
      const next = scrollEl.scrollTop > 0
      setIsScrolled((prev) => (prev === next ? prev : next))
    }

    onScroll()
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    return () => scrollEl.removeEventListener('scroll', onScroll)
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
  }, [domainGroups, bookmarkDomainGroups, historyDomainGroups, filter, source, isReady])

  const dashboardVm = buildDashboardViewModel({
    realTabs,
    domainGroups,
    filter,
    source
  })
  const bookmarkSearchVm =
    source === 'tabs' && filter && dashboard?.bookmarkSearchReady
      ? buildDashboardViewModel({
          realTabs: bookmarkTabs,
          domainGroups: bookmarkDomainGroups,
          filter,
          source: 'bookmarks'
        })
      : null
  const historySearchVm =
    source === 'tabs' && filter && historyFilterEnabled && dashboard?.historySearchQuery === filter.trim() && dashboard?.historyRange === historyRange
      ? buildDashboardViewModel({
          realTabs: historyTabs,
          domainGroups: historyDomainGroups,
          filter,
          source: 'history'
        })
      : null

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
    await refreshRef.current({ animateCards: true })
  }

  async function onDedupAll() {
    const urls = dashboardVm.globalDedupeUrls
    if (urls.length === 0) return
    const snapshot = await closeDuplicateTabs(urls, true, { preservePinnedTabOut: true })
    markClosure(snapshot, `Closed ${snapshot.length} duplicate${snapshot.length !== 1 ? 's' : ''}`)
    await refreshRef.current({ animateCards: true })
  }

  async function onTogglePinnedDomain(domain) {
    const nextPinnedDomains = togglePinnedDomainInList(pinnedDomains, domain)
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map(), history: new Map() }
    setPinnedDomains(nextPinnedDomains)
    try {
      await savePinnedDomains(nextPinnedDomains)
    } catch {
      showToast('Could not save pinned domain')
      setPinnedDomains(pinnedDomains)
    }
  }

  async function onSourceChange(nextSource: DashboardSource) {
    if (nextSource === source) return
    const requestId = ++sourceSwitchSeqRef.current
    const previousRects = prepareDomainCardMoveAnimation(missionContainers())
    clearUrlPreviewNow()
    const [nextDashboard, nextTabHistory] = await Promise.all([
      fetchDashboardData(previousOrderRef.current[nextSource] || new Map(), nextSource, {
        pinnedDomains,
        bookmarkPreviousOrder: previousOrderRef.current.bookmarks || new Map(),
        historyPreviousOrder: previousOrderRef.current.history || new Map(),
        includeBookmarkMatches: nextSource === 'tabs' && filter !== '',
        includeHistoryMatches: nextSource === 'tabs' && filter !== '' && historyFilterEnabled,
        searchQuery: filter,
        historyRange
      }),
      fetchTabHistorySnapshot()
    ])
    if (requestId !== sourceSwitchSeqRef.current) return
    layoutMoveRectsRef.current = previousRects
    setDashboard(nextDashboard)
    setTabHistory(nextTabHistory)
    setSource(nextSource)
  }

  const stats = dashboardVm.stats
  const matchedCards = dashboardVm.matchedCards
  const unmatchedCards = dashboardVm.unmatchedCards
  const bookmarkMatchedCards = bookmarkSearchVm?.matchedCards || []
  const historyMatchedCards = historySearchVm?.matchedCards || []
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
  }, [domainGroups, bookmarkDomainGroups, historyDomainGroups, filter, isReady, source])

  return (
    <>
      <div className={dashboardShellClass}>
        {showTabHistory && (
          <TabHistoryPanel
            snapshot={tabHistory}
            onSnapshotChange={setTabHistory}
            onHoverUrlChange={setUrlPreview}
            onTabsChange={() => refreshRef.current({ animateCards: true })}
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
                    onTogglePinnedDomain={onTogglePinnedDomain}
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
                        onTogglePinnedDomain={onTogglePinnedDomain}
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
                        onTogglePinnedDomain={onTogglePinnedDomain}
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
                        onTogglePinnedDomain={onTogglePinnedDomain}
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

export function mountApp(initialDashboard = null) {
  const el = document.getElementById('appRoot')
  if (!el) return
  createRoot(el).render(<App initialDashboard={initialDashboard} />)
}
