import { h, Fragment, render as preactRender } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.mjs'
import { closeDuplicateTabs, closeTabsExact } from '../tabs.js'
import { packMissionsMasonry } from '../layout.js'
import { showToast } from './Toast.js'
import { markClosure } from '../undo.js'
import { registerDashboardRefresh } from '../dashboard-controller.js'
import { buildDashboardViewModel, fetchDashboardData } from '../render.js'
import { HeaderBar } from './HeaderBar.js'
import { Missions } from './Missions.js'
import { UrlPreview } from './UrlPreview.js'

const html = htm.bind(h)

export function App({ initialDashboard = null }) {
  const [dashboard, setDashboard] = useState(initialDashboard)
  const [filter, setFilter] = useState('')
  const [hoveredUrl, setHoveredUrl] = useState('')
  const refreshRef = useRef(async () => {})
  const realTabs = dashboard?.realTabs || []
  const domainGroups = dashboard?.domainGroups || []
  const isReady = !!dashboard

  refreshRef.current = async () => {
    if (document.visibilityState !== 'visible') return
    const next = await fetchDashboardData()
    setDashboard(next)
  }

  useEffect(() => registerDashboardRefresh(() => refreshRef.current()), [])

  useLayoutEffect(() => {
    if (!isReady) return
    setHoveredUrl('')
    packMissionsMasonry({ unpin: true })
  }, [domainGroups, filter, isReady])

  const dashboardVm = buildDashboardViewModel({
    realTabs,
    domainGroups,
    filter
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

  return html`
    <${Fragment}>
      <div class="pinned-top">
        <div class="page-inner">
          <${HeaderBar}
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
            onCloseFiltered=${onCloseFiltered}
            onDedupAll=${onDedupAll}
          />
        </div>
      </div>

      <div class="scroll-region">
        <div class="page-inner">
          <div class="active-section" id="openTabsSection" style=${isReady ? '' : 'display:none'}>
            <div class="missions" id="openTabsMissions">
              ${isReady && html`<${Missions} cards=${matchedCards} filter=${filter} onHoverUrlChange=${setHoveredUrl} />`}
            </div>

            ${showOtherTabs &&
            html`
              <div class="missions-other" id="openTabsMissionsOther">
                <div class="missions-divider" role="separator">
                  <span class="missions-divider-rule"></span>
                  <span class="missions-divider-label">Other tabs</span>
                  <span class="missions-divider-rule"></span>
                </div>
                <div class="missions" id="openTabsMissionsUnmatched">
                  <${Missions} cards=${unmatchedCards} filter=${filter} showEmptyState=${false} onHoverUrlChange=${setHoveredUrl} />
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
