/**
 * background.js — Service Worker for Badge Updates
 *
 * Chrome's "always-on" background script for Tab Out.
 * Its only job: keep the toolbar badge showing the current open tab count.
 *
 * Since we no longer have a server, we query chrome.tabs directly.
 * The badge counts real web tabs (skipping chrome:// and extension pages).
 *
 * Color coding gives a quick at-a-glance health signal:
 *   Green  (#3d7a4a) → 1–10 tabs  (focused, manageable)
 *   Amber  (#b8892e) → 11–20 tabs (getting busy)
 *   Red    (#b35a5a) → 21+ tabs   (time to cull!)
 */

const TAB_HISTORY_KEY = 'globalTabHistory'
const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'
const OPEN_FILTER_TAB_COMMAND = 'open-filter-tab'
const FOCUS_FILTER_PARAM = 'focusFilter'
const MAX_TAB_HISTORY = 24
let tabHistoryCache = null
let tabHistoryQueue = Promise.resolve()

function filterFocusUrl() {
  return `chrome-extension://${chrome.runtime.id}/index.html?${FOCUS_FILTER_PARAM}=1`
}

function normalizeGlobalHistory(entry) {
  if (!entry || !Array.isArray(entry.stack)) {
    return { stack: [], index: -1 }
  }
  const stack = entry.stack.filter((item) => item && typeof item.tabId === 'number' && typeof item.windowId === 'number')
  const maxIndex = stack.length - 1
  const index = Number.isInteger(entry.index) ? Math.max(-1, Math.min(entry.index, maxIndex)) : maxIndex
  return { stack, index }
}

function historyChanged(a, b) {
  const first = normalizeGlobalHistory(a)
  const second = normalizeGlobalHistory(b)
  if (first.index !== second.index || first.stack.length !== second.stack.length) return true
  return first.stack.some((entry, index) => entry.tabId !== second.stack[index].tabId || entry.windowId !== second.stack[index].windowId)
}

function dedupeHistoryByLatestTab(history) {
  const current = normalizeGlobalHistory(history)
  const latestIndexByTabId = new Map()
  current.stack.forEach((entry, index) => latestIndexByTabId.set(entry.tabId, index))

  const nextStack = []
  const oldIndexToNewIndex = new Map()
  current.stack.forEach((entry, index) => {
    if (latestIndexByTabId.get(entry.tabId) !== index) return
    oldIndexToNewIndex.set(index, nextStack.length)
    nextStack.push(entry)
  })

  let nextIndex = -1
  const currentEntry = current.stack[current.index]
  if (currentEntry) {
    const keptOldIndex = latestIndexByTabId.get(currentEntry.tabId)
    nextIndex = oldIndexToNewIndex.get(keptOldIndex) ?? -1
  }

  return {
    stack: nextStack,
    index: nextStack.length === 0 ? -1 : nextIndex
  }
}

function trimHistoryToMax(history) {
  const current = normalizeGlobalHistory(history)
  if (current.stack.length <= MAX_TAB_HISTORY) return current

  const dropCount = current.stack.length - MAX_TAB_HISTORY
  return {
    stack: current.stack.slice(dropCount),
    index: current.index === -1 ? -1 : Math.max(0, current.index - dropCount)
  }
}

function canonicalizeGlobalHistory(history) {
  const current = normalizeGlobalHistory(history)
  const deduped = dedupeHistoryByLatestTab(current)
  const trimmed = trimHistoryToMax(deduped)
  return {
    history: trimmed,
    changed: historyChanged(current, trimmed)
  }
}

function tabHistoryStorageArea() {
  return chrome.storage?.local || chrome.storage?.session || null
}

