import {
  MAX_TAB_HISTORY,
  canonicalizeGlobalHistory,
  displayUrlForHistory,
  findHistoryTargetIndex,
  findTabForHistoryEntry,
  historyChanged,
  historyForUserActivation,
  normalizeGlobalHistory,
  pruneMissingHistoryEntries,
  removeTabEntriesFromHistory,
  repairHistoryCursorForActiveTab
} from './tab-history-state.js'

const TAB_HISTORY_KEY = 'globalTabHistory'

export const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
export const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'

export function createTabHistoryService(chromeApi = chrome) {
  let tabHistoryCache = null
  let tabHistoryQueue = Promise.resolve()

  function tabHistoryStorageArea() {
    return chromeApi.storage?.local || chromeApi.storage?.session || null
  }

  async function readTabHistory() {
    if (tabHistoryCache) return tabHistoryCache
    const storage = tabHistoryStorageArea()
    if (!storage) {
      tabHistoryCache = { stack: [], index: -1 }
      return tabHistoryCache
    }

    let storedHistory = null
    let migratedFromSession = false
    try {
      const stored = await storage.get(TAB_HISTORY_KEY)
      storedHistory = stored[TAB_HISTORY_KEY]

      if (storedHistory == null && storage === chromeApi.storage?.local && chromeApi.storage?.session) {
        const sessionStored = await chromeApi.storage.session.get(TAB_HISTORY_KEY)
        storedHistory = sessionStored[TAB_HISTORY_KEY]
        migratedFromSession = storedHistory != null
      }

      const canonical = canonicalizeGlobalHistory(storedHistory)
      tabHistoryCache = canonical.history
      if (canonical.changed || migratedFromSession) {
        try {
          await storage.set({ [TAB_HISTORY_KEY]: tabHistoryCache })
        } catch {}
      }
    } catch {
      tabHistoryCache = { stack: [], index: -1 }
    }
    return tabHistoryCache
  }

  async function writeTabHistory(nextHistory) {
    const cleanHistory = canonicalizeGlobalHistory(nextHistory).history
    tabHistoryCache = cleanHistory
    const storage = tabHistoryStorageArea()
    if (!storage) return
    try {
      await storage.set({ [TAB_HISTORY_KEY]: cleanHistory })
    } catch {
      // Best-effort only - the command can still work while the worker lives.
    }
  }

  function enqueueTabHistoryMutation(mutator) {
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

  async function recordTabActivation(windowId, tabId) {
    if (typeof windowId !== 'number' || typeof tabId !== 'number') return

    await enqueueTabHistoryMutation(async (history) => {
      await primeNativeCloseTarget(windowId, tabId, history)
      return {
        history: historyForUserActivation(history, { windowId, tabId }).history
      }
    })
  }

  async function findFocusedWindowId() {
    try {
      const windows = await chromeApi.windows.getAll()
      const focusedWindow = windows.find((win) => win.focused && typeof win.id === 'number')
      return { id: focusedWindow?.id ?? null, known: true }
    } catch {
      return { id: null, known: false }
    }
  }

  async function findLastFocusedActiveTab() {
    try {
      const focusedTabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true })
      return focusedTabs[0] || null
    } catch {
      return null
    }
  }

  async function findActiveTabForHistory(tabs, history) {
    const focusedWindow = await findFocusedWindowId()
    if (focusedWindow.id != null) {
      const focusedActiveTab = tabs.find((tab) => tab.windowId === focusedWindow.id && tab.active)
      if (focusedActiveTab) return { tab: focusedActiveTab, chromeFocused: true }
    }

    const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
    const historyTab = findTabForHistoryEntry(history, tabsById)
    const lastFocusedTab = await findLastFocusedActiveTab()
    const fallbackTab = focusedWindow.known
      ? historyTab || lastFocusedTab || tabs.find((tab) => tab.active) || null
      : lastFocusedTab || historyTab || tabs.find((tab) => tab.active) || null
    return { tab: fallbackTab, chromeFocused: !focusedWindow.known || focusedWindow.id != null }
  }

  async function focusExistingTab(tab) {
    if (!tab?.id) return false

    try {
      await chromeApi.tabs.update(tab.id, { active: true })
      await chromeApi.windows.update(tab.windowId, { focused: true })
      return true
    } catch {
      await removeTabFromHistory(tab.id)
      return false
    }
  }

  async function findPreviousSurvivingTabInWindow(history, windowId, tabId) {
    const current = normalizeGlobalHistory(history)
    let tabsInWindow = []
    try {
      tabsInWindow = await chromeApi.tabs.query({ windowId })
    } catch {
      return null
    }

    const tabsById = new Map(tabsInWindow.map((tab) => [tab.id, tab]))
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

  async function primeNativeCloseTarget(windowId, tabId, history) {
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

  async function recordFocusedWindowActiveTab(windowId) {
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

  async function removeTabFromHistory(tabId) {
    await enqueueTabHistoryMutation((history) => ({
      history: removeTabEntriesFromHistory(history, tabId)
    }))
  }

  async function restorePreviousTabAfterClose(tabId, removeInfo) {
    if (!removeInfo) return

    const { value: restoreAction } = await enqueueTabHistoryMutation(async (history) => {
      const nextHistory = removeTabEntriesFromHistory(history, tabId)
      if (removeInfo.isWindowClosing) return { history: nextHistory }

      const currentEntry = history.stack[history.index]
      if (!currentEntry || currentEntry.tabId !== tabId || currentEntry.windowId !== removeInfo.windowId) {
        return { history: nextHistory }
      }

      let tabsInWindow = []
      try {
        tabsInWindow = await chromeApi.tabs.query({ windowId: removeInfo.windowId })
      } catch {
        return { history: nextHistory }
      }

      const existingIds = new Set(tabsInWindow.map((tab) => tab.id))
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
        index: targetNewIndex
      }
      const activeTab = tabsInWindow.find((tab) => tab.active)
      return {
        history: finalHistory,
        value: activeTab?.id === targetId ? null : { targetId }
      }
    })

    if (!restoreAction?.targetId) return
    try {
      await chromeApi.tabs.update(restoreAction.targetId, { active: true })
    } catch {
      await removeTabFromHistory(restoreAction.targetId)
    }
  }

  async function switchTabHistory(direction) {
    const { value: focusAction } = await enqueueTabHistoryMutation(async (history) => {
      const tabs = await chromeApi.tabs.query({})
      const { tab: activeTab, chromeFocused } = await findActiveTabForHistory(tabs, history)
      if (!activeTab?.id) return { history }

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
            index: 0
          }
        }
      }

      const repaired = repairHistoryCursorForActiveTab(history, activeTab)
      const navigationHistory = repaired.history
      const existingTabs = new Map(tabs.map((tab) => [tab.id, tab]))
      const nextIndex = findHistoryTargetIndex(navigationHistory, direction, existingTabs, activeTab)
      if (nextIndex === -1) return { history: navigationHistory }

      const targetTab = existingTabs.get(navigationHistory.stack[nextIndex].tabId)
      if (!targetTab?.id) return { history: navigationHistory }

      return {
        history: {
          stack: navigationHistory.stack.map((entry, entryIndex) => (entryIndex === nextIndex ? { windowId: targetTab.windowId, tabId: targetTab.id } : entry)),
          index: nextIndex
        },
        value: {
          tab: targetTab,
          openerTabId: activeTab.id
        }
      }
    })

    if (!focusAction?.tab) return
    if (focusAction.openerTabId) {
      try {
        await chromeApi.tabs.update(focusAction.tab.id, { openerTabId: focusAction.openerTabId })
      } catch {}
    }

    await focusExistingTab(focusAction.tab)
  }

  async function getTabHistorySnapshot() {
    const { value: snapshot } = await enqueueTabHistoryMutation(async (storedHistory) => {
      const tabs = await chromeApi.tabs.query({})
      const { tab: activeTab } = await findActiveTabForHistory(tabs, storedHistory)
      const existingTabs = new Map(tabs.map((tab) => [tab.id, tab]))
      const repairedHistory = repairHistoryCursorForActiveTab(storedHistory, activeTab)
      const prunedHistory = pruneMissingHistoryEntries(repairedHistory.history, existingTabs)
      const cleanHistory = canonicalizeGlobalHistory(prunedHistory).history
      const previousIndex = findHistoryTargetIndex(cleanHistory, -1, existingTabs, activeTab)
      const nextIndex = findHistoryTargetIndex(cleanHistory, 1, existingTabs, activeTab)

      return {
        history: cleanHistory,
        value: {
          stackSize: cleanHistory.stack.length,
          maxSize: MAX_TAB_HISTORY,
          cursorIndex: cleanHistory.index,
          currentIndex: cleanHistory.index,
          previousIndex,
          nextIndex,
          activeTabId: activeTab?.id ?? null,
          activeWindowId: activeTab?.windowId ?? null,
          activeWasInserted: repairedHistory.activeWasInserted,
          entries: cleanHistory.stack.map((entry, index) => {
            const tab = existingTabs.get(entry.tabId)
            const url = tab?.url || ''
            const displayUrl = displayUrlForHistory(url)
            const title = (tab?.title || '').replace(/\u200e/g, '').trim() ? tab.title : displayUrl
            return {
              index,
              tabId: entry.tabId,
              windowId: entry.windowId,
              exists: !!tab,
              active: tab?.id === activeTab?.id,
              pinned: !!tab?.pinned,
              discarded: !!tab?.discarded,
              cursor: index === cleanHistory.index,
              current: index === cleanHistory.index,
              previousTarget: index === previousIndex,
              nextTarget: index === nextIndex,
              title: title || `Tab ${entry.tabId}`,
              url,
              displayUrl,
              favIconUrl: tab?.favIconUrl || ''
            }
          })
        }
      }
    })

    return snapshot
  }

  return {
    getTabHistorySnapshot,
    recordFocusedWindowActiveTab,
    recordTabActivation,
    removeTabFromHistory,
    restorePreviousTabAfterClose,
    switchTabHistory
  }
}
