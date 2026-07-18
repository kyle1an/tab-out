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
import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from './dashboard-service-messages.js'
import { groupColorChanged } from './groups.js'
import {
  TAB_HISTORY_GET_MESSAGE,
  TAB_HISTORY_SWITCH_MESSAGE,
  createTabHistoryService
} from './background/tab-history-service.js'
import { createWorkingSetService } from './background/working-set-service.js'
import { createStartupSnapshotService } from './background/startup-snapshot-service.js'
import { WORKING_SET_DISMISS_MESSAGE, WORKING_SET_GET_MESSAGE } from './working-set.js'

const chromeApi = createChromeApi(chrome)
const tabHistoryService = createTabHistoryService(chromeApi)
const workingSetService = createWorkingSetService(chromeApi)
// Keep the cached dashboard startup snapshot warm so the next Tab Out open (even the first
// after a browser restart, before any page has run) paints populated instead of empty.
const startupSnapshotService = createStartupSnapshotService({
  getTabHistorySnapshot: () => tabHistoryService.getTabHistorySnapshot(),
  getWorkingSetActivity: () => workingSetService.getWorkingSetActivity()
})

function refreshBadge() {
  updateBadge(chromeApi)
}

function scheduleStartupSnapshotRefresh() {
  startupSnapshotService.scheduleRefresh()
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chromeApi.runtime.onInstalled.addListener(() => {
  refreshBadge()
  void startupSnapshotService.refreshNow()
})

// Update badge when Chrome starts up
chromeApi.runtime.onStartup.addListener(() => {
  refreshBadge()
  void startupSnapshotService.refreshNow()
})

// Update badge whenever a tab is opened
chromeApi.tabs.onCreated.addListener(() => {
  refreshBadge()
  scheduleStartupSnapshotRefresh()
})

// Track tab activation history so commands and close-redirect can
// follow the user's actual navigation path.
chromeApi.tabs.onActivated.addListener(({ tabId, windowId }) => {
  tabHistoryService.recordTabActivation(windowId, tabId)
  workingSetService.recordTabActivation(windowId, tabId)
  scheduleStartupSnapshotRefresh()
})

chromeApi.windows.onFocusChanged.addListener((windowId) => {
  tabHistoryService.recordFocusedWindowActiveTab(windowId)
  if (windowId != null && windowId !== chromeApi.windows.WINDOW_ID_NONE) {
    void (async () => {
      try {
        const tabs = await chromeApi.tabs.query({ windowId, active: true })
        const activeTab = tabs[0]
        if (typeof activeTab?.id === 'number') await workingSetService.recordTabActivation(windowId, activeTab.id)
      } catch {}
    })()
    scheduleStartupSnapshotRefresh()
  }
})

chromeApi.tabs.onMoved?.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabs.onAttached?.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabs.onDetached?.addListener(scheduleStartupSnapshotRefresh)

// Update badge whenever a tab is closed
chromeApi.tabs.onRemoved.addListener((tabId, removeInfo) => {
  refreshBadge()
  tabHistoryService.restorePreviousTabAfterClose(tabId, removeInfo)
  scheduleStartupSnapshotRefresh()
})

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  refreshBadge()
  workingSetService.recordTabNavigation(tabId, changeInfo, tab)
  if (
    changeInfo.title !== undefined ||
    changeInfo.url !== undefined ||
    changeInfo.favIconUrl !== undefined ||
    changeInfo.groupId !== undefined ||
    changeInfo.pinned !== undefined ||
    changeInfo.discarded !== undefined ||
    changeInfo.audible !== undefined ||
    changeInfo.mutedInfo !== undefined ||
    changeInfo.status !== undefined
  )
    scheduleStartupSnapshotRefresh()
})

chromeApi.tabGroups?.onCreated.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabGroups?.onUpdated.addListener((group) => {
  if (groupColorChanged(group)) scheduleStartupSnapshotRefresh()
})
chromeApi.tabGroups?.onRemoved.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabGroups?.onMoved.addListener(scheduleStartupSnapshotRefresh)

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
    void (async () => {
      try {
        const snapshot = await tabHistoryService.getTabHistorySnapshot()
        sendResponse({ ok: true, snapshot })
      } catch {
        sendResponse({ ok: false, snapshot: null })
      }
    })()
    return true
  }

  if (message?.type === TAB_HISTORY_SWITCH_MESSAGE) {
    const direction = message.direction === 1 ? 1 : -1
    void (async () => {
      try {
        await tabHistoryService.switchTabHistory(direction)
        const snapshot = await tabHistoryService.getTabHistorySnapshot()
        sendResponse({ ok: true, snapshot })
      } catch {
        sendResponse({ ok: false, snapshot: null })
      }
    })()
    return true
  }

  if (message?.type === WORKING_SET_GET_MESSAGE) {
    void (async () => {
      try {
        const snapshot = await workingSetService.getWorkingSetSnapshot()
        sendResponse({ ok: true, snapshot })
      } catch {
        sendResponse({ ok: false, snapshot: null })
      }
    })()
    return true
  }

  if (message?.type === DASHBOARD_SERVICE_STATE_GET_MESSAGE) {
    void (async () => {
      try {
        const workingSetActivity = await workingSetService.getWorkingSetActivity()
        const tabHistory = await tabHistoryService.getTabHistorySnapshot(workingSetActivity)
        sendResponse({ ok: true, tabHistory, workingSetActivity })
      } catch {
        sendResponse({ ok: false, tabHistory: null, workingSetActivity: null })
      }
    })()
    return true
  }

  if (message?.type === WORKING_SET_DISMISS_MESSAGE) {
    void (async () => {
      try {
        const snapshot = await workingSetService.dismissWorkingSetItem(String(message.key || message.url || ''))
        sendResponse({ ok: true, snapshot })
      } catch {
        sendResponse({ ok: false, snapshot: null })
      }
    })()
    return true
  }

  return false
})

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
refreshBadge()