function removeTabEntriesFromHistory(history, tabId) {
  const current = normalizeGlobalHistory(history)
  const removedIndexes = current.stack
    .map((entry, index) => (entry.tabId === tabId ? index : -1))
    .filter((index) => index !== -1)

  if (removedIndexes.length === 0) return history

  const nextStack = current.stack.filter((entry) => entry.tabId !== tabId)
  const removedBeforeIndex = removedIndexes.filter((index) => index < current.index).length
  const removedAtIndex = removedIndexes.includes(current.index)
  let nextIndex = current.index - removedBeforeIndex

  if (removedAtIndex) {
    nextIndex = Math.min(nextIndex, nextStack.length - 1)
  }

  return {
    stack: nextStack,
    index: nextStack.length === 0 ? -1 : Math.max(0, nextIndex)
  }
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

    if (storedHistory == null && storage === chrome.storage?.local && chrome.storage?.session) {
      const sessionStored = await chrome.storage.session.get(TAB_HISTORY_KEY)
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
    // Best-effort only — the command can still work while the worker lives.
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

function historyForUserActivation(history, activeEntry) {
  const current = canonicalizeGlobalHistory(history).history
  if (!activeEntry || typeof activeEntry.tabId !== 'number' || typeof activeEntry.windowId !== 'number') {
    return { history: current, changed: false }
  }

  if (current.stack[current.index]?.tabId === activeEntry.tabId) {
    const nextStack = current.stack.slice()
    nextStack[current.index] = { windowId: activeEntry.windowId, tabId: activeEntry.tabId }
    const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: current.index }).history
    return { history: nextHistory, changed: historyChanged(current, nextHistory) }
  }

  const nextStack = current.index < current.stack.length - 1 ? current.stack.slice(0, current.index + 1) : current.stack.slice()
  nextStack.push({ windowId: activeEntry.windowId, tabId: activeEntry.tabId })
  const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: nextStack.length - 1 }).history

  return { history: nextHistory, changed: historyChanged(current, nextHistory) }
}

function repairHistoryCursorForActiveTab(history, activeTab) {
  const current = canonicalizeGlobalHistory(history).history
  if (!activeTab?.id) {
    return { history: current, activeWasInserted: false, changed: historyChanged(history, current) }
  }

  if (current.stack[current.index]?.tabId === activeTab.id) {
    const nextStack = current.stack.slice()
    nextStack[current.index] = { windowId: activeTab.windowId, tabId: activeTab.id }
    const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: current.index }).history
    return { history: nextHistory, activeWasInserted: false, changed: historyChanged(current, nextHistory) }
  }

  const latestActiveIndex = current.stack.map((entry) => entry.tabId).lastIndexOf(activeTab.id)
  if (latestActiveIndex !== -1) {
    const nextStack = current.stack.slice()
    nextStack[latestActiveIndex] = { windowId: activeTab.windowId, tabId: activeTab.id }
    const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: latestActiveIndex }).history
    return { history: nextHistory, activeWasInserted: false, changed: historyChanged(current, nextHistory) }
  }

  const nextStack = current.index < current.stack.length - 1 ? current.stack.slice(0, current.index + 1) : current.stack.slice()
  nextStack.push({ windowId: activeTab.windowId, tabId: activeTab.id })
  const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: nextStack.length - 1 }).history

  return { history: nextHistory, activeWasInserted: true, changed: true }
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

function findHistoryTargetIndex(history, direction, existingTabs, activeTab) {
  if (!activeTab?.id) return -1

  let nextIndex = history.index + direction
  while (
    nextIndex >= 0 &&
    nextIndex < history.stack.length &&
    (!existingTabs.has(history.stack[nextIndex].tabId) || history.stack[nextIndex].tabId === activeTab.id)
  ) {
    nextIndex += direction
  }
  return nextIndex < 0 || nextIndex >= history.stack.length ? -1 : nextIndex
}

function findTabForHistoryEntry(history, tabsById) {
  const current = normalizeGlobalHistory(history)
  const entry = current.stack[current.index]
  return entry ? tabsById.get(entry.tabId) || null : null
}

async function findFocusedWindowId() {
  try {
    const windows = await chrome.windows.getAll()
    const focusedWindow = windows.find((win) => win.focused && typeof win.id === 'number')
    return { id: focusedWindow?.id ?? null, known: true }
  } catch {
    return { id: null, known: false }
  }
}

async function findLastFocusedActiveTab() {
  try {
    const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
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
    await chrome.tabs.update(tab.id, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
    return true
  } catch {
    await removeTabFromHistory(tab.id)
    return false
  }
}

function pruneMissingHistoryEntries(history, existingTabs) {
  const current = normalizeGlobalHistory(history)
  let nextHistory = current

  for (const entry of current.stack) {
    if (existingTabs.has(entry.tabId)) continue
    nextHistory = removeTabEntriesFromHistory(nextHistory, entry.tabId)
  }

  return {
    ...nextHistory,
    changed: nextHistory.stack.length !== current.stack.length || nextHistory.index !== current.index
  }
}

async function findPreviousSurvivingTabInWindow(history, windowId, tabId) {
  const current = normalizeGlobalHistory(history)
  let tabsInWindow = []
  try {
    tabsInWindow = await chrome.tabs.query({ windowId })
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
    await chrome.tabs.update(tabId, { openerTabId: targetTab.id })
  } catch {
    // Some browser-managed tabs reject opener changes; the onRemoved
    // restore path below remains the fallback.
  }
}

async function recordFocusedWindowActiveTab(windowId) {
  if (windowId == null || windowId === chrome.windows.WINDOW_ID_NONE) return
  try {
    const tabs = await chrome.tabs.query({ windowId, active: true })
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
      tabsInWindow = await chrome.tabs.query({ windowId: removeInfo.windowId })
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
    await chrome.tabs.update(restoreAction.targetId, { active: true })
  } catch {
    await removeTabFromHistory(restoreAction.targetId)
  }
}

async function switchTabHistory(direction) {
  const { value: focusAction } = await enqueueTabHistoryMutation(async (history) => {
    const tabs = await chrome.tabs.query({})
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
      await chrome.tabs.update(focusAction.tab.id, { openerTabId: focusAction.openerTabId })
    } catch {}
  }

  await focusExistingTab(focusAction.tab)
}

function displayUrlForHistory(url = '') {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'chrome-extension:' && parsed.pathname.endsWith('/index.html')) return 'Tab Out'
    if (parsed.protocol === 'chrome:') return parsed.href
    return parsed.hostname + parsed.pathname
  } catch {
    return url
  }
}

