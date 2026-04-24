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
const PINNED_DASHBOARD_TABS_KEY = 'pinnedDashboardTabs'
const OPEN_FILTER_TAB_COMMAND = 'open-filter-tab'
const FOCUS_FILTER_MESSAGE = 'tab-out:focus-filter'
const FOCUS_FILTER_PARAM = 'focusFilter'
const MAX_TAB_HISTORY = 24
let tabHistoryCache = null
let pinnedDashboardTabsCache = null
const dashboardReplacementInFlight = new Set()
const filterFocusReplacementTabIds = new Set()

function extensionNewtabUrl() {
  return `chrome-extension://${chrome.runtime.id}/index.html`
}

function isTabOutUrl(url) {
  if (url === 'chrome://newtab/') return true
  const tabOutUrl = extensionNewtabUrl()
  return url === tabOutUrl || url?.startsWith(`${tabOutUrl}?`) || url?.startsWith(`${tabOutUrl}#`)
}

function filterFocusUrl() {
  return `${extensionNewtabUrl()}?${FOCUS_FILTER_PARAM}=1`
}

function normalizePinnedDashboardTabs(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {}

  return Object.fromEntries(
    Object.entries(entry).filter(([tabId, value]) => Number.isInteger(Number(tabId)) && value && typeof value.windowId === 'number')
  )
}

async function readPinnedDashboardTabs() {
  if (pinnedDashboardTabsCache) return pinnedDashboardTabsCache
  if (!chrome.storage?.session) {
    pinnedDashboardTabsCache = {}
    return pinnedDashboardTabsCache
  }
  try {
    const stored = await chrome.storage.session.get(PINNED_DASHBOARD_TABS_KEY)
    pinnedDashboardTabsCache = normalizePinnedDashboardTabs(stored[PINNED_DASHBOARD_TABS_KEY])
  } catch {
    pinnedDashboardTabsCache = {}
  }
  return pinnedDashboardTabsCache
}

async function writePinnedDashboardTabs(nextTabs) {
  pinnedDashboardTabsCache = nextTabs
  if (!chrome.storage?.session) return
  try {
    await chrome.storage.session.set({ [PINNED_DASHBOARD_TABS_KEY]: nextTabs })
  } catch {
    // Best-effort only — losing this cache just disables the replacement
    // behavior until the next tracking refresh.
  }
}

async function updatePinnedDashboardTracking(tabId, tab) {
  if (typeof tabId !== 'number') return
  const trackedTabs = { ...(await readPinnedDashboardTabs()) }
  const url = tab?.url || tab?.pendingUrl || ''

  if (tab && tab.pinned && typeof tab.windowId === 'number' && isTabOutUrl(url)) {
    trackedTabs[String(tabId)] = { windowId: tab.windowId }
  } else {
    delete trackedTabs[String(tabId)]
  }

  await writePinnedDashboardTabs(trackedTabs)
}

async function removePinnedDashboardTracking(tabId) {
  if (typeof tabId !== 'number') return
  const trackedTabs = { ...(await readPinnedDashboardTabs()) }
  delete trackedTabs[String(tabId)]
  await writePinnedDashboardTabs(trackedTabs)
}

async function syncPinnedDashboardTabsFromCurrentState() {
  try {
    const tabs = await chrome.tabs.query({})
    const trackedTabs = Object.fromEntries(
      tabs
        .filter((tab) => typeof tab.id === 'number' && tab.pinned && isTabOutUrl(tab.url || tab.pendingUrl || ''))
        .map((tab) => [String(tab.id), { windowId: tab.windowId }])
    )
    await writePinnedDashboardTabs(trackedTabs)
  } catch {
    // Best-effort only. If the query fails, the per-tab update listeners
    // will rebuild the cache as soon as relevant tab events arrive.
  }
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
  if (!chrome.storage?.session) {
    tabHistoryCache = { stack: [], index: -1 }
    return tabHistoryCache
  }
  try {
    const stored = await chrome.storage.session.get(TAB_HISTORY_KEY)
    tabHistoryCache = normalizeGlobalHistory(stored[TAB_HISTORY_KEY])
  } catch {
    tabHistoryCache = { stack: [], index: -1 }
  }
  return tabHistoryCache
}

