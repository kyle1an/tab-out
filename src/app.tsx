import './styles/app.css'
import { mountToast } from './components/Toast'
import { mountApp } from './components/App'
import { requestDashboardRefresh } from './extension/dashboard-controller.js'
import { groupColorChanged } from './extension/groups.js'

type RefreshOptions = { animateCards?: boolean }

let refreshTimer: number | null = null
let refreshTimerOptions: RefreshOptions = {}

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
      changeInfo.discarded !== undefined
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
  mountToast()
  mountApp()

  if (document.visibilityState === 'visible') {
    requestDashboardRefresh()
  }
}

initializeApp()
