import { Effect, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { closeResolvedTabsEffect } from './tabs.js'
import { pickFavicon, pickTabFavicon } from './favicons.js'
import { isSuspended } from './suspension.js'
import { focusExistingTabTargetEffect, type ExistingTabFocusResult } from './tab-focus.js'
import { liveTabByValidatedId } from './live-tab-matching.js'
import { parseTabHistorySuccessResponse, TAB_HISTORY_GET_MESSAGE } from './runtime-messages.js'
import type { TabHistoryEntry, TabHistorySnapshot, TabSnapshot, WorkingSetItem } from './types'
import type { ClosedTabEntry } from './closed-tabs.js'

export type TabHistoryFetchResult =
  | { ok: true; value: TabHistorySnapshot }
  | { ok: false; value: TabHistorySnapshot }

const tabHistoryEntryCandidateSchema = Schema.Struct({
  index: Schema.optionalKey(Schema.Unknown),
  tabId: Schema.optionalKey(Schema.Unknown),
  windowId: Schema.optionalKey(Schema.Unknown),
  exists: Schema.optionalKey(Schema.Unknown),
  active: Schema.optionalKey(Schema.Unknown),
  activeInOtherWindow: Schema.optionalKey(Schema.Unknown),
  isApp: Schema.optionalKey(Schema.Unknown),
  pinned: Schema.optionalKey(Schema.Unknown),
  discarded: Schema.optionalKey(Schema.Unknown),
  suspended: Schema.optionalKey(Schema.Unknown),
  loading: Schema.optionalKey(Schema.Unknown),
  audible: Schema.optionalKey(Schema.Unknown),
  muted: Schema.optionalKey(Schema.Unknown),
  pending: Schema.optionalKey(Schema.Unknown),
  createdAt: Schema.optionalKey(Schema.Unknown),
  cursor: Schema.optionalKey(Schema.Unknown),
  current: Schema.optionalKey(Schema.Unknown),
  previousTarget: Schema.optionalKey(Schema.Unknown),
  nextTarget: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.Unknown),
  url: Schema.optionalKey(Schema.Unknown),
  rawUrl: Schema.optionalKey(Schema.Unknown),
  displayUrl: Schema.optionalKey(Schema.Unknown),
  favIconUrl: Schema.optionalKey(Schema.Unknown),
  lastActivatedAt: Schema.optionalKey(Schema.Unknown)
})

const tabHistorySnapshotCandidateSchema = Schema.Struct({
  stackSize: Schema.optionalKey(Schema.Unknown),
  pendingSize: Schema.optionalKey(Schema.Unknown),
  maxSize: Schema.optionalKey(Schema.Unknown),
  cursorIndex: Schema.optionalKey(Schema.Unknown),
  currentIndex: Schema.optionalKey(Schema.Unknown),
  previousIndex: Schema.optionalKey(Schema.Unknown),
  nextIndex: Schema.optionalKey(Schema.Unknown),
  activeTabId: Schema.optionalKey(Schema.Unknown),
  activeWindowId: Schema.optionalKey(Schema.Unknown),
  activeWasInserted: Schema.optionalKey(Schema.Unknown),
  entries: Schema.Array(Schema.Unknown)
})

const isTabHistoryEntryCandidate = Schema.is(tabHistoryEntryCandidateSchema)
const isTabHistorySnapshotCandidate = Schema.is(tabHistorySnapshotCandidateSchema)
const HISTORY_ENTRY_NOT_FOUND: ExistingTabFocusResult = { status: 'not-found' }

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

