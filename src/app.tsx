import { Data, Effect, Fiber, Result } from 'effect'

import './styles/app.css'
import { attachApp } from './components/App'
import { applyAppStartup } from './app-startup.js'
import { requestDashboardRefresh, settleDashboardRefresh, type DashboardRefreshOptions } from './extension/dashboard-intake.js'
import { createDashboardPageRefreshScheduler } from './extension/dashboard-page-refresh.js'
import { groupColorChanged } from './extension/groups.js'
import { loadDashboardLocalState } from './extension/dashboard-local-state.js'
import { loadCachedDashboardStartup } from './extension/startup-snapshot.js'
import { loadHistoryRangePreference } from './extension/history-range.js'
import { addCurrentTabOutPageToStartupSnapshot } from './extension/startup-view-model.js'
import { seedOpenTabsTitleHistory } from './extension/tabs.js'
import { SAVED_PAGES_STORAGE_KEY } from './extension/saved-pages.js'
import { isTabOutDashboardUrl, isTabOutPageUrl } from './extension/tab-out-url.js'
import { STARTUP_ORDER_DEBUG_CAPTURE, recordStartupTiming, startupDebugNow } from './components/startup-order-debug'

class AppStartupReadError extends Data.TaggedError('AppStartupReadError')<{
  readonly cause: unknown
  readonly operation: 'cache' | 'current-tab' | 'history-range' | 'local-state'
}> {}

recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'app-module-evaluated')

const readCurrentTabOutPageForStartup = Effect.fn('app.readCurrentTabOutPageForStartup')(function*() {
  const tabResult = yield* Effect.result(Effect.tryPromise({
    try: () => chrome.tabs.getCurrent(),
    catch: (cause) => new AppStartupReadError({ cause, operation: 'current-tab' })
  }))
  if (Result.isFailure(tabResult)) return null
  const tab = tabResult.success
  if (!tab) return null
  const rawUrl = tab.url || window.location.href
  if (!isTabOutPageUrl(rawUrl)) return null
  return { ...tab, url: rawUrl }
})

const dashboardPageRefreshScheduler = createDashboardPageRefreshScheduler({
  isVisible: () => document.visibilityState === 'visible',
  refresh: (options) => {
    void settleDashboardRefresh(requestDashboardRefresh(options))
  }
})

function scheduleDashboardRefresh(options: DashboardRefreshOptions = {}) {
  dashboardPageRefreshScheduler.schedule(options)
}

function scheduleAnimatedDashboardRefresh() {
  scheduleDashboardRefresh({ animateCards: true })
}

function schedulePassiveDashboardRefresh() {
  scheduleDashboardRefresh()
}

chrome.tabs.onCreated.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onActivated.addListener(schedulePassiveDashboardRefresh)
chrome.tabs.onRemoved.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onMoved.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onAttached.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onDetached.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onReplaced.addListener(scheduleAnimatedDashboardRefresh)
chrome.tabs.onUpdated.addListener((_id, changeInfo) => {
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
    scheduleDashboardRefresh({
      animateCards:
        (changeInfo.url !== undefined && !isTabOutDashboardUrl(changeInfo.url)) ||
        changeInfo.groupId !== undefined ||
        changeInfo.pinned !== undefined ||
        changeInfo.discarded !== undefined
    })
})

chrome.windows.onFocusChanged.addListener(schedulePassiveDashboardRefresh)

chrome.tabGroups.onCreated.addListener(schedulePassiveDashboardRefresh)
chrome.tabGroups.onUpdated.addListener((group) => {
  if (groupColorChanged(group)) scheduleDashboardRefresh()
})
chrome.tabGroups.onRemoved.addListener(schedulePassiveDashboardRefresh)
chrome.tabGroups.onMoved.addListener(schedulePassiveDashboardRefresh)

chrome.bookmarks.onCreated.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onRemoved.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onChanged.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onMoved.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onChildrenReordered.addListener(schedulePassiveDashboardRefresh)
chrome.bookmarks.onImportEnded.addListener(schedulePassiveDashboardRefresh)

chrome.history.onVisited.addListener(schedulePassiveDashboardRefresh)
chrome.history.onVisitRemoved.addListener(schedulePassiveDashboardRefresh)

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && Object.hasOwn(changes, SAVED_PAGES_STORAGE_KEY)) {
    scheduleAnimatedDashboardRefresh()
  }
})

document.addEventListener('visibilitychange', () => {
  dashboardPageRefreshScheduler.visibilityChanged()
})

recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'attach-app')
attachApp()

const runInitializeApp = Effect.fn('app.initialize')(function*() {
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'initialize-start')
  const historyRangeFiber = yield* Effect.tryPromise({
    try: () => loadHistoryRangePreference(),
    catch: (cause) => new AppStartupReadError({ cause, operation: 'history-range' })
  }).pipe(Effect.forkChild({ startImmediately: true }))
  const cacheStartedAt = startupDebugNow()
  const cachedStartup = yield* Effect.tryPromise({
    try: () => loadCachedDashboardStartup(),
    catch: (cause) => new AppStartupReadError({ cause, operation: 'cache' })
  })
  seedOpenTabsTitleHistory(cachedStartup?.snapshot.dashboard.realTabs ?? [])
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'startup-cache-loaded', {
    startedAt: cacheStartedAt,
    detail: {
      localStateHit: !!cachedStartup?.localState,
      snapshotHit: !!cachedStartup?.snapshot
    }
  })
  const cachedStartupSnapshot = cachedStartup?.snapshot ?? null
  const currentTabOutPageFiber = cachedStartupSnapshot
    ? yield* readCurrentTabOutPageForStartup().pipe(Effect.forkChild({ startImmediately: true }))
    : null
  const localStateStartedAt = startupDebugNow()
  const localState = cachedStartup?.localState ?? (yield* Effect.tryPromise({
    try: () => loadDashboardLocalState(),
    catch: (cause) => new AppStartupReadError({ cause, operation: 'local-state' })
  }))
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'local-state-ready', {
    ...(cachedStartup?.localState ? {} : { startedAt: localStateStartedAt }),
    detail: { source: cachedStartup?.localState ? 'startup-cache' : 'chrome-storage' }
  })
  const historyRange = yield* Fiber.join(historyRangeFiber)
  const currentTabOutPage = currentTabOutPageFiber
    ? yield* Fiber.join(currentTabOutPageFiber)
    : null
  const fallbackStartupSnapshot = cachedStartupSnapshot && currentTabOutPage
    ? addCurrentTabOutPageToStartupSnapshot(cachedStartupSnapshot, currentTabOutPage, localState)
    : cachedStartupSnapshot
  const startupSnapshot = fallbackStartupSnapshot
  recordStartupTiming(STARTUP_ORDER_DEBUG_CAPTURE, 'startup-update-ready', {
    detail: {
      localStateReady: !!localState,
      startupSnapshot: !!startupSnapshot
    }
  })
  applyAppStartup({ historyRange, localState, snapshot: startupSnapshot })
})

void Effect.runPromise(runInitializeApp().pipe(
  Effect.catchTag('AppStartupReadError', (error) => Effect.fail(error.cause))
))
