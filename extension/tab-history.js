const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'

function emptySnapshot() {
  return {
    stackSize: 0,
    maxSize: 0,
    cursorIndex: -1,
    currentIndex: -1,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: null,
    activeWindowId: null,
    activeWasInserted: false,
    entries: []
  }
}

function normalizeEntry(entry, index) {
  const tabId = Number.isInteger(entry?.tabId) ? entry.tabId : -1
  const windowId = Number.isInteger(entry?.windowId) ? entry.windowId : -1
  return {
    index: Number.isInteger(entry?.index) ? entry.index : index,
    tabId,
    windowId,
    exists: !!entry?.exists,
    active: !!entry?.active,
    pinned: !!entry?.pinned,
    discarded: !!entry?.discarded,
    cursor: !!entry?.cursor,
    current: !!entry?.current,
    previousTarget: !!entry?.previousTarget,
    nextTarget: !!entry?.nextTarget,
    title: String(entry?.title || (tabId === -1 ? 'Unknown tab' : `Tab ${tabId}`)),
    url: String(entry?.url || ''),
    displayUrl: String(entry?.displayUrl || entry?.url || (tabId === -1 ? '' : `tab ${tabId}`)),
    favIconUrl: String(entry?.favIconUrl || '')
  }
}

export function normalizeTabHistorySnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries)) return emptySnapshot()
  const entries = snapshot.entries.map(normalizeEntry)
  return {
    stackSize: Number.isInteger(snapshot.stackSize) ? snapshot.stackSize : entries.length,
    maxSize: Number.isInteger(snapshot.maxSize) ? snapshot.maxSize : 0,
    cursorIndex: Number.isInteger(snapshot.cursorIndex) ? snapshot.cursorIndex : -1,
    currentIndex: Number.isInteger(snapshot.currentIndex) ? snapshot.currentIndex : -1,
    previousIndex: Number.isInteger(snapshot.previousIndex) ? snapshot.previousIndex : -1,
    nextIndex: Number.isInteger(snapshot.nextIndex) ? snapshot.nextIndex : -1,
    activeTabId: Number.isInteger(snapshot.activeTabId) ? snapshot.activeTabId : null,
    activeWindowId: Number.isInteger(snapshot.activeWindowId) ? snapshot.activeWindowId : null,
    activeWasInserted: !!snapshot.activeWasInserted,
    entries
  }
}

async function sendHistoryMessage(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) return emptySnapshot()
  try {
    const response = await chrome.runtime.sendMessage(message)
    if (!response?.ok) return emptySnapshot()
    return normalizeTabHistorySnapshot(response.snapshot)
  } catch {
    return emptySnapshot()
  }
}

export function fetchTabHistorySnapshot() {
  return sendHistoryMessage({ type: TAB_HISTORY_GET_MESSAGE })
}

export function switchTabHistoryFromDashboard(direction) {
  return sendHistoryMessage({
    type: TAB_HISTORY_SWITCH_MESSAGE,
    direction: direction === 1 ? 1 : -1
  })
}

export async function focusHistoryEntry(entry) {
  if (!entry?.exists || !Number.isInteger(entry.tabId)) return false
  try {
    await chrome.tabs.update(entry.tabId, { active: true })
    await chrome.windows.update(entry.windowId, { focused: true })
    return true
  } catch {
    return false
  }
}
