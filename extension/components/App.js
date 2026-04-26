import { h, Fragment, render as preactRender } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.mjs'
import { closeDuplicateTabs, closeTabsExact } from '../tabs.js'
import { useMissionsMasonry } from '../layout.js'
import { showToast } from './Toast.js'
import { markClosure } from '../undo.js'
import { registerDashboardRefresh } from '../dashboard-controller.js'
import { buildDashboardViewModel, fetchDashboardData } from '../render.js'
import { fetchTabHistorySnapshot } from '../tab-history.js'
import { loadPinnedDomains, savePinnedDomains, togglePinnedDomainInList } from '../domain-pins.js'
import { HeaderBar } from './HeaderBar.js'
import { Missions } from './Missions.js'
import { TabHistoryPanel } from './TabHistoryPanel.js'
import { UrlPreview } from './UrlPreview.js'
import { DEFAULT_HISTORY_RANGE } from '../history-source.js'

const html = htm.bind(h)
const FOCUS_FILTER_PARAM = 'focusFilter'
const FILTER_PARAM = 'filter'
const DEFAULT_PAGE_TITLE = '\u200e'

export function titleForFilterInput(filterInput = '') {
  const keyword = filterInput.trim()
  return keyword ? `${keyword} - Tab Out` : DEFAULT_PAGE_TITLE
}

export function filterInputFromSearch(search = '') {
  return new URLSearchParams(search).get(FILTER_PARAM) || ''
}