async function writeTabHistory(nextHistory) {
  tabHistoryCache = nextHistory
  if (!chrome.storage?.session) return
  try {
    await chrome.storage.session.set({ [TAB_HISTORY_KEY]: nextHistory })
  } catch {
    // Best-effort only — the command can still work while the worker lives.
  }
}

async function recordTabActivation(windowId, tabId) {
  const history = normalizeGlobalHistory(await readTabHistory())
  if (history.stack[history.index]?.tabId === tabId) return

  let nextStack = history.index < history.stack.length - 1 ? history.stack.slice(0, history.index + 1) : history.stack.slice()
  nextStack.push({ windowId, tabId })
  if (nextStack.length > MAX_TAB_HISTORY) {
    nextStack = nextStack.slice(nextStack.length - MAX_TAB_HISTORY)
  }

  await writeTabHistory({
    stack: nextStack,
    index: nextStack.length - 1
  })
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
  const history = normalizeGlobalHistory(await readTabHistory())
  const nextHistory = removeTabEntriesFromHistory(history, tabId)
  if (nextHistory === history) return
  await writeTabHistory(nextHistory)
}

async function restorePreviousTabAfterClose(tabId, removeInfo) {
  if (!removeInfo || removeInfo.isWindowClosing) return

  const history = normalizeGlobalHistory(await readTabHistory())
  const currentEntry = history.stack[history.index]
  if (!currentEntry || currentEntry.tabId !== tabId || currentEntry.windowId !== removeInfo.windowId) {
    await removeTabFromHistory(tabId)
    return
  }

  const tabsInWindow = await chrome.tabs.query({ windowId: removeInfo.windowId })
  const existingIds = new Set(tabsInWindow.map((tab) => tab.id))

  let targetOldIndex = -1
  for (let i = history.index - 1; i >= 0; i--) {
    const entry = history.stack[i]
    if (entry.windowId !== removeInfo.windowId) continue
    if (!existingIds.has(entry.tabId)) continue
    targetOldIndex = i
    break
  }

  const nextHistory = removeTabEntriesFromHistory(history, tabId)
  if (targetOldIndex === -1) {
    await writeTabHistory(nextHistory)
    return
  }

  const targetId = history.stack[targetOldIndex].tabId
  let targetNewIndex = -1
  for (let i = Math.min(targetOldIndex, nextHistory.stack.length - 1); i >= 0; i--) {
    if (nextHistory.stack[i].tabId === targetId && nextHistory.stack[i].windowId === removeInfo.windowId) {
      targetNewIndex = i
      break
    }
  }

  const finalHistory = {
    stack: nextHistory.stack,
    index: targetNewIndex === -1 ? nextHistory.index : targetNewIndex
  }
  await writeTabHistory(finalHistory)

  if (targetNewIndex === -1) return

  try {
    await chrome.tabs.update(targetId, { active: true })
  } catch {
    await removeTabFromHistory(targetId)
  }
}

