/**
 * background.ts — Service worker for badge, commands, and tab history
 *
 * Chrome's "always-on" background script for Tab Out.
 * It keeps the toolbar badge current, handles extension commands, and
 * maintains the activation history used by tab switching / close restore.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

import { updateBadge } from './background/badge.js'
import { createChromeApi } from './background/chrome-api.js'
import { OPEN_FILTER_TAB_COMMAND, openFilterTab } from './background/filter-command.js'
import { OPEN_NEW_TAB_COMMAND, openNewTab } from './background/new-tab-command.js'
import {
  TAB_HISTORY_GET_MESSAGE,
  TAB_HISTORY_SWITCH_MESSAGE,
  createTabHistoryService
} from './background/tab-history-service.js'
import { createWorkingSetService } from './background/working-set-service.js'
import { WORKING_SET_DISMISS_MESSAGE, WORKING_SET_GET_MESSAGE } from './working-set.js'

const chromeApi = createChromeApi(chrome)
const tabHistoryService = createTabHistoryService(chromeApi)
const workingSetService = createWorkingSetService(chromeApi)

function refreshBadge() {
  updateBadge(chromeApi)
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chromeApi.runtime.onInstalled.addListener(() => {
  refreshBadge()
})

// Update badge when Chrome starts up
chromeApi.runtime.onStartup.addListener(() => {
  refreshBadge()
})

// Update badge whenever a tab is opened
chromeApi.tabs.onCreated.addListener(() => {
  refreshBadge()
})

// Track tab activation history so commands and close-redirect can
// follow the user's actual navigation path.
chromeApi.tabs.onActivated.addListener(({ tabId, windowId }) => {
  tabHistoryService.recordTabActivation(windowId, tabId)
  workingSetService.recordTabActivation(windowId, tabId)
})

chromeApi.windows.onFocusChanged.addListener((windowId) => {
  tabHistoryService.recordFocusedWindowActiveTab(windowId)
  if (windowId != null && windowId !== chromeApi.windows.WINDOW_ID_NONE) {
    chromeApi.tabs.query({ windowId, active: true })
      .then((tabs) => {
        const activeTab = tabs[0]
        if (typeof activeTab?.id === 'number') workingSetService.recordTabActivation(windowId, activeTab.id)
      })
      .catch(() => {})
  }
})

// Update badge whenever a tab is closed
chromeApi.tabs.onRemoved.addListener((tabId, removeInfo) => {
  refreshBadge()
  tabHistoryService.restorePreviousTabAfterClose(tabId, removeInfo)
})

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  refreshBadge()
  workingSetService.recordTabNavigation(tabId, changeInfo, tab)
})

chromeApi.commands?.onCommand.addListener((command) => {
  if (command === 'switch-to-last-tab') {
    tabHistoryService.switchTabHistory(-1)
  } else if (command === 'switch-to-next-tab') {
    tabHistoryService.switchTabHistory(1)
  } else if (command === OPEN_FILTER_TAB_COMMAND) {
    openFilterTab(chromeApi)
  } else if (command === OPEN_NEW_TAB_COMMAND) {
    openNewTab(chromeApi)
  }
})

chromeApi.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
  if (message?.type === TAB_HISTORY_GET_MESSAGE) {
    tabHistoryService.getTabHistorySnapshot()
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch(() => sendResponse({ ok: false, snapshot: null }))
    return true
  }

  if (message?.type === TAB_HISTORY_SWITCH_MESSAGE) {
    const direction = message.direction === 1 ? 1 : -1
    tabHistoryService.switchTabHistory(direction)
      .then(() => tabHistoryService.getTabHistorySnapshot())
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch(() => sendResponse({ ok: false, snapshot: null }))
    return true
  }

  if (message?.type === WORKING_SET_GET_MESSAGE) {
    workingSetService.getWorkingSetSnapshot()
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch(() => sendResponse({ ok: false, snapshot: null }))
    return true
  }

  if (message?.type === WORKING_SET_DISMISS_MESSAGE) {
    workingSetService.dismissWorkingSetItem(String(message.key || message.url || ''))
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch(() => sendResponse({ ok: false, snapshot: null }))
    return true
  }

  return false
})

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
refreshBadge()