function normalizeEntry(value: unknown, index: number): TabHistoryEntry {
  const entry = isTabHistoryEntryCandidate(value) ? value : {}
  const tabId = integerOr(entry.tabId, -1)
  const windowId = integerOr(entry.windowId, -1)
  const url = String(entry.url || '')
  const rawUrl = String(entry.rawUrl || url)
  // A suspended row's favIconUrl is the suspender page's faded data: icon —
  // recover the real favicon by the unwrapped url instead of keeping that
  // copy. Older snapshots lack the explicit flag, so fall back to deriving
  // it from the URL pair.
  const suspended = typeof entry.suspended === 'boolean'
    ? entry.suspended
    : isSuspended(rawUrl, url)
  const exists = !!entry.exists
  const favIconUrl = String(entry.favIconUrl || '')
  return {
    index: integerOr(entry.index, index),
    tabId,
    windowId,
    exists,
    active: !!entry.active,
    activeInOtherWindow: !!entry.activeInOtherWindow,
    isApp: !!entry.isApp,
    pinned: !!entry.pinned,
    discarded: !!entry.discarded,
    suspended,
    loading: exists && !suspended && !!entry.loading,
    audible: !!entry.audible,
    muted: !!entry.muted,
    pending: !!entry.pending,
    createdAt: integerOrNull(entry.createdAt),
    cursor: !!entry.cursor,
    current: !!entry.current,
    previousTarget: !!entry.previousTarget,
    nextTarget: !!entry.nextTarget,
    title: String(entry.title || (tabId === -1 ? 'Unknown tab' : `Tab ${tabId}`)),
    url,
    rawUrl,
    displayUrl: String(entry.displayUrl || url || (tabId === -1 ? '' : `tab ${tabId}`)),
    favIconUrl: pickTabFavicon({ favIconUrl, url, suspended }) || pickFavicon({ favIconUrl, url }),
    lastActivatedAt: integerOrNull(entry.lastActivatedAt)
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
    ...(item.loading === undefined ? {} : { loading: item.loading }),
    current: item.active && !item.activeInOtherWindow,
    title: item.title,
    url: item.tabUrl,
    rawUrl: item.rawUrl,
    displayUrl: item.displayUrl,
    favIconUrl: item.faviconUrl,
    ...(item.audible === undefined ? {} : { audible: item.audible }),
    ...(item.muted === undefined ? {} : { muted: item.muted }),
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

export function normalizeTabHistorySnapshot(value: unknown): TabHistorySnapshot {
  if (!isTabHistorySnapshotCandidate(value)) return emptySnapshot()
  const entries = value.entries.map(normalizeEntry)
  return {
    stackSize: integerOr(value.stackSize, entries.length),
    pendingSize: integerOr(value.pendingSize, entries.filter((entry) => entry.pending).length),
    maxSize: integerOr(value.maxSize, 0),
    cursorIndex: integerOr(value.cursorIndex, -1),
    currentIndex: integerOr(value.currentIndex, -1),
    previousIndex: integerOr(value.previousIndex, -1),
    nextIndex: integerOr(value.nextIndex, -1),
    activeTabId: integerOrNull(value.activeTabId),
    activeWindowId: integerOrNull(value.activeWindowId),
    activeWasInserted: !!value.activeWasInserted,
    entries
  }
}

async function sendHistoryMessageResult(message: Record<string, unknown>): Promise<TabHistoryFetchResult> {
  if (!globalThis.chrome?.runtime?.sendMessage) return { ok: false, value: emptySnapshot() }
  try {
    const response = await chrome.runtime.sendMessage(message)
    const snapshot = parseTabHistorySuccessResponse(response)
    return snapshot === null
      ? { ok: false, value: emptySnapshot() }
      : { ok: true, value: normalizeTabHistorySnapshot(snapshot) }
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

const focusHistoryEntryEffect = Effect.fn('tabHistory.focusEntry')(function*(entry: TabHistoryEntry) {
  if (!entry?.exists) return HISTORY_ENTRY_NOT_FOUND
  return yield* focusExistingTabTargetEffect({
    tabId: entry.tabId,
    windowId: entry.windowId,
    url: entry.url,
    rawUrl: entry.rawUrl
  })
})

export function focusHistoryEntryResult(entry: TabHistoryEntry): Promise<ExistingTabFocusResult> {
  return getAppRuntime().runPromise(focusHistoryEntryEffect(entry))
}

export type CloseHistoryEntryResult = {
  status: 'closed' | 'not-found' | 'unknown' | 'failed'
  closed: boolean
  snapshot: TabSnapshot[]
}

function closeHistoryEntryResult(
  status: CloseHistoryEntryResult['status'],
  snapshot: TabSnapshot[] = []
): CloseHistoryEntryResult {
  return { status, closed: status === 'closed', snapshot }
}

const closeHistoryEntryEffect = Effect.fn('tabHistory.closeEntry')(function*(entry: TabHistoryEntry) {
  const tabId = entry?.tabId
  if (!entry?.exists || typeof tabId !== 'number' || !Number.isInteger(tabId)) {
    return closeHistoryEntryResult('not-found')
  }

  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) return closeHistoryEntryResult('unknown')

  const tab = liveTabByValidatedId(allTabsResult.value, {
    tabId,
    url: entry.url,
    rawUrl: entry.rawUrl
  })
  if (!tab) return closeHistoryEntryResult('not-found')

  // Activation History can contain Tab Out/new-tab rows. Preserve those URLs
  // in the Undo snapshot just like ordinary web tabs.
  const closeResult = yield* closeResolvedTabsEffect([tab], { includeTabOutUrls: true })
  if (closeResult.removedCount === 0) return closeHistoryEntryResult('failed')
  return closeHistoryEntryResult('closed', closeResult.value)
})

export function closeHistoryEntry(entry: TabHistoryEntry): Promise<CloseHistoryEntryResult> {
  return getAppRuntime().runPromise(closeHistoryEntryEffect(entry))
}
