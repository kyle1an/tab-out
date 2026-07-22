import { queryAllTabsResult, removeTabs } from './browser-tabs-gateway.js'
import { snapshotChromeTabs } from './tabs.js'
import { pickFavicon, pickTabFavicon } from './favicons.js'
import { isSuspended } from './suspension.js'
import { focusExistingTabTargetResult, type ExistingTabFocusResult } from './tab-focus.js'
import { liveTabByValidatedId } from './live-tab-matching.js'
import type { TabHistoryEntry, TabHistorySnapshot, TabSnapshot, WorkingSetItem } from './types'
import type { ClosedTabEntry } from './closed-tabs.js'

const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'

export type TabHistoryFetchResult =
  | { ok: true; value: TabHistorySnapshot }
  | { ok: false; value: TabHistorySnapshot }

function emptySnapshot(): TabHistorySnapshot {
  return {
    stackSize: 0,
    pendingSize: 0,
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
  // copy. Older snapshots lack the explicit flag, so fall back to deriving
  // it from the URL pair.
  const suspended = entry?.suspended ?? isSuspended(rawUrl, url)
  const exists = !!entry?.exists
  const favIconUrl = String(entry?.favIconUrl || '')
  return {
    index: integerOr(entry?.index, index),
    tabId,
    windowId,
    exists,
    active: !!entry?.active,
    activeInOtherWindow: !!entry?.activeInOtherWindow,
    isApp: !!entry?.isApp,
    pinned: !!entry?.pinned,
    discarded: !!entry?.discarded,
    suspended,
    loading: exists && !suspended && !!entry?.loading,
    audible: !!entry?.audible,
    muted: !!entry?.muted,
    pending: !!entry?.pending,
    createdAt: integerOrNull(entry?.createdAt),
    cursor: !!entry?.cursor,
    current: !!entry?.current,
    previousTarget: !!entry?.previousTarget,
    nextTarget: !!entry?.nextTarget,
    title: String(entry?.title || (tabId === -1 ? 'Unknown tab' : `Tab ${tabId}`)),
    url,
    rawUrl,
    displayUrl: String(entry?.displayUrl || url || (tabId === -1 ? '' : `tab ${tabId}`)),
    favIconUrl: pickTabFavicon({ favIconUrl, url, suspended }) || pickFavicon({ favIconUrl, url }),
    lastActivatedAt: integerOrNull(entry?.lastActivatedAt)
  }
}

type HistoryEntryInput = Pick<TabHistoryEntry, 'tabId' | 'windowId' | 'title' | 'url' | 'rawUrl' | 'displayUrl' | 'favIconUrl'> & Partial<TabHistoryEntry>

/**
 * makeHistoryEntry — constructor for synthesized Activation History rows
 * (Working Set extras, recently-closed ghosts). Owns the row defaults so a
 * new TabHistoryEntry field is a one-place change; `suspended` derives from
 * the URL pair unless the caller knows better. Persisted snapshot rows go
 * through normalizeEntry above instead, which also repairs legacy shapes.
 */
export function makeHistoryEntry(entry: HistoryEntryInput): TabHistoryEntry {
  const result: TabHistoryEntry = {
    index: -1,
    exists: false,
    active: false,
    activeInOtherWindow: false,
    isApp: false,
    pinned: false,
    discarded: false,
    suspended: isSuspended(entry.rawUrl, entry.url),
    loading: false,
    pending: false,
    createdAt: null,
    cursor: false,
    current: false,
    previousTarget: false,
    nextTarget: false,
    lastActivatedAt: null,
    ...entry
  }
  result.loading = !!result.exists && !result.suspended && !!result.loading
  return result
}

/** historyEntryFromWorkingSetItem — adapt a Working Set item into a supplemental history row. */
export function historyEntryFromWorkingSetItem(item: WorkingSetItem): TabHistoryEntry {
  return makeHistoryEntry({
    tabId: item.tabId,
    windowId: item.windowId,
    exists: true,
    active: item.active,
    activeInOtherWindow: item.activeInOtherWindow,
    loading: item.loading,
    current: item.active && !item.activeInOtherWindow,
    title: item.title,
    url: item.tabUrl,
    rawUrl: item.rawUrl,
    displayUrl: item.displayUrl,
    favIconUrl: item.faviconUrl,
    audible: item.audible,
    muted: item.muted,
    lastActivatedAt: item.lastActivatedAt
  })
}

/** historyEntryFromClosedTab — adapt a recently-closed tab into a ghost history row. */
export function historyEntryFromClosedTab(closed: ClosedTabEntry): TabHistoryEntry {
  // A tab closed while suspended persisted the suspender's faded data: icon,
  // so recover the real favicon the same way live suspended rows do.
  const suspended = isSuspended(closed.rawUrl, closed.url)
  return makeHistoryEntry({
    tabId: -1,
    windowId: -1,
    title: closed.title,
    url: closed.url,
    rawUrl: closed.rawUrl,
    displayUrl: closed.displayUrl,
    favIconUrl: pickTabFavicon({ favIconUrl: closed.favIconUrl, url: closed.url, suspended })
  })
}

export function normalizeTabHistorySnapshot(snapshot: Partial<TabHistorySnapshot> | null | undefined): TabHistorySnapshot {
  if (!snapshot || !Array.isArray(snapshot.entries)) return emptySnapshot()
  const entries = snapshot.entries.map(normalizeEntry)
  return {
    stackSize: integerOr(snapshot.stackSize, entries.length),
    pendingSize: integerOr(snapshot.pendingSize, entries.filter((entry) => entry.pending).length),
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

async function sendHistoryMessageResult(message: Record<string, unknown>): Promise<TabHistoryFetchResult> {
  if (!globalThis.chrome?.runtime?.sendMessage) return { ok: false, value: emptySnapshot() }
  try {
    const response = await chrome.runtime.sendMessage(message)
    if (!response?.ok || !response.snapshot || !Array.isArray(response.snapshot.entries)) {
      return { ok: false, value: emptySnapshot() }
    }
    return { ok: true, value: normalizeTabHistorySnapshot(response.snapshot) }
  } catch {
    return { ok: false, value: emptySnapshot() }
  }
}

export function fetchTabHistorySnapshotResult(): Promise<TabHistoryFetchResult> {
  return sendHistoryMessageResult({ type: TAB_HISTORY_GET_MESSAGE })
}

export async function fetchTabHistorySnapshot(): Promise<TabHistorySnapshot> {
  return (await fetchTabHistorySnapshotResult()).value
}

export async function focusHistoryEntryResult(entry: TabHistoryEntry): Promise<ExistingTabFocusResult> {
  if (!entry?.exists) return { status: 'not-found' }
  return focusExistingTabTargetResult({
    tabId: entry.tabId,
    windowId: entry.windowId,
    url: entry.url,
    rawUrl: entry.rawUrl
  })
}

export async function focusHistoryEntry(entry: TabHistoryEntry): Promise<boolean> {
  return (await focusHistoryEntryResult(entry)).status === 'focused'
}

export type CloseHistoryEntryResult = {
  status: 'closed' | 'not-found' | 'unknown' | 'failed'
  closed: boolean
  snapshot: TabSnapshot[]
}

export async function closeHistoryEntry(entry: TabHistoryEntry): Promise<CloseHistoryEntryResult> {
  const tabId = entry?.tabId
  if (!entry?.exists || typeof tabId !== 'number' || !Number.isInteger(tabId)) {
    return { status: 'not-found', closed: false, snapshot: [] }
  }

  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) return { status: 'unknown', closed: false, snapshot: [] }

  const tab = liveTabByValidatedId(allTabsResult.value, {
    tabId,
    url: entry.url,
    rawUrl: entry.rawUrl
  })
  if (!tab) return { status: 'not-found', closed: false, snapshot: [] }

  // Activation History can contain Tab Out/new-tab rows. Preserve those URLs
  // in the Undo snapshot just like ordinary web tabs.
  const snapshot = snapshotChromeTabs([tab], { includeTabOutUrls: true })
  const removed = await removeTabs([tabId])
  if (removed.length === 0) return { status: 'failed', closed: false, snapshot: [] }
  return { status: 'closed', closed: true, snapshot }
}