async function switchTabHistory(direction) {
  const tabs = await chrome.tabs.query({})
  const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const activeTab = focusedTabs[0] || tabs.find((tab) => tab.active)
  if (!activeTab?.id) return

  const history = normalizeGlobalHistory(await readTabHistory())

  if (history.stack.length === 0) {
    await writeTabHistory({
      stack: [{ windowId: activeTab.windowId, tabId: activeTab.id }],
      index: 0
    })
    return
  }

  let index = history.index
  if (history.stack[index]?.tabId !== activeTab.id) {
    const latestActiveIndex = history.stack.map((entry) => entry.tabId).lastIndexOf(activeTab.id)
    if (latestActiveIndex !== -1) {
      index = latestActiveIndex
    } else {
      let nextStack = history.index < history.stack.length - 1 ? history.stack.slice(0, history.index + 1) : history.stack.slice()
      nextStack.push({ windowId: activeTab.windowId, tabId: activeTab.id })
      if (nextStack.length > MAX_TAB_HISTORY) {
        nextStack = nextStack.slice(nextStack.length - MAX_TAB_HISTORY)
      }
      const nextHistory = {
        stack: nextStack,
        index: nextStack.length - 1
      }
      await writeTabHistory(nextHistory)
      history.stack = nextHistory.stack
      history.index = nextHistory.index
      index = nextHistory.index
    }
  }

  const existingTabs = new Map(tabs.map((tab) => [tab.id, tab]))
  let nextIndex = index + direction
  while (
    nextIndex >= 0 &&
    nextIndex < history.stack.length &&
    (!existingTabs.has(history.stack[nextIndex].tabId) || history.stack[nextIndex].tabId === activeTab.id)
  ) {
    nextIndex += direction
  }
  if (nextIndex < 0 || nextIndex >= history.stack.length) return

  const targetTab = existingTabs.get(history.stack[nextIndex].tabId)
  if (!targetTab?.id) return

  await writeTabHistory({
    stack: history.stack.map((entry, entryIndex) => (entryIndex === nextIndex ? { windowId: targetTab.windowId, tabId: targetTab.id } : entry)),
    index: nextIndex
  })

  try {
    await chrome.tabs.update(targetTab.id, { active: true })
    await chrome.windows.update(targetTab.windowId, { focused: true })
  } catch {
    await removeTabFromHistory(targetTab.id)
  }
}

async function requestFilterFocus(tabId) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: FOCUS_FILTER_MESSAGE,
      tabId
    })
    return !!result?.focused
  } catch {
    return false
  }
}

async function replaceActiveTabOutForFilterFocus(tab) {
  if (tab?.id == null || typeof tab.windowId !== 'number') return

  const createOptions = {
    windowId: tab.windowId,
    url: filterFocusUrl(),
    active: true,
    pinned: !!tab.pinned
  }
  if (typeof tab.index === 'number') createOptions.index = tab.index

  const replacement = await chrome.tabs.create(createOptions)
  if (replacement?.id != null) {
    await updatePinnedDashboardTracking(replacement.id, {
      ...replacement,
      url: replacement.url || replacement.pendingUrl || filterFocusUrl()
    })
    await recordTabActivation(tab.windowId, replacement.id)
  } else {
    return
  }

  try {
    await chrome.windows.update(tab.windowId, { focused: true })
  } catch {}

  filterFocusReplacementTabIds.add(tab.id)
  try {
    await chrome.tabs.remove(tab.id)
  } catch {
    filterFocusReplacementTabIds.delete(tab.id)
  }
}

async function openFilterTab() {
  const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  const activeTab = activeTabs[0]
  if (activeTab?.id != null && isTabOutUrl(activeTab.url || activeTab.pendingUrl || '')) {
    if (await requestFilterFocus(activeTab.id)) return

    await replaceActiveTabOutForFilterFocus(activeTab)
    return
  }

  await chrome.tabs.create({
    url: filterFocusUrl(),
    active: true
  })
}

async function ensurePinnedDashboardTab(windowId, opts = {}) {
  if (typeof windowId !== 'number') return null

  const { excludeTabId = null, createIndex } = opts
  const tabs = await chrome.tabs.query({ windowId })

  const existingPinned = tabs.find((tab) => tab.id !== excludeTabId && tab.pinned && isTabOutUrl(tab.url || tab.pendingUrl || ''))
  if (existingPinned) {
    await updatePinnedDashboardTracking(existingPinned.id, existingPinned)
    return existingPinned
  }

  const existingUnpinned = tabs.find((tab) => tab.id !== excludeTabId && !tab.pinned && isTabOutUrl(tab.url || tab.pendingUrl || ''))
  if (existingUnpinned) {
    const updated = await chrome.tabs.update(existingUnpinned.id, { pinned: true })
    await updatePinnedDashboardTracking(existingUnpinned.id, updated || { ...existingUnpinned, pinned: true })
    return updated || existingUnpinned
  }

  const createOptions = {
    windowId,
    pinned: true,
    active: false
  }
  if (typeof createIndex === 'number') createOptions.index = createIndex

  const created = await chrome.tabs.create(createOptions)
  if (created?.id != null) {
    await updatePinnedDashboardTracking(created.id, {
      ...created,
      url: created.url || created.pendingUrl || 'chrome://newtab/'
    })
  }
  return created || null
}

