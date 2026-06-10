import { snapshotChromeTabs } from './tabs.js'
import { pickFavicon, pickTabFavicon } from './favicons.js'
import { focusExistingTabTarget } from './tab-focus.js'
import type { TabHistoryEntry, TabHistorySnapshot, TabSnapshot } from './types'

const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'

function emptySnapshot(): TabHistorySnapshot {
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

function integerOr(value: unknown, fallback: number): number {
  return Number.isInteger(value) ? Number(value) : fallback
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) ? Number(value) : null
}

function normalizeEntry(entry: Partial<TabHistoryEntry> | null | undefined, index: number): TabHistoryEntry {
  const tabId = integerOr(entry?.tabId, -1)
  const windowId = integerOr(entry?.windowId, -1)
  const url = String(entry?.url || '')
  const rawUrl = String(entry?.rawUrl || url)
  // A suspended row's favIconUrl is the suspender page's faded data: icon —
  // recover the real favicon by the unwrapped url instead of keeping that
  // copy. Older snapshots lack the explicit flag, so fall back to the
  // canonical derivation (rawUrl differs from the effective url only when
  // a suspender rewrote it).
  const suspended = entry?.suspended ?? rawUrl !== url
  const favIconUrl = String(entry?.favIconUrl || '')
  return {
    index: integerOr(entry?.index, index),
    tabId,
    windowId,
    exists: !!entry?.exists,
    active: !!entry?.active,
    activeInOtherWindow: !!entry?.activeInOtherWindow,
    isApp: !!entry?.isApp,
    pinned: !!entry?.pinned,
    discarded: !!entry?.discarded,
    suspended,
    audible: !!entry?.audible,
    muted: !!entry?.muted,
    cursor: !!entry?.cursor,
    current: !!entry?.current,
    previousTarget: !!entry?.previousTarget,
    nextTarget: !!entry?.nextTarget,
    title: String(entry?.title || (tabId === -1 ? 'Unknown tab' : `Tab ${tabId}`)),
    url,
    rawUrl,
    displayUrl: String(entry?.displayUrl || url || (tabId === -1 ? '' : `tab ${tabId}`)),
    favIconUrl: suspended ? pickTabFavicon({ favIconUrl, url, suspended }) : pickFavicon({ favIconUrl, url }),
    lastActivatedAt: integerOrNull(entry?.lastActivatedAt)
  }
}

export function normalizeTabHistorySnapshot(snapshot: Partial<TabHistorySnapshot> | null | undefined): TabHistorySnapshot {
  if (!snapshot || !Array.isArray(snapshot.entries)) return emptySnapshot()
  const entries = snapshot.entries.map(normalizeEntry)
  return {
    stackSize: integerOr(snapshot.stackSize, entries.length),
    maxSize: integerOr(snapshot.maxSize, 0),
    cursorIndex: integerOr(snapshot.cursorIndex, -1),
    currentIndex: integerOr(snapshot.currentIndex, -1),
    previousIndex: integerOr(snapshot.previousIndex, -1),
    nextIndex: integerOr(snapshot.nextIndex, -1),
    activeTabId: integerOrNull(snapshot.activeTabId),
    activeWindowId: integerOrNull(snapshot.activeWindowId),
    activeWasInserted: !!snapshot.activeWasInserted,
    entries
  }
}

async function sendHistoryMessage(message: Record<string, unknown>): Promise<TabHistorySnapshot> {
  if (!globalThis.chrome?.runtime?.sendMessage) return emptySnapshot()
  try {
    const response = await chrome.runtime.sendMessage(message)
    if (!response?.ok) return emptySnapshot()
    return normalizeTabHistorySnapshot(response.snapshot)
  } catch {
    return emptySnapshot()
  }
}

export function fetchTabHistorySnapshot(): Promise<TabHistorySnapshot> {
  return sendHistoryMessage({ type: TAB_HISTORY_GET_MESSAGE })
}

export function switchTabHistoryFromDashboard(direction: number): Promise<TabHistorySnapshot> {
  return sendHistoryMessage({
    type: TAB_HISTORY_SWITCH_MESSAGE,
    direction: direction === 1 ? 1 : -1
  })
}

export async function focusHistoryEntry(entry: TabHistoryEntry): Promise<boolean> {
  if (!entry?.exists) return false
  return focusExistingTabTarget({
    tabId: entry.tabId,
    windowId: entry.windowId,
    url: entry.url,
    rawUrl: entry.rawUrl
  })
}

export async function closeHistoryEntry(entry: TabHistoryEntry): Promise<{ closed: boolean; snapshot: TabSnapshot[] }> {
  if (!entry?.exists || !Number.isInteger(entry.tabId)) return { closed: false, snapshot: [] }

  try {
    const allTabs = await chrome.tabs.query({})
    const tab = allTabs.find((candidate) => candidate.id === entry.tabId)
    if (!tab) return { closed: false, snapshot: [] }

    const snapshot = snapshotChromeTabs([tab])
    await chrome.tabs.remove(entry.tabId)
    return { closed: true, snapshot }
  } catch {
    return { closed: false, snapshot: [] }
  }
}
