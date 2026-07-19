import {
  MAX_TAB_HISTORY,
  canonicalizeGlobalHistory,
  displayUrlForHistory,
  findHistoryTargetIndex,
  findTabForHistoryEntry,
  historyChanged,
  historyForBackgroundTabCreation,
  historyForUserActivation,
  normalizeGlobalHistory,
  pruneMissingHistoryEntries,
  removeTabEntriesFromHistory,
  repairHistoryCursorForActiveTab,
  type GlobalTabHistory,
  type GlobalTabHistoryInput
} from './tab-history-state.js'
import { normalizeWorkingSetActivity, pageIdentityForWorkingSet } from '../working-set.js'
import { WORKING_SET_ACTIVITY_KEY } from './working-set-service.js'
import { createChromeApi, type ChromeApi } from './chrome-api.js'
import { readChromeStorageValue, writeChromeStorageValueBestEffort } from './chrome-storage.js'
import { focusExistingTabTarget } from '../tab-focus.js'
import { isSuspended, unwrapSuspenderTitle, unwrapSuspenderUrl } from '../suspension.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from '../types'

const TAB_HISTORY_KEY = 'globalTabHistory'

export const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
export const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'

type FocusedWindowLookup = {
  id: number | null
  known: boolean
}
type ActiveTabLookup = {
  tab: chrome.tabs.Tab | null
  chromeFocused: boolean
}
type MutationResult<T> = {
  history?: GlobalTabHistoryInput
  value?: T
}
type FocusAction = {
  tab: chrome.tabs.Tab
  openerTabId?: number
}
export type TabHistoryService = {
  getTabHistorySnapshot: (activity?: WorkingSetActivityStore | null) => Promise<TabHistorySnapshot>
  recordFocusedWindowActiveTab: (windowId: number) => Promise<void>
  recordTabCreation: (tab: chrome.tabs.Tab) => Promise<void>
  recordTabActivation: (windowId: number, tabId: number) => Promise<void>
  removeTabFromHistory: (tabId: number) => Promise<void>
  restorePreviousTabAfterClose: (tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => Promise<void>
  switchTabHistory: (direction: number) => Promise<void>
}

function mapTabsById(tabs: chrome.tabs.Tab[]): Map<number, chrome.tabs.Tab> {
  return new Map(tabs.filter((tab) => typeof tab.id === 'number').map((tab) => [tab.id as number, tab]))
}

function mapWindowTypesById(windows: chrome.windows.Window[]): Map<number, string | undefined> {
  return new Map(windows.filter((win) => typeof win.id === 'number').map((win) => [win.id as number, win.type]))
}

function isStandaloneAppWindow(windowType?: string) {
  return windowType === 'app' || windowType === 'popup'
}

export function createTabHistoryService(chromeApi: ChromeApi = createChromeApi(chrome)): TabHistoryService {
  let tabHistoryCache: GlobalTabHistory | null = null
  let tabHistoryQueue: Promise<void> = Promise.resolve()

  function tabHistoryStorageArea(): chrome.storage.StorageArea | null {
    return chromeApi.storage?.local || chromeApi.storage?.session || null
  }

  async function readTabHistory(): Promise<GlobalTabHistory> {
    if (tabHistoryCache) return tabHistoryCache
    const storage = tabHistoryStorageArea()
    if (!storage) {
      tabHistoryCache = { stack: [], index: -1, pending: [] }
      return tabHistoryCache
    }

    let storedHistory: GlobalTabHistoryInput = null
    let migratedFromSession = false
    try {
      storedHistory = await readChromeStorageValue(storage, TAB_HISTORY_KEY) as GlobalTabHistoryInput

      if (storedHistory == null && storage === chromeApi.storage?.local && chromeApi.storage?.session) {
        storedHistory = await readChromeStorageValue(chromeApi.storage.session, TAB_HISTORY_KEY) as GlobalTabHistoryInput
        migratedFromSession = storedHistory != null
      }

      const canonical = canonicalizeGlobalHistory(storedHistory)
      tabHistoryCache = canonical.history
      if (canonical.changed || migratedFromSession) {
        await writeChromeStorageValueBestEffort(storage, TAB_HISTORY_KEY, tabHistoryCache)
      }
    } catch {
      tabHistoryCache = { stack: [], index: -1, pending: [] }
    }
    return tabHistoryCache
  }

  async function writeTabHistory(nextHistory: GlobalTabHistoryInput): Promise<void> {
    const cleanHistory = canonicalizeGlobalHistory(nextHistory).history
    tabHistoryCache = cleanHistory
    const storage = tabHistoryStorageArea()
    if (!storage) return
    await writeChromeStorageValueBestEffort(storage, TAB_HISTORY_KEY, cleanHistory)
  }

  async function readActivityTimestamps(): Promise<Map<string, number>> {
    const storage = tabHistoryStorageArea()
    if (!storage) return new Map()
    try {
      const stored = await readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
      const activity = normalizeWorkingSetActivity(stored as Parameters<typeof normalizeWorkingSetActivity>[0])
      const map = new Map<string, number>()
      for (const [key, record] of Object.entries(activity.records)) {
        const ts = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
        if (ts > 0) map.set(key, ts)
      }
      return map
    } catch {
      return new Map()
    }
  }

  function activityTimestampsFromStore(activity: WorkingSetActivityStore | null | undefined): Map<string, number> {
    const normalized = normalizeWorkingSetActivity(activity)
    const map = new Map<string, number>()
    for (const [key, record] of Object.entries(normalized.records)) {
      const ts = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
      if (ts > 0) map.set(key, ts)
    }
    return map
  }

  function enqueueTabHistoryMutation<T>(mutator: (history: GlobalTabHistory) => MutationResult<T> | void | Promise<MutationResult<T> | void>) {
    const task = tabHistoryQueue.catch(() => {}).then(async () => {
      const before = canonicalizeGlobalHistory(await readTabHistory()).history
      const result = (await mutator(before)) || {}
      const requestedHistory = result.history || before
      const cleanHistory = canonicalizeGlobalHistory(requestedHistory).history
      const changed = historyChanged(before, cleanHistory)
      if (changed) await writeTabHistory(cleanHistory)
      return {
        history: cleanHistory,
        changed,
        value: result.value
      }
    })

    tabHistoryQueue = task.then(
      () => {},
      () => {}
    )
    return task
  }

  async function recordTabActivation(windowId: number, tabId: number): Promise<void> {
    if (typeof windowId !== 'number' || typeof tabId !== 'number') return

    await enqueueTabHistoryMutation(async (history) => {
      await primeNativeCloseTarget(windowId, tabId, history)
      return {
        history: historyForUserActivation(history, { windowId, tabId }).history
      }
    })
  }

  async function recordTabCreation(tab: chrome.tabs.Tab): Promise<void> {
    const tabId = tab.id
    const windowId = tab.windowId
    if (
      tab.active ||
      typeof tabId !== 'number' ||
      typeof windowId !== 'number' ||
      typeof tab.openerTabId !== 'number'
    ) {
      return
    }

    await enqueueTabHistoryMutation((history) => ({
      history: historyForBackgroundTabCreation(history, {
        windowId,
        tabId,
        createdAt: Date.now()
      }).history
    }))
  }

  async function findFocusedWindowId(): Promise<FocusedWindowLookup> {
    try {
      const windows = await chromeApi.windows.getAll()
      const focusedWindow = windows.find((win) => win.focused && typeof win.id === 'number')
      return { id: focusedWindow?.id ?? null, known: true }
    } catch {
      return { id: null, known: false }
    }
  }

  async function findLastFocusedActiveTab(): Promise<chrome.tabs.Tab | null> {
    try {
      const focusedTabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true })
      return focusedTabs[0] || null
    } catch {
      return null
    }
  }

  async function findActiveTabForHistory(tabs: chrome.tabs.Tab[], history: GlobalTabHistoryInput): Promise<ActiveTabLookup> {
    const focusedWindow = await findFocusedWindowId()
    if (focusedWindow.id != null) {
      const focusedActiveTab = tabs.find((tab) => tab.windowId === focusedWindow.id && tab.active)
      if (focusedActiveTab) return { tab: focusedActiveTab, chromeFocused: true }
    }

    const tabsById = mapTabsById(tabs)
    const historyTab = findTabForHistoryEntry(history, tabsById)
    const lastFocusedTab = await findLastFocusedActiveTab()
    const fallbackTab = focusedWindow.known
      ? historyTab || lastFocusedTab || tabs.find((tab) => tab.active) || null
      : lastFocusedTab || historyTab || tabs.find((tab) => tab.active) || null
    return { tab: fallbackTab, chromeFocused: !focusedWindow.known || focusedWindow.id != null }
  }

  async function focusExistingTab(tab: chrome.tabs.Tab | null): Promise<boolean> {
    if (typeof tab?.id !== 'number') return false

    const focused = await focusExistingTabTarget({
      tabId: tab.id,
      windowId: tab.windowId,
      url: unwrapSuspenderUrl(tab.url || ''),
      rawUrl: tab.url || ''
    })
    if (!focused) {
      await removeTabFromHistory(tab.id)
    }
    return focused
  }

  async function findPreviousSurvivingTabInWindow(
    history: GlobalTabHistoryInput,
    windowId: number,
    tabId: number
  ): Promise<{ currentTab: chrome.tabs.Tab; targetTab: chrome.tabs.Tab } | null> {
    const current = normalizeGlobalHistory(history)
    let tabsInWindow: chrome.tabs.Tab[] = []
    try {
      tabsInWindow = await chromeApi.tabs.query({ windowId })
    } catch {
      return null
    }

    const tabsById = mapTabsById(tabsInWindow)
    const currentTab = tabsById.get(tabId)
    if (!currentTab) return null

    for (let i = current.index; i >= 0; i--) {
      const entry = current.stack[i]
      if (entry.windowId !== windowId) continue
      if (entry.tabId === tabId) continue
      const targetTab = tabsById.get(entry.tabId)
      if (targetTab) return { currentTab, targetTab }
    }

    return null
  }

  async function primeNativeCloseTarget(windowId: number, tabId: number, history: GlobalTabHistoryInput): Promise<void> {
    const match = await findPreviousSurvivingTabInWindow(history, windowId, tabId)
    if (!match) return

    const { currentTab, targetTab } = match
    if (currentTab.openerTabId === targetTab.id) return

    try {
      await chromeApi.tabs.update(tabId, { openerTabId: targetTab.id })
    } catch {
      // Some browser-managed tabs reject opener changes; the onRemoved
      // restore path below remains the fallback.
    }
  }

  async function recordFocusedWindowActiveTab(windowId: number): Promise<void> {
    if (windowId == null || windowId === chromeApi.windows.WINDOW_ID_NONE) return
    try {
      const tabs = await chromeApi.tabs.query({ windowId, active: true })
      const activeTab = tabs[0]
      if (!activeTab?.id) return
      await recordTabActivation(windowId, activeTab.id)
    } catch {
      // Window may have closed or be unavailable; ignore.
    }
  }

  async function removeTabFromHistory(tabId: number): Promise<void> {
    await enqueueTabHistoryMutation((history) => ({
      history: removeTabEntriesFromHistory(history, tabId)
    }))
  }

  async function restorePreviousTabAfterClose(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo): Promise<void> {
    if (!removeInfo) return

    const { value: restoreAction } = await enqueueTabHistoryMutation<{ targetId: number } | null>(async (history) => {
      const nextHistory = removeTabEntriesFromHistory(history, tabId)
      if (removeInfo.isWindowClosing) return { history: nextHistory }

      const currentEntry = history.stack[history.index]
      if (!currentEntry || currentEntry.tabId !== tabId || currentEntry.windowId !== removeInfo.windowId) {
        return { history: nextHistory }
      }

      let tabsInWindow: chrome.tabs.Tab[] = []
      try {
        tabsInWindow = await chromeApi.tabs.query({ windowId: removeInfo.windowId })
      } catch {
        return { history: nextHistory }
      }

      const existingIds = new Set(tabsInWindow.map((tab) => tab.id).filter((id): id is number => typeof id === 'number'))
      let targetOldIndex = -1
      for (let i = history.index - 1; i >= 0; i--) {
        const entry = history.stack[i]
        if (entry.windowId !== removeInfo.windowId) continue
        if (!existingIds.has(entry.tabId)) continue
        targetOldIndex = i
        break
      }

      if (targetOldIndex === -1) return { history: nextHistory }

      const targetId = history.stack[targetOldIndex].tabId
      let targetNewIndex = -1
      for (let i = Math.min(targetOldIndex, nextHistory.stack.length - 1); i >= 0; i--) {
        if (nextHistory.stack[i].tabId === targetId && nextHistory.stack[i].windowId === removeInfo.windowId) {
          targetNewIndex = i
          break
        }
      }

      if (targetNewIndex === -1) return { history: nextHistory }

      const finalHistory = {
        stack: nextHistory.stack,
        index: targetNewIndex,
        pending: nextHistory.pending
      }
      const activeTab = tabsInWindow.find((tab) => tab.active)
      return {
        history: finalHistory,
        value: activeTab?.id === targetId ? null : { targetId }
      }
    })

    if (!restoreAction?.targetId) return
    const focused = await focusExistingTabTarget({ tabId: restoreAction.targetId })
    if (!focused) {
      await removeTabFromHistory(restoreAction.targetId)
    }
  }

  async function switchTabHistory(direction: number): Promise<void> {
    const { value: focusAction } = await enqueueTabHistoryMutation<FocusAction>(async (history) => {
      const tabs = await chromeApi.tabs.query({})
      const { tab: activeTab, chromeFocused } = await findActiveTabForHistory(tabs, history)
      if (typeof activeTab?.id !== 'number') return { history }

      if (!chromeFocused) {
        return {
          history,
          value: { tab: activeTab }
        }
      }

      if (history.stack.length === 0) {
        return {
          history: {
            stack: [{ windowId: activeTab.windowId, tabId: activeTab.id }],
            index: 0,
            pending: history.pending
          }
        }
      }

      const repaired = repairHistoryCursorForActiveTab(history, activeTab)
      const existingTabs = mapTabsById(tabs)
      const navigationHistory = canonicalizeGlobalHistory(
        pruneMissingHistoryEntries(repaired.history, existingTabs)
      ).history
      const nextIndex = findHistoryTargetIndex(navigationHistory, direction, existingTabs, activeTab)
      if (nextIndex === -1) {
        if (direction <= 0) return { history: navigationHistory }

        const pendingTarget = navigationHistory.pending.find((entry) => (
          entry.tabId !== activeTab.id &&
          existingTabs.has(entry.tabId)
        ))
        if (!pendingTarget) return { history: navigationHistory }

        const targetTab = existingTabs.get(pendingTarget.tabId)
        if (typeof targetTab?.id !== 'number') return { history: navigationHistory }

        return {
          history: historyForUserActivation(navigationHistory, {
            windowId: targetTab.windowId,
            tabId: targetTab.id
          }).history,
          value: {
            tab: targetTab,
            openerTabId: activeTab.id
          }
        }
      }

      const targetEntry = navigationHistory.stack[nextIndex]
      if (!targetEntry) return { history: navigationHistory }
      const targetTab = existingTabs.get(targetEntry.tabId)
      if (typeof targetTab?.id !== 'number') return { history: navigationHistory }
      const targetTabId = targetTab.id

      return {
        history: {
          stack: navigationHistory.stack.map((entry, entryIndex) => (entryIndex === nextIndex ? { windowId: targetTab.windowId, tabId: targetTabId } : entry)),
          index: nextIndex,
          pending: navigationHistory.pending
        },
        value: {
          tab: targetTab,
          openerTabId: activeTab.id
        }
      }
    })

    if (!focusAction?.tab) return
    if (focusAction.openerTabId && typeof focusAction.tab.id === 'number') {
      try {
        await chromeApi.tabs.update(focusAction.tab.id, { openerTabId: focusAction.openerTabId })
      } catch {}
    }

    await focusExistingTab(focusAction.tab)
  }

  async function getTabHistorySnapshot(activity?: WorkingSetActivityStore | null): Promise<TabHistorySnapshot> {
    const { value: snapshot } = await enqueueTabHistoryMutation(async (storedHistory) => {
      const tabs = await chromeApi.tabs.query({})
      let windowTypeById = new Map<number, string | undefined>()
      try {
        windowTypeById = mapWindowTypesById(await chromeApi.windows.getAll())
      } catch {}
      const { tab: activeTab } = await findActiveTabForHistory(tabs, storedHistory)
      const existingTabs = mapTabsById(tabs)
      const repairedHistory = repairHistoryCursorForActiveTab(storedHistory, activeTab)
      const prunedHistory = pruneMissingHistoryEntries(repairedHistory.history, existingTabs)
      const cleanHistory = canonicalizeGlobalHistory(prunedHistory).history
      const previousIndex = findHistoryTargetIndex(cleanHistory, -1, existingTabs, activeTab)
      const stackNextIndex = findHistoryTargetIndex(cleanHistory, 1, existingTabs, activeTab)
      const nextIndex = stackNextIndex === -1 && cleanHistory.pending.length > 0
        ? cleanHistory.stack.length
        : stackNextIndex
      const activityTimestamps = activity ? activityTimestampsFromStore(activity) : await readActivityTimestamps()
      const indexedEntries = [
        ...cleanHistory.stack.map((entry, index) => ({
          entry,
          index,
          pending: false,
          createdAt: null
        })),
        ...cleanHistory.pending.map((entry, pendingIndex) => ({
          entry,
          index: cleanHistory.stack.length + pendingIndex,
          pending: true,
          createdAt: entry.createdAt
        }))
      ]

      return {
        history: cleanHistory,
        value: {
          stackSize: cleanHistory.stack.length,
          pendingSize: cleanHistory.pending.length,
          maxSize: MAX_TAB_HISTORY,
          cursorIndex: cleanHistory.index,
          currentIndex: cleanHistory.index,
          previousIndex,
          nextIndex,
          activeTabId: activeTab?.id ?? null,
          activeWindowId: activeTab?.windowId ?? null,
          activeWasInserted: repairedHistory.activeWasInserted,
          entries: indexedEntries.map(({ entry, index, pending, createdAt }) => {
            const tab = existingTabs.get(entry.tabId)
            const rawUrl = tab?.url || ''
            const url = unwrapSuspenderUrl(rawUrl)
            const suspended = isSuspended(rawUrl, url)
            const displayUrl = displayUrlForHistory(url)
            const cleanTitle = (tab?.title || '').replace(/\u200e/g, '').trim()
            const title = unwrapSuspenderTitle(rawUrl) || (cleanTitle ? cleanTitle : displayUrl)
            const activityKey = pageIdentityForWorkingSet(url)
            return {
              index,
              tabId: entry.tabId,
              windowId: entry.windowId,
              exists: !!tab,
              active: tab?.id === activeTab?.id,
              activeInOtherWindow: !!(tab?.active && activeTab && tab.windowId !== activeTab.windowId),
              isApp: isStandaloneAppWindow(tab ? windowTypeById.get(tab.windowId) : undefined),
              pinned: !!tab?.pinned,
              discarded: !!tab?.discarded,
              suspended,
              loading: !!tab && !suspended && tab.status === 'loading',
              audible: !!tab?.audible,
              muted: !!tab?.mutedInfo?.muted,
              pending,
              createdAt,
              cursor: index === cleanHistory.index,
              current: index === cleanHistory.index,
              previousTarget: index === previousIndex,
              nextTarget: index === nextIndex,
              title: title || `Tab ${entry.tabId}`,
              url,
              rawUrl,
              displayUrl,
              favIconUrl: tab?.favIconUrl || '',
              lastActivatedAt: activityKey ? activityTimestamps.get(activityKey) ?? null : null
            }
          })
        }
      }
    })

    return snapshot as TabHistorySnapshot
  }

  return {
    getTabHistorySnapshot,
    recordFocusedWindowActiveTab,
    recordTabCreation,
    recordTabActivation,
    removeTabFromHistory,
    restorePreviousTabAfterClose,
    switchTabHistory
  }
}
