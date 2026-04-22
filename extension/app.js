/* ================================================================
   Tab Out — entry point

   app.js now owns only lifecycle wiring:
     • Mount the Preact dashboard shell + toast root
     • Schedule data refreshes from chrome.tabs / chrome.tabGroups
     • Auto-close duplicate Tab Out tabs on focus
     • Hide broken favicons with a capture-phase image-error listener

   The actual page UI (header, filter, missions grids, URL preview)
   lives under components/App.js.
   ================================================================ */

import { closeTabOutDupes } from './tabs.js'
import { mountToast } from './components/Toast.js'
import { mountApp } from './components/App.js'
import { requestDashboardRefresh } from './dashboard-controller.js'
import { groupColorChanged } from './groups.js'

let refreshTimer = null

function scheduleDashboardRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => requestDashboardRefresh(), 250)
}

if (chrome.tabs) {
  chrome.tabs.onCreated.addListener(scheduleDashboardRefresh)
  chrome.tabs.onRemoved.addListener(scheduleDashboardRefresh)
  chrome.tabs.onMoved.addListener(scheduleDashboardRefresh)
  chrome.tabs.onAttached.addListener(scheduleDashboardRefresh)
  chrome.tabs.onDetached.addListener(scheduleDashboardRefresh)
  chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
    if (
      changeInfo.title !== undefined ||
      changeInfo.url !== undefined ||
      changeInfo.favIconUrl !== undefined ||
      changeInfo.groupId !== undefined ||
      changeInfo.pinned !== undefined ||
      changeInfo.discarded !== undefined
    )
      scheduleDashboardRefresh()
  })
}

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(scheduleDashboardRefresh)
  chrome.tabGroups.onUpdated.addListener((group) => {
    if (groupColorChanged(group)) scheduleDashboardRefresh()
  })
  chrome.tabGroups.onRemoved.addListener(scheduleDashboardRefresh)
  chrome.tabGroups.onMoved.addListener(scheduleDashboardRefresh)
}

if (chrome.bookmarks) {
  chrome.bookmarks.onCreated.addListener(scheduleDashboardRefresh)
  chrome.bookmarks.onRemoved.addListener(scheduleDashboardRefresh)
  chrome.bookmarks.onChanged.addListener(scheduleDashboardRefresh)
  chrome.bookmarks.onMoved.addListener(scheduleDashboardRefresh)
  chrome.bookmarks.onChildrenReordered.addListener(scheduleDashboardRefresh)
  chrome.bookmarks.onImportEnded?.addListener(scheduleDashboardRefresh)
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    closeTabOutDupes()
    requestDashboardRefresh()
  }
})

document.addEventListener(
  'error',
  (e) => {
    const el = e.target
    if (el && el.tagName === 'IMG') el.style.display = 'none'
  },
  true
)

async function initializeApp() {
  mountToast()
  mountApp()

  if (document.visibilityState === 'visible') {
    closeTabOutDupes()
    requestDashboardRefresh()
  }
}

initializeApp()
