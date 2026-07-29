/**
 * background.ts — Service worker for toolbar dedupe, commands, and tab history
 *
 * Chrome's event-driven background service worker for Tab Out.
 * It keeps the toolbar dedupe action current, handles extension commands, and
 * maintains the activation history used by tab switching / close restore.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts duplicate tabs that the global dedupe policy can close.
 *
 * Color coding gives a quick at-a-glance cleanup signal:
 *   Green  (#3d7a4a) → 1–10 duplicate extras
 *   Amber  (#b8892e) → 11–20 duplicate extras
 *   Red    (#b35a5a) → 21+ duplicate extras
 */

import { createBadgeRefreshService } from './background/badge.js'
import { settleBackgroundTask } from './background/background-task.js'
import { OPEN_FILTER_TAB_COMMAND, openFilterTab } from './background/filter-command.js'
import { OPEN_NEW_TAB_COMMAND, openNewTab } from './background/new-tab-command.js'
import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from './dashboard-service-messages.js'
import type { CapturedDashboardServiceState } from './dashboard-service-messages.js'
import { CLOSED_TAB_RESTORE_STATE_MESSAGE } from './closed-tabs.js'
import { buildOpenTabDedupePlan } from './open-tab-dedupe-plan.js'
import { closeDuplicateTabsResult } from './tabs.js'
import { groupColorChanged } from './groups.js'
import {
  TAB_HISTORY_GET_MESSAGE,
  TAB_HISTORY_SWITCH_MESSAGE,
  createTabHistoryService
} from './background/tab-history-service.js'
import { createWorkingSetService } from './background/working-set-service.js'
import { STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM, createStartupSnapshotService, startupSnapshotStorageChangesRequireRefresh } from './background/startup-snapshot-service.js'

const chromeApi = chrome
const badgeRefreshService = createBadgeRefreshService(chromeApi)
const tabHistoryService = createTabHistoryService(chromeApi)
const workingSetService = createWorkingSetService(chromeApi)

async function captureDashboardServiceState(): Promise<CapturedDashboardServiceState> {
  const workingSetActivity = await workingSetService.getWorkingSetActivity()
  const { tabHistory, openTabsSnapshot } = await tabHistoryService.getTabHistorySnapshotCapture(workingSetActivity)
  return { tabHistory, workingSetActivity, openTabsSnapshot }
}

// Keep the cached dashboard startup snapshot warm so the next Tab Out open (even the first
// after a browser restart, before any page has run) paints populated instead of empty.
const startupSnapshotService = createStartupSnapshotService({
  alarms: chromeApi.alarms,
  getDashboardServiceState: captureDashboardServiceState
})

function refreshBadge() {
  void badgeRefreshService.refresh()
}

function scheduleStartupSnapshotRefresh() {
  startupSnapshotService.scheduleRefresh()
}

async function captureTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chromeApi.tabs.get(tabId)
  } catch {
    return null
  }
}

async function captureActiveTab(windowId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return (await chromeApi.tabs.query({ windowId, active: true }))[0] ?? null
  } catch {
    return null
  }
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
  return settleBackgroundTask(async () => {
    await tabHistoryService.resetForBrowserStartup()
    await startupSnapshotService.refreshNow()
  })
})

// Track eligible background link tabs as pending history targets and update
// the dashboard whenever any tab is opened.
chromeApi.tabs.onCreated.addListener((tab) => {
  refreshBadge()
  void settleBackgroundTask(() => tabHistoryService.recordTabCreation(tab))
  scheduleStartupSnapshotRefresh()
})

// Track tab activation history so commands and close-redirect can
// follow the user's actual navigation path.
chromeApi.tabs.onActivated.addListener(({ tabId, windowId }) => {
  refreshBadge()
  const capturedTab = captureTab(tabId)
  void settleBackgroundTask(() => Promise.all([
    tabHistoryService.recordTabActivation(windowId, tabId, capturedTab),
    workingSetService.recordTabActivation(windowId, tabId, capturedTab)
  ]))
  scheduleStartupSnapshotRefresh()
})

chromeApi.windows.onFocusChanged.addListener((windowId) => {
  refreshBadge()
  if (windowId != null && windowId !== chromeApi.windows.WINDOW_ID_NONE) {
    const capturedActiveTab = captureActiveTab(windowId)
    void settleBackgroundTask(() => Promise.all([
      tabHistoryService.recordFocusedWindowActiveTab(windowId, capturedActiveTab),
      workingSetService.recordFocusedWindowActiveTab(windowId, capturedActiveTab)
    ]))
    scheduleStartupSnapshotRefresh()
  }
})

