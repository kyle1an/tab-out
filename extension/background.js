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
const MAX_TAB_HISTORY = 24
let tabHistoryCache = null
let suppressedActivation = null

function normalizeGlobalHistory(entry) {
  if (!entry || !Array.isArray(entry.stack)) {
    return { stack: [], index: -1 }
  }
  const stack = entry.stack.filter((item) => item && typeof item.tabId === 'number' && typeof item.windowId === 'number')
  const maxIndex = stack.length - 1
  const index = Number.isInteger(entry.index) ? Math.max(-1, Math.min(entry.index, maxIndex)) : maxIndex
  return { stack, index }
}

async function readTabHistory() {
  if (tabHistoryCache) return tabHistoryCache
  if (!chrome.storage?.session) {
    tabHistoryCache = {}
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
  if (suppressedActivation && suppressedActivation.windowId === windowId && suppressedActivation.tabId === tabId) {
    suppressedActivation = null
    return
  }

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

async function removeTabFromHistory(tabId) {
  const history = normalizeGlobalHistory(await readTabHistory())
  const removeIndex = history.stack.findIndex((entry) => entry.tabId === tabId)
  if (removeIndex === -1) return

  const nextStack = history.stack.filter((entry) => entry.tabId !== tabId)
  let nextIndex = history.index
  if (removeIndex < history.index) nextIndex -= 1
  if (removeIndex === history.index) nextIndex = Math.min(nextIndex, nextStack.length - 1)
  await writeTabHistory({
    stack: nextStack,
    index: nextStack.length === 0 ? -1 : Math.max(0, nextIndex)
  })
}

async function switchTabHistory(direction) {
  const tabs = await chrome.tabs.query({})
  const activeTab = tabs.find((tab) => tab.active)
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
      await writeTabHistory({
        stack: nextStack,
        index: nextStack.length - 1
      })
      return
    }
  }

  const existingTabs = new Map(tabs.map((tab) => [tab.id, tab]))
  let nextIndex = index + direction
  while (nextIndex >= 0 && nextIndex < history.stack.length && !existingTabs.has(history.stack[nextIndex].tabId)) {
    nextIndex += direction
  }
  if (nextIndex < 0 || nextIndex >= history.stack.length) return

  const targetTab = existingTabs.get(history.stack[nextIndex].tabId)
  if (!targetTab?.id) return

  await writeTabHistory({
    stack: history.stack.map((entry, entryIndex) => (entryIndex === nextIndex ? { windowId: targetTab.windowId, tabId: targetTab.id } : entry)),
    index: nextIndex
  })
  suppressedActivation = { windowId: targetTab.windowId, tabId: targetTab.id }

  try {
    await chrome.tabs.update(targetTab.id, { active: true })
    await chrome.windows.update(targetTab.windowId, { focused: true })
  } catch {
    suppressedActivation = null
    await removeTabFromHistory(targetTab.id)
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

// Track activation history per window so the command can jump back.
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  recordTabActivation(windowId, tabId)
})

// Update badge whenever a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  updateBadge()
  removeTabFromHistory(tabId)
})

// Update badge when a tab's URL changes (e.g. navigating to/from chrome://)
chrome.tabs.onUpdated.addListener(() => {
  updateBadge()
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
    const extensionId = chrome.runtime.id
    const newtabUrl = `chrome-extension://${extensionId}/index.html`
    const tabs = await chrome.tabs.query({ windowId: window.id })
    const existing = tabs.find((t) => {
      const u = t.url || t.pendingUrl || ''
      return u === newtabUrl || u === 'chrome://newtab/'
    })
    if (existing) {
      if (!existing.pinned) await chrome.tabs.update(existing.id, { pinned: true })
    } else {
      await chrome.tabs.create({
        windowId: window.id,
        url: newtabUrl,
        pinned: true,
        active: false,
        index: 0
      })
    }
  } catch {
    // Window may have closed between onCreated and our query; silently drop.
  }
})

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'switch-to-last-tab') {
    switchTabHistory(-1)
  } else if (command === 'switch-to-next-tab') {
    switchTabHistory(1)
  }
})

// ─── Initial run ─────────────────────────────────────────────────────────────

// Run once immediately when the service worker first loads
updateBadge()