async function moveTabToWindowEnd(tabId, windowId) {
  const tabs = await chrome.tabs.query({ windowId })
  const lastIndex = tabs.reduce((max, tab) => (typeof tab.index === 'number' ? Math.max(max, tab.index) : max), -1)
  if (lastIndex >= 0) {
    await chrome.tabs.move(tabId, { index: lastIndex })
  }
}

async function replacePinnedDashboardAfterNavigation(tabId, trackedWindowId, tab) {
  if (dashboardReplacementInFlight.has(tabId)) return

  const windowId = typeof tab?.windowId === 'number' ? tab.windowId : trackedWindowId
  if (typeof windowId !== 'number') return

  dashboardReplacementInFlight.add(tabId)
  try {
    await ensurePinnedDashboardTab(windowId, {
      excludeTabId: tabId,
      createIndex: typeof tab?.index === 'number' ? tab.index : undefined
    })
    const updated = await chrome.tabs.update(tabId, { pinned: false })
    await updatePinnedDashboardTracking(tabId, updated || { ...tab, pinned: false })
    await moveTabToWindowEnd(tabId, windowId)
  } catch {
    // Best-effort only — if the tab closes or the window disappears mid-flight,
    // leave Chrome's default state alone.
  } finally {
    dashboardReplacementInFlight.delete(tabId)
  }
}

function getNavigationTarget(changeInfo, tab) {
  const pendingUrl = tab?.pendingUrl || ''
  if (pendingUrl && !isTabOutUrl(pendingUrl)) return pendingUrl

  const changedUrl = changeInfo?.url || ''
  if (changedUrl && !isTabOutUrl(changedUrl)) return changedUrl

  return ''
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  await updateBadge()

  const trackedTabs = await readPinnedDashboardTabs()
  const tracked = trackedTabs[String(tabId)]
  const navigationTarget = getNavigationTarget(changeInfo, tab)

  if (tracked && navigationTarget) {
    await replacePinnedDashboardAfterNavigation(tabId, tracked.windowId, { ...tab, pendingUrl: navigationTarget })
    return
  }

  await updatePinnedDashboardTracking(tabId, tab)
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
  syncPinnedDashboardTabsFromCurrentState()
})

// Update badge when Chrome starts up
chrome.runtime.onStartup.addListener(() => {
  updateBadge()
  syncPinnedDashboardTabsFromCurrentState()
})

// Update badge whenever a tab is opened
chrome.tabs.onCreated.addListener((tab) => {
  updateBadge()
  if (tab?.id != null) updatePinnedDashboardTracking(tab.id, tab)
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
  removePinnedDashboardTracking(tabId)
  if (filterFocusReplacementTabIds.has(tabId)) {
    filterFocusReplacementTabIds.delete(tabId)
    removeTabFromHistory(tabId)
    return
  }
  restorePreviousTabAfterClose(tabId, removeInfo)
})

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await handleTabUpdated(tabId, changeInfo, tab)
})

// Pin a Tab Out tab in every newly-created window so the dashboard
// is always one click away, regardless of which window the user is
// in. If Chrome's newtab override already spawned Tab Out as the
// window's initial tab, just pin it; otherwise create a fresh pinned
// Tab Out at index 0. Skipped for non-normal windows (popups, devtools
// detach, etc.) — those aren't dashboards-worthy contexts.
chrome.windows.onCreated.addListener(async (window) => {
  if (window.type !== 'normal') return
  try {
    await ensurePinnedDashboardTab(window.id, { createIndex: 0 })
  } catch {
    // Window may have closed between onCreated and our query; silently drop.
  }
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

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge()
syncPinnedDashboardTabsFromCurrentState()