async function getTabHistorySnapshot() {
  const { value: snapshot } = await enqueueTabHistoryMutation(async (storedHistory) => {
    const tabs = await chrome.tabs.query({})
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

async function findNormalBrowserWindow() {
  try {
    const lastFocusedNormal = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    if (typeof lastFocusedNormal?.id === 'number') return lastFocusedNormal
  } catch {}

  try {
    const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] })
    return normalWindows.find((win) => win.focused) || normalWindows[0] || null
  } catch {
    return null
  }
}

async function openFilterTab() {
  const url = filterFocusUrl()
  const normalWindow = await findNormalBrowserWindow()

  if (typeof normalWindow?.id === 'number') {
    await chrome.tabs.create({
      windowId: normalWindow.id,
      url,
      active: true
    })
    try {
      await chrome.windows.update(normalWindow.id, { focused: true })
    } catch {}
    return
  }

  try {
    await chrome.windows.create({ type: 'normal', url, focused: true })
  } catch {
    await chrome.tabs.create({ url, active: true })
  }
}

// ─── Badge updater ────────────────────────────────────────────────────────────

/**
 * updateBadge()
 *
 * Counts open real-web tabs and updates the extension's toolbar badge.
 * "Real" tabs = not chrome://, not extension pages, not about:blank.
 */
async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({})

    // Only count actual web pages — skip browser internals and extension pages
    const count = tabs.filter((t) => {
      const url = t.url || ''
      return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:') && !url.startsWith('edge://') && !url.startsWith('brave://')
    }).length

    // Don't show "0" — an empty badge is cleaner
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' })

    if (count === 0) return

    // Pick badge color based on workload level
    let color
    if (count <= 10) {
      color = '#3d7a4a' // Green — you're in control
    } else if (count <= 20) {
      color = '#b8892e' // Amber — things are piling up
    } else {
      color = '#b35a5a' // Red — time to focus and close some tabs
    }

    await chrome.action.setBadgeBackgroundColor({ color })
  } catch {
    // If something goes wrong, clear the badge rather than show stale data
    chrome.action.setBadgeText({ text: '' })
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────

// Update badge when the extension is first installed
chrome.runtime.onInstalled.addListener(() => {
  updateBadge()
})

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge()
})

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener(() => {
  updateBadge()
})

// Track tab activation history so commands and close-redirect can
// follow the user's actual navigation path.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  recordTabActivation(windowId, tabId)
})

chrome.windows.onFocusChanged.addListener((windowId) => {
  recordFocusedWindowActiveTab(windowId)
})

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  updateBadge()
  restorePreviousTabAfterClose(tabId, removeInfo)
})

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge()
})

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'switch-to-last-tab') {
    switchTabHistory(-1)
  } else if (command === 'switch-to-next-tab') {
    switchTabHistory(1)
  } else if (command === OPEN_FILTER_TAB_COMMAND) {
    openFilterTab()
  }
})

chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
  if (message?.type === TAB_HISTORY_GET_MESSAGE) {
    getTabHistorySnapshot()
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch(() => sendResponse({ ok: false, snapshot: null }))
    return true
  }

  if (message?.type === TAB_HISTORY_SWITCH_MESSAGE) {
    const direction = message.direction === 1 ? 1 : -1
    switchTabHistory(direction)
      .then(() => getTabHistorySnapshot())
      .then((snapshot) => sendResponse({ ok: true, snapshot }))
      .catch(() => sendResponse({ ok: false, snapshot: null }))
    return true
  }

  return false
})

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge()