export function urlForFilterInput(filterInput = '', locationParts = {}) {
  const { pathname = '', search = '', hash = '' } = locationParts
  const params = new URLSearchParams(search)
  if (filterInput === '') params.delete(FILTER_PARAM)
  else params.set(FILTER_PARAM, filterInput)

  const nextSearch = params.toString()
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash || ''}`
}

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

export function App({ initialDashboard = null }) {
  const [dashboard, setDashboard] = useState(initialDashboard)
  const [source, setSource] = useState('tabs')
  const [filterInput, setFilterInput] = useState(filterInputFromCurrentUrl)
  const [filter, setFilter] = useState(filterInputFromCurrentUrl)
  const [historyRange, setHistoryRange] = useState(DEFAULT_HISTORY_RANGE)
  const [filterFocusRequest] = useState(() => (shouldFocusFilterFromUrl() ? 1 : 0))
  const [hoveredUrl, setHoveredUrl] = useState('')
  const [isScrolled, setIsScrolled] = useState(false)
  const [pinnedDomains, setPinnedDomains] = useState([])
  const [pinsLoaded, setPinsLoaded] = useState(false)
  const [tabHistory, setTabHistory] = useState(null)
  const refreshRef = useRef(async () => {})
  const sourceSwitchSeqRef = useRef(0)
  const previousOrderRef = useRef({
    tabs: new Map(),
    bookmarks: new Map(),
    history: new Map()
  })
  const scrollRegionRef = useRef(null)
  const primaryMissionsRef = useRef(null)
  const bookmarkMissionsRef = useRef(null)
  const historyMissionsRef = useRef(null)
  const unmatchedMissionsRef = useRef(null)
  const realTabs = dashboard?.realTabs || []
  const domainGroups = dashboard?.domainGroups || []
  const bookmarkTabs = dashboard?.bookmarkTabs || []
  const bookmarkDomainGroups = dashboard?.bookmarkDomainGroups || []
  const historyTabs = dashboard?.historyTabs || []
  const historyDomainGroups = dashboard?.historyDomainGroups || []
  const isReady = !!dashboard
  const { packMissionsMasonryNow, scheduleMissionsMasonry } = useMissionsMasonry(primaryMissionsRef, bookmarkMissionsRef, historyMissionsRef, unmatchedMissionsRef)

  refreshRef.current = async () => {
    if (document.visibilityState !== 'visible') return
    if (!pinsLoaded) return
    const [next, nextTabHistory] = await Promise.all([
      fetchDashboardData(previousOrderRef.current[source] || new Map(), source, {
        pinnedDomains,
        bookmarkPreviousOrder: previousOrderRef.current.bookmarks || new Map(),
        historyPreviousOrder: previousOrderRef.current.history || new Map(),
        includeBookmarkMatches: source === 'tabs' && filter !== '',
        includeHistoryMatches: source === 'tabs' && filter !== '',
        searchQuery: filter,
        historyRange
      }),
      fetchTabHistorySnapshot()
    ])
    setDashboard(next)
    setTabHistory(nextTabHistory)
  }

  useEffect(() => registerDashboardRefresh(() => refreshRef.current()), [])

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
    if (dashboard?.bookmarkSearchReady && dashboard?.historySearchQuery === filter.trim() && dashboard?.historyRange === historyRange) return
    const frame = requestAnimationFrame(() => refreshRef.current())
    return () => cancelAnimationFrame(frame)
  }, [filter, historyRange, isReady, pinsLoaded, source, dashboard?.bookmarkSearchReady, dashboard?.historySearchQuery, dashboard?.historyRange])

  useEffect(() => {
    if (filterInput === filter) return
    if (filterInput === '') {
      setFilter('')
      return
    }
    const timer = setTimeout(() => setFilter(filterInput), 200)
    return () => clearTimeout(timer)
  }, [filterInput, filter])

  useEffect(() => {
    document.title = titleForFilterInput(filterInput)
  }, [filterInput])

  useEffect(() => {
    syncFilterInputToUrl(filterInput)
  }, [filterInput])

  useEffect(() => {
    if (!pinsLoaded) return
    setHoveredUrl('')
    requestAnimationFrame(() => refreshRef.current())
  }, [source, pinnedDomains, pinsLoaded])

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
    setHoveredUrl('')
    packMissionsMasonryNow({ unpin: true })
  }, [domainGroups, bookmarkDomainGroups, historyDomainGroups, filter, isReady])

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
    source === 'tabs' && filter && dashboard?.historySearchQuery === filter.trim() && dashboard?.historyRange === historyRange
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
    await refreshRef.current()
  }

  async function onDedupAll() {
    const urls = dashboardVm.globalDedupeUrls
    if (urls.length === 0) return
    const snapshot = await closeDuplicateTabs(urls, true, { preservePinnedTabOut: true })
    markClosure(snapshot, `Closed ${snapshot.length} duplicate${snapshot.length !== 1 ? 's' : ''}`)
    await refreshRef.current()
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

  async function onSourceChange(nextSource) {
    if (nextSource === source) return
    const requestId = ++sourceSwitchSeqRef.current
    setHoveredUrl('')
    const [nextDashboard, nextTabHistory] = await Promise.all([
      fetchDashboardData(previousOrderRef.current[nextSource] || new Map(), nextSource, {
        pinnedDomains,
        bookmarkPreviousOrder: previousOrderRef.current.bookmarks || new Map(),
        historyPreviousOrder: previousOrderRef.current.history || new Map(),
        includeBookmarkMatches: nextSource === 'tabs' && filter !== '',
        includeHistoryMatches: nextSource === 'tabs' && filter !== '',
        searchQuery: filter,
        historyRange
      }),
      fetchTabHistorySnapshot()
    ])
    if (requestId !== sourceSwitchSeqRef.current) return
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

  return html`
    <${Fragment}>
      <div class=${dashboardShellClass}>
        ${showTabHistory &&
        html`<${TabHistoryPanel}
          snapshot=${tabHistory}
          onSnapshotChange=${setTabHistory}
          onHoverUrlChange=${setHoveredUrl}
          onTabsChange=${() => refreshRef.current()}
        />`}
        <div class="dashboard-main">
          <div class=${'pinned-top' + (isScrolled ? ' is-scrolled' : '')}>
            <${HeaderBar}
              source=${source}
              totalTabs=${stats.totalTabs}
              visibleTabs=${stats.visibleTabs}
              totalWindows=${stats.totalWindows}
              visibleWindows=${stats.visibleWindows}
              totalDomains=${stats.totalDomains}
              visibleDomains=${stats.visibleDomains}
              dedupCount=${stats.dedupCount}
              filteredCloseCount=${stats.filteredCloseCount}
              hasCards=${stats.hasCards}
              filtering=${stats.filtering}
              ready=${isReady}
              filter=${filterInput}
              filterFocusRequest=${filterFocusRequest}
              historyRange=${historyRange}
              showHistoryRange=${showHistoryRange}
              onFilterChange=${setFilterInput}
              onHistoryRangeChange=${setHistoryRange}
              onSourceChange=${onSourceChange}
              onCloseFiltered=${onCloseFiltered}
              onDedupAll=${onDedupAll}
            />
          </div>

          <div class="scroll-region" ref=${scrollRegionRef}>
            <div class="active-section" id="openTabsSection" style=${isReady ? '' : 'display:none'}>
              <div class=${primaryMissionsClass} id="openTabsMissions" ref=${primaryMissionsRef}>
                ${isReady &&
                html`<${Missions}
                  cards=${matchedCards}
                  filter=${filter}
                  source=${source}
                  showEmptyState=${showPrimaryEmptyState}
                  onHoverUrlChange=${setHoveredUrl}
                  onLayoutChange=${scheduleMissionsMasonry}
                  onTogglePinnedDomain=${onTogglePinnedDomain}
                />`}
              </div>

              ${showBookmarkMatches &&
              html`
                <div class="missions-other missions-bookmarks" id="bookmarkMatchesSection">
                  <div class="missions-divider" role="separator">
                    <span class="missions-divider-rule"></span>
                    <span class="missions-divider-label">Bookmarks</span>
                    <span class="missions-divider-rule"></span>
                  </div>
                  <div class="missions" id="bookmarkMatchesMissions" ref=${bookmarkMissionsRef}>
                    <${Missions}
                      cards=${bookmarkMatchedCards}
                      filter=${filter}
                      source="bookmarks"
                      showEmptyState=${false}
                      onHoverUrlChange=${setHoveredUrl}
                      onLayoutChange=${scheduleMissionsMasonry}
                      onTogglePinnedDomain=${onTogglePinnedDomain}
                    />
                  </div>
                </div>
              `}

              ${showHistoryMatches &&
              html`
                <div class="missions-other missions-history" id="historyMatchesSection">
                  <div class="missions-divider" role="separator">
                    <span class="missions-divider-rule"></span>
                    <span class="missions-divider-label">History</span>
                    <span class="missions-divider-rule"></span>
                  </div>
                  <div class="missions" id="historyMatchesMissions" ref=${historyMissionsRef}>
                    <${Missions}
                      cards=${historyMatchedCards}
                      filter=${filter}
                      source="history"
                      showEmptyState=${false}
                      onHoverUrlChange=${setHoveredUrl}
                      onLayoutChange=${scheduleMissionsMasonry}
                      onTogglePinnedDomain=${onTogglePinnedDomain}
                    />
                  </div>
                </div>
              `}

              ${showOtherTabs &&
              html`
                <div class="missions-other" id="openTabsMissionsOther">
                  <div class="missions-divider" role="separator">
                    <span class="missions-divider-rule"></span>
                    <span class="missions-divider-label">Other tabs</span>
                    <span class="missions-divider-rule"></span>
                  </div>
                  <div class="missions" id="openTabsMissionsUnmatched" ref=${unmatchedMissionsRef}>
                    <${Missions}
                      cards=${unmatchedCards}
                      filter=${filter}
                      source=${source}
                      showEmptyState=${false}
                      onHoverUrlChange=${setHoveredUrl}
                      onLayoutChange=${scheduleMissionsMasonry}
                      onTogglePinnedDomain=${onTogglePinnedDomain}
                    />
                  </div>
                </div>
              `}
            </div>
          </div>
        </div>
      </div>

      <${UrlPreview} url=${hoveredUrl} />
    </${Fragment}>
  `
}

export function mountApp(initialDashboard = null) {
  const el = document.getElementById('appRoot')
  if (!el) return
  preactRender(html`<${App} initialDashboard=${initialDashboard} />`, el)
}
