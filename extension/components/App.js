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
  const [filterFocusRequest] = useState(() => (shouldFocusFilterFromUrl() ? 1 : 0))
  const [hoveredUrl, setHoveredUrl] = useState('')
  const [isScrolled, setIsScrolled] = useState(false)
  const [pinnedDomains, setPinnedDomains] = useState([])
  const [pinsLoaded, setPinsLoaded] = useState(false)
  const [tabHistory, setTabHistory] = useState(null)
  const refreshRef = useRef(async () => {})
  const previousOrderRef = useRef({
    tabs: new Map(),
    bookmarks: new Map()
  })
  const scrollRegionRef = useRef(null)
  const primaryMissionsRef = useRef(null)
  const unmatchedMissionsRef = useRef(null)
  const realTabs = dashboard?.realTabs || []
  const domainGroups = dashboard?.domainGroups || []
  const isReady = !!dashboard
  const { packMissionsMasonryNow, scheduleMissionsMasonry } = useMissionsMasonry(primaryMissionsRef, unmatchedMissionsRef)

  refreshRef.current = async () => {
    if (document.visibilityState !== 'visible') return
    if (!pinsLoaded) return
    const [next, nextTabHistory] = await Promise.all([
      fetchDashboardData(previousOrderRef.current[source] || new Map(), source, { pinnedDomains }),
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
      previousOrderRef.current = { tabs: new Map(), bookmarks: new Map() }
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
  }, [domainGroups, filter, isReady])

  const dashboardVm = buildDashboardViewModel({
    realTabs,
    domainGroups,
    filter,
    source
  })

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
    previousOrderRef.current = { tabs: new Map(), bookmarks: new Map() }
    setPinnedDomains(nextPinnedDomains)
    try {
      await savePinnedDomains(nextPinnedDomains)
    } catch {
      showToast('Could not save pinned domain')
      setPinnedDomains(pinnedDomains)
    }
  }

  const stats = dashboardVm.stats
  const matchedCards = dashboardVm.matchedCards
  const unmatchedCards = dashboardVm.unmatchedCards
  const showOtherTabs = isReady && dashboardVm.showOtherTabs
  const showTabHistory = isReady && source === 'tabs'

  useEffect(() => {
    previousOrderRef.current[source] = new Map(matchedCards.map(({ group }, index) => [stableGroupId(group), index]))
  }, [domainGroups, filter, isReady, source])

  return html`
    <${Fragment}>
      <div class=${'dashboard-shell' + (showTabHistory ? ' has-history' : '')}>
        ${showTabHistory &&
        html`<${TabHistoryPanel}
          snapshot=${tabHistory}
          onSnapshotChange=${setTabHistory}
          onHoverUrlChange=${setHoveredUrl}
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
              onFilterChange=${setFilterInput}
              onSourceChange=${setSource}
              onCloseFiltered=${onCloseFiltered}
              onDedupAll=${onDedupAll}
            />
          </div>

          <div class="scroll-region" ref=${scrollRegionRef}>
            <div class="active-section" id="openTabsSection" style=${isReady ? '' : 'display:none'}>
              <div class="missions" id="openTabsMissions" ref=${primaryMissionsRef}>
                ${isReady &&
                html`<${Missions}
                  cards=${matchedCards}
                  filter=${filter}
                  source=${source}
                  onHoverUrlChange=${setHoveredUrl}
                  onLayoutChange=${scheduleMissionsMasonry}
                  onTogglePinnedDomain=${onTogglePinnedDomain}
                />`}
              </div>

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