chromeApi.tabs.onMoved.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabs.onAttached.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabs.onDetached.addListener(scheduleStartupSnapshotRefresh)

chromeApi.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  refreshBadge()
  return settleBackgroundTask(async () => {
    await Promise.all([
      tabHistoryService.replaceTabId(addedTabId, removedTabId),
      workingSetService.replaceTabId(addedTabId, removedTabId)
    ])
    startupSnapshotService.scheduleRefresh()
  })
})

// Update badge whenever a tab is closed
chromeApi.tabs.onRemoved.addListener((tabId, removeInfo) => {
  refreshBadge()
  void settleBackgroundTask(() => tabHistoryService.restorePreviousTabAfterClose(tabId, removeInfo))
  scheduleStartupSnapshotRefresh()
})

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.url !== undefined ||
    changeInfo.groupId !== undefined ||
    changeInfo.pinned !== undefined
  ) refreshBadge()
  void settleBackgroundTask(() => Promise.all([
    tabHistoryService.recordTabNavigation(tabId, changeInfo, tab),
    workingSetService.recordTabNavigation(tabId, changeInfo, tab)
  ]))
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

chromeApi.tabGroups.onCreated.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabGroups.onUpdated.addListener((group) => {
  if (groupColorChanged(group)) scheduleStartupSnapshotRefresh()
})
chromeApi.tabGroups.onRemoved.addListener(scheduleStartupSnapshotRefresh)
chromeApi.tabGroups.onMoved.addListener(scheduleStartupSnapshotRefresh)

chromeApi.sessions.onChanged.addListener(() => {
  startupSnapshotService.sessionsChanged()
})

chromeApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM) return
  void settleBackgroundTask(() => startupSnapshotService.promoteDurableCheckpoint())
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (startupSnapshotStorageChangesRequireRefresh(changes, areaName)) {
    void startupSnapshotService.refreshNow()
  }
})

chromeApi.commands.onCommand.addListener((command) => {
  if (command === 'switch-to-last-tab') {
    return settleBackgroundTask(() => tabHistoryService.switchTabHistory(-1))
  } else if (command === 'switch-to-next-tab') {
    return settleBackgroundTask(() => tabHistoryService.switchTabHistory(1))
  } else if (command === OPEN_FILTER_TAB_COMMAND) {
    return settleBackgroundTask(() => openFilterTab(chromeApi))
  } else if (command === OPEN_NEW_TAB_COMMAND) {
    return settleBackgroundTask(() => openNewTab(chromeApi))
  }
  return undefined
})

chromeApi.action.onClicked.addListener((tab) => {
  return settleBackgroundTask(async () => {
    let tabs: chrome.tabs.Tab[]
    try {
      tabs = await chromeApi.tabs.query({})
    } catch {
      await badgeRefreshService.refresh()
      return
    }

    const plan = buildOpenTabDedupePlan(tabs, tab.windowId)
    if (plan.urls.length > 0) {
      await closeDuplicateTabsResult(plan.urls, true, {
        currentWindowId: tab.windowId,
        preservePinnedTabOut: true
      })
    }
    await badgeRefreshService.refresh()
  })
})

chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type === CLOSED_TAB_RESTORE_STATE_MESSAGE &&
    typeof message.restoreId === 'string' &&
    message.restoreId
  ) {
    if (message.phase === 'started') {
      startupSnapshotService.sessionRestoreStarted(message.restoreId)
    } else if (message.phase === 'settled') {
      startupSnapshotService.sessionRestoreSettled(message.restoreId)
    } else {
      sendResponse({ ok: false })
      return true
    }
    sendResponse({ ok: true })
    return true
  }

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

  if (message?.type === DASHBOARD_SERVICE_STATE_GET_MESSAGE) {
    void (async () => {
      try {
        const { tabHistory, workingSetActivity, openTabsSnapshot } = await captureDashboardServiceState()
        sendResponse({ ok: true, tabHistory, workingSetActivity, openTabsSnapshot })
      } catch {
        sendResponse({ ok: false, tabHistory: null, workingSetActivity: null, openTabsSnapshot: null })
      }
    })()
    return true
  }

  return false
})

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
refreshBadge()
