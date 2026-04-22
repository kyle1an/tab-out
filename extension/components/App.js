import { h, Fragment, render as preactRender } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.mjs'
import { closeDuplicateTabs, closeTabsExact } from '../tabs.js'
import { useMissionsMasonry } from '../layout.js'
import { showToast } from './Toast.js'
import { markClosure } from '../undo.js'
import { registerDashboardRefresh } from '../dashboard-controller.js'
import { buildDashboardViewModel, fetchDashboardData } from '../render.js'
import { HeaderBar } from './HeaderBar.js'
import { Missions } from './Missions.js'
import { UrlPreview } from './UrlPreview.js'

const html = htm.bind(h)

function stableGroupId(group) {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')
}

export function App({ initialDashboard = null }) {
  const [dashboard, setDashboard] = useState(initialDashboard)
  const [source, setSource] = useState('tabs')
  const [filter, setFilter] = useState('')
  const [hoveredUrl, setHoveredUrl] = useState('')
  const [isScrolled, setIsScrolled] = useState(false)
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
    const next = await fetchDashboardData(previousOrderRef.current[source] || new Map(), source)
    setDashboard(next)
  }

  useEffect(() => registerDashboardRefresh(() => refreshRef.current()), [])

  useEffect(() => {
    setHoveredUrl('')
    requestAnimationFrame(() => refreshRef.current())
  }, [source])

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
    const snapshot = await closeDuplicateTabs(urls, true)
    markClosure(snapshot, `Closed ${snapshot.length} duplicate${snapshot.length !== 1 ? 's' : ''}`)
    await refreshRef.current()
  }

  const stats = dashboardVm.stats
  const matchedCards = dashboardVm.matchedCards
  const unmatchedCards = dashboardVm.unmatchedCards
  const showOtherTabs = isReady && dashboardVm.showOtherTabs

  useEffect(() => {
    previousOrderRef.current[source] = new Map(matchedCards.map(({ group }, index) => [stableGroupId(group), index]))
  }, [domainGroups, filter, isReady, source])

  return html`
    <${Fragment}>
      <div class=${'pinned-top' + (isScrolled ? ' is-scrolled' : '')}>
        <div class="page-inner">
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
            filter=${filter}
            onFilterChange=${setFilter}
            onSourceChange=${setSource}
            onCloseFiltered=${onCloseFiltered}
            onDedupAll=${onDedupAll}
          />
        </div>
      </div>

      <div class="scroll-region" ref=${scrollRegionRef}>
        <div class="page-inner">
          <div class="active-section" id="openTabsSection" style=${isReady ? '' : 'display:none'}>
            <div class="missions" id="openTabsMissions" ref=${primaryMissionsRef}>
              ${isReady &&
              html`<${Missions}
                cards=${matchedCards}
                filter=${filter}
                onHoverUrlChange=${setHoveredUrl}
                onLayoutChange=${scheduleMissionsMasonry}
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
                    showEmptyState=${false}
                    onHoverUrlChange=${setHoveredUrl}
                    onLayoutChange=${scheduleMissionsMasonry}
                  />
                </div>
              </div>
            `}
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
