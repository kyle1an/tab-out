import './styles/app.css'
import { mountToast } from './components/mountToast'
import { mountApp } from './components/App'
import { requestDashboardRefresh } from './extension/dashboard-controller.js'
import { groupColorChanged } from './extension/groups.js'
import { loadDashboardLocalState } from './hooks/useDashboardLocalState'
import { loadCachedDashboardStartup } from './hooks/useDashboardRefresh'
import { persistLocalGroupingConfigActive } from './extension/startup-snapshot.js'
import { addCurrentTabOutPageToStartupSnapshot } from './extension/startup-view-model.js'
import { readLocalCustomGroups, readLocalPathGroupers } from './extension/local-config.js'
import { isTabOutPageUrl } from './extension/tab-out-url.js'
import { STARTUP_ORDER_DEBUG_CAPTURE, recordStartupTiming, startupDebugNow } from './components/startup-order-debug'

type RefreshOptions = { animateCards?: boolean; startupSnapshot?: boolean }

recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'app-module-evaluated')

let refreshTimer: number | null = null
let refreshTimerOptions: RefreshOptions = {}

async function getCurrentTabOutPageForStartup(): Promise<chrome.tabs.Tab | null> {
  try {
    const tab = await chrome.tabs.getCurrent()
    if (!tab) return null
    const rawUrl = tab.url || window.location.href
    if (!isTabOutPageUrl(rawUrl)) return null
    return { ...tab, url: rawUrl }
  } catch {
    return null
  }
}

function scheduleDashboardRefresh(options: RefreshOptions = {}) {
  refreshTimerOptions = {
    animateCards: !!(refreshTimerOptions.animateCards || options.animateCards)
  }
  if (refreshTimer !== null) clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    const options = refreshTimerOptions
    refreshTimerOptions = {}
    requestDashboardRefresh(options)
  }, 250)
}

function scheduleAnimatedDashboardRefresh() {
  scheduleDashboardRefresh({ animateCards: true })
}

function schedulePassiveDashboardRefresh() {
  scheduleDashboardRefresh()
}

if (chrome.tabs) {
  chrome.tabs.onCreated.addListener(scheduleAnimatedDashboardRefresh)
  chrome.tabs.onActivated.addListener(schedulePassiveDashboardRefresh)
  chrome.tabs.onRemoved.addListener(scheduleAnimatedDashboardRefresh)
  chrome.tabs.onMoved.addListener(scheduleAnimatedDashboardRefresh)
  chrome.tabs.onAttached.addListener(scheduleAnimatedDashboardRefresh)
  chrome.tabs.onDetached.addListener(scheduleAnimatedDashboardRefresh)
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    if (
      changeInfo.title !== undefined ||
      changeInfo.url !== undefined ||
      changeInfo.favIconUrl !== undefined ||
      changeInfo.groupId !== undefined ||
      changeInfo.pinned !== undefined ||
      changeInfo.discarded !== undefined ||
      changeInfo.audible !== undefined ||
      changeInfo.mutedInfo !== undefined
    )
      scheduleDashboardRefresh({
        animateCards:
          changeInfo.url !== undefined ||
          changeInfo.groupId !== undefined ||
          changeInfo.pinned !== undefined ||
          changeInfo.discarded !== undefined
      })
  })
}

if (chrome.windows) {
  chrome.windows.onFocusChanged.addListener(schedulePassiveDashboardRefresh)
}

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(schedulePassiveDashboardRefresh)
  chrome.tabGroups.onUpdated.addListener((group) => {
    if (groupColorChanged(group)) scheduleDashboardRefresh()
  })
  chrome.tabGroups.onRemoved.addListener(schedulePassiveDashboardRefresh)
  chrome.tabGroups.onMoved.addListener(schedulePassiveDashboardRefresh)
}

if (chrome.bookmarks) {
  chrome.bookmarks.onCreated.addListener(schedulePassiveDashboardRefresh)
  chrome.bookmarks.onRemoved.addListener(schedulePassiveDashboardRefresh)
  chrome.bookmarks.onChanged.addListener(schedulePassiveDashboardRefresh)
  chrome.bookmarks.onMoved.addListener(schedulePassiveDashboardRefresh)
  chrome.bookmarks.onChildrenReordered.addListener(schedulePassiveDashboardRefresh)
  chrome.bookmarks.onImportEnded?.addListener(schedulePassiveDashboardRefresh)
}

if (chrome.history) {
  chrome.history.onVisited.addListener(schedulePassiveDashboardRefresh)
  chrome.history.onVisitRemoved.addListener(schedulePassiveDashboardRefresh)
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestDashboardRefresh()
  }
})

document.addEventListener(
  'error',
  (e) => {
    const el = e.target as HTMLElement | null
    if (el && el.tagName === 'IMG') el.style.display = 'none'
  },
  true
)

async function initializeApp() {
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'initialize-start')
  mountToast()
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'toast-mounted')
  // Tell the service worker whether page-only local grouping config is active.
  const localGroupingConfigActive = readLocalCustomGroups().length > 0 || readLocalPathGroupers().length > 0
  void persistLocalGroupingConfigActive(localGroupingConfigActive)
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'local-grouping-guard-scheduled', {
    detail: { localGroupingConfigActive }
  })
  const cacheStartedAt = startupDebugNow()
  const cachedStartup = await loadCachedDashboardStartup()
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'startup-cache-loaded', {
    startedAt: cacheStartedAt,
    detail: {
      localStateHit: !!cachedStartup?.localState,
      snapshotHit: !!cachedStartup?.snapshot
    }
  })
  const startupSnapshot = cachedStartup?.snapshot ?? null
  const currentTabOutPagePromise = startupSnapshot ? getCurrentTabOutPageForStartup() : Promise.resolve(null)
  const localStateStartedAt = startupDebugNow()
  const localState = cachedStartup?.localState ?? await loadDashboardLocalState()
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'local-state-ready', {
    ...(cachedStartup?.localState ? {} : { startedAt: localStateStartedAt }),
    detail: { source: cachedStartup?.localState ? 'startup-cache' : 'chrome-storage' }
  })
  const currentTabOutPage = await currentTabOutPagePromise
  const fallbackStartupSnapshot = startupSnapshot && currentTabOutPage
    ? addCurrentTabOutPageToStartupSnapshot(startupSnapshot, currentTabOutPage, localState)
    : startupSnapshot
  const initialStartupSnapshot = fallbackStartupSnapshot
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'mount-app', {
    detail: {
      localStateReady: !!localState,
      startupSnapshot: !!initialStartupSnapshot
    }
  })
  mountApp(initialStartupSnapshot, localState)
}

initializeApp()
