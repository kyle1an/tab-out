/* ================================================================
   Chrome tabs — fetch / close / focus / snapshot

   `openTabs` is the module-private in-memory cache of all open
   tabs, refreshed by fetchOpenTabsSnapshot() and kept for title
   retention across suspensions, reloads, and startup seeding.
   Consumers receive tab snapshots as explicit inputs instead of
   reading this cache.
   ================================================================ */

import { createTab, createWindow, getAllWindowsResult, getCurrentWindowResult, getTab, queryAllTabsResult, removeTabs } from './browser-tabs-gateway.js'
import { normalizeChromeTabToDashboardItem } from './dashboard-tab-normalization.js'
import { rememberSuspendTargetFromTabs, unwrapSuspenderUrl } from './suspension.js'
import { isGroupedTab, fetchTabGroupColors } from './groups.js'
import { pickDuplicateTabsToClose } from './tab-dedupe-policy.js'
import { canonicalDedupeKey } from './url-canonical.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import { focusExactTabTargetResult, focusTabTarget } from './tab-focus.js'
import { isBrowserInternalUrl } from './browser-url-policy.js'
import { liveTabByValidatedId, liveTabUrlForIdentity } from './live-tab-matching.js'
import type { DashboardTab, DashboardTabMutationTarget, TabSnapshot } from './types'

type SnapshotTab = Pick<chrome.tabs.Tab, 'url' | 'pendingUrl' | 'title' | 'pinned' | 'groupId' | 'windowId' | 'index'>
type SnapshotOptions = {
  includeTabOutUrls?: boolean
}
type CloseOptions = {
  preserveGroups?: boolean
  preservePinnedTabOut?: boolean
}
type DedupeOptions = {
  currentWindowId?: number
  preservePinned?: boolean
  preservePinnedTabOut?: boolean
}
export type ChromeOpenTabsSnapshot = {
  tabs: chrome.tabs.Tab[]
  windows: chrome.windows.Window[]
}
export type OpenTabsFetchResult = {
  ok: boolean
  tabs: DashboardTab[]
}
type TabCloseMutationStatus = 'complete' | 'partial' | 'failed' | 'unknown'
export type TabCloseResult = {
  ok: boolean
  status: TabCloseMutationStatus
  value: TabSnapshot[]
  attemptedCount: number
  removedCount: number
  failedCount: number
}

let openTabs: DashboardTab[] = []
let seededOpenTabsTitleHistory: DashboardTab[] = []

function tabIds(tabs: chrome.tabs.Tab[]): number[] {
  return tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number')
}

/**
 * snapshotChromeTabs(chromeTabs) — captures enough info per tab to
 * recreate it later via chrome.tabs.create() (used by undo). `url` is
 * the effective URL used by the dashboard for matching; `rawUrl` is
 * Chrome's actual tab URL, which lets undo preserve suspended tabs.
 * Skips chrome:// and chrome-extension:// URLs by default since those
 * aren't worth recreating, except for Tab Out's new-tab URLs when the
 * caller explicitly opts in.
 *
 * @param {Array<{ url?: string, pendingUrl?: string, title?: string, pinned?: boolean, groupId?: number, windowId: number, index?: number }>} chromeTabs
 * @param {{ includeTabOutUrls?: boolean }} [opts]
 * @returns {TabSnapshot[]}
 */
export function snapshotChromeTabs(chromeTabs: SnapshotTab[], opts: SnapshotOptions = {}): TabSnapshot[] {
  const { includeTabOutUrls = false } = opts
  return chromeTabs
    .map((t) => {
      const rawUrl = liveTabUrlForIdentity(t)
      return {
        url: unwrapSuspenderUrl(rawUrl),
        rawUrl,
        title: t.title || '',
        pinned: !!t.pinned,
        groupId: typeof t.groupId === 'number' ? t.groupId : -1,
        windowId: t.windowId,
        ...(typeof t.index === 'number' ? { index: t.index } : {})
      }
    })
    .filter((s) => {
      if (!s.url) return false
      if (s.url.startsWith('chrome://')) return includeTabOutUrls && s.url === 'chrome://newtab/'
      if (!s.url.startsWith('chrome-extension://')) return true
      return includeTabOutUrls && isTabOutPageUrl(s.url)
    })
}

async function fetchChromeOpenTabsSnapshot(): Promise<{ ok: boolean; snapshot: ChromeOpenTabsSnapshot }> {
  const [tabsResult, windowsResult] = await Promise.all([
    queryAllTabsResult(),
    getAllWindowsResult(),
    fetchTabGroupColors()
  ])
  return {
    ok: tabsResult.ok && windowsResult.ok,
    snapshot: { tabs: tabsResult.value, windows: windowsResult.value }
  }
}

export function normalizeChromeOpenTabs({ tabs, windows }: ChromeOpenTabsSnapshot, previousTabs: readonly DashboardTab[] = []): DashboardTab[] {
  const windowTypeById = new Map(windows.filter((w) => typeof w.id === 'number').map((w) => [w.id, w.type]))
  const previousTabById = new Map(
    previousTabs
      .filter((tab): tab is DashboardTab & { id: number } => typeof tab.id === 'number')
      .map((tab) => [tab.id, tab] as const)
  )
  const runtimeId = globalThis.chrome?.runtime?.id ?? null
  return tabs.map((tab) => {
    const previousTab = typeof tab.id === 'number' ? previousTabById.get(tab.id) : undefined
    const windowType = windowTypeById.get(tab.windowId)
    return normalizeChromeTabToDashboardItem(tab, {
      ...(previousTab ? { previousTab } : {}),
      runtimeId,
      ...(windowType === undefined ? {} : { windowType })
    })
  })
}

function replaceOpenTabs(nextOpenTabs: DashboardTab[]): void {
  openTabs = nextOpenTabs
}

export function seedOpenTabsTitleHistory(tabs: readonly DashboardTab[]): void {
  if (openTabs.length > 0 || seededOpenTabsTitleHistory.length > 0) return
  seededOpenTabsTitleHistory = tabs.filter((tab) => typeof tab.id === 'number')
}

export async function fetchOpenTabsSnapshotResult(
  capturedBrowserSnapshot: ChromeOpenTabsSnapshot | null = null
): Promise<OpenTabsFetchResult> {
  const fallbackTabs = openTabs.length > 0 ? openTabs : seededOpenTabsTitleHistory
  try {
    let result: { ok: boolean; snapshot: ChromeOpenTabsSnapshot }
    if (capturedBrowserSnapshot) {
      await fetchTabGroupColors()
      result = { ok: true, snapshot: capturedBrowserSnapshot }
    } else {
      result = await fetchChromeOpenTabsSnapshot()
    }
    if (!result.ok) return { ok: false, tabs: fallbackTabs }
    const previousTabs = openTabs.length > 0 ? openTabs : seededOpenTabsTitleHistory
    const nextOpenTabs = normalizeChromeOpenTabs(result.snapshot, previousTabs)
    seededOpenTabsTitleHistory = []
    replaceOpenTabs(nextOpenTabs)
    rememberSuspendTargetFromTabs(nextOpenTabs)
    return { ok: true, tabs: nextOpenTabs }
  } catch {
    return { ok: false, tabs: fallbackTabs }
  }
}

export async function fetchOpenTabsSnapshot(): Promise<DashboardTab[]> {
  return (await fetchOpenTabsSnapshotResult()).tabs
}

export function getDashboardTabsFromOpenTabs(tabs: readonly DashboardTab[]): DashboardTab[] {
  return tabs.filter((tab) => {
    if (tab.isTabOut) return true
    return !isBrowserInternalUrl(tab.url)
  })
}

function emptyTabCloseResult(status: 'complete' | 'unknown'): TabCloseResult {
  return {
    ok: status === 'complete',
    status,
    value: [],
    attemptedCount: 0,
    removedCount: 0,
    failedCount: 0
  }
}

/**
 * Close an already-resolved physical-tab set and report the exact accepted and
 * rejected writes. `value` contains Undo snapshots for confirmed removals.
 */
export async function closeResolvedTabsResult(
  tabs: readonly chrome.tabs.Tab[],
  { includeTabOutUrls = false }: SnapshotOptions = {}
): Promise<TabCloseResult> {
  const seenIds = new Set<number>()
  const attemptedTabs = tabs.filter((tab) => {
    if (typeof tab.id !== 'number' || seenIds.has(tab.id)) return false
    seenIds.add(tab.id)
    return true
  })
  if (attemptedTabs.length === 0) return emptyTabCloseResult('complete')

  const attemptedTabsById = new Map(
    attemptedTabs.map((tab) => [tab.id as number, tab])
  )
  const removedIds = new Set(await removeTabs(tabIds(attemptedTabs), {
    // A rejected batch introduces one await per retry. Revalidate the original
    // physical page immediately before each of those delayed single-ID writes
    // so a navigation or reused ID cannot turn a stale close into data loss.
    beforeSingleRemove: async (tabId) => {
      const expectedTab = attemptedTabsById.get(tabId)
      const liveTab = await getTab(tabId)
      if (!expectedTab || !liveTab) return false
      return !!liveTabByValidatedId([liveTab], {
        tabId,
        url: liveTabUrlForIdentity(expectedTab)
      })
    }
  }))
  const removedTabs = attemptedTabs.filter((tab) => typeof tab.id === 'number' && removedIds.has(tab.id))
  const removedCount = removedTabs.length
  const failedCount = attemptedTabs.length - removedCount
  const status: TabCloseMutationStatus = failedCount === 0
    ? 'complete'
    : removedCount === 0 ? 'failed' : 'partial'

  return {
    ok: status === 'complete',
    status,
    value: snapshotChromeTabs(removedTabs, { includeTabOutUrls }),
    attemptedCount: attemptedTabs.length,
    removedCount,
    failedCount
  }
}

/**
 * closeTabsExactResult(urls, opts) — closes tabs by exact URL match.
 * Used for filter-narrowed bulk close paths so we don't accidentally
 * close unrelated tabs from the same hostname.
 *
 * @param {string[]} urls
 * Pinned Tab Out/new-tab pages are preserved by default. Their URL is shared
 * with ordinary Tab Out copies, so URL-scoped bulk actions must apply that
 * physical-tab policy again after reading the live tabs.
 *
 * @param {{ preserveGroups?: boolean, preservePinnedTabOut?: boolean }} [opts]
 * @returns {Promise<TabCloseResult>} confirmed snapshots plus mutation status
 * and attempted, removed, and failed counts
 */
export async function closeTabsExactResult(
  urls: string[],
  opts: CloseOptions = {}
): Promise<TabCloseResult> {
  if (!urls || urls.length === 0) return emptyTabCloseResult('complete')
  const { preserveGroups = false, preservePinnedTabOut = true } = opts
  const urlSet = new Set(urls)
  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) return emptyTabCloseResult('unknown')
  const allTabs = allTabsResult.value
  const toCloseTabs = allTabs.filter((tab) => {
    const effectiveUrl = unwrapSuspenderUrl(liveTabUrlForIdentity(tab))
    if (!urlSet.has(effectiveUrl)) return false
    if (preserveGroups && isGroupedTab(tab)) return false
    return !(preservePinnedTabOut && tab.pinned && isTabOutPageUrl(effectiveUrl))
  })
  return closeResolvedTabsResult(toCloseTabs, { includeTabOutUrls: true })
}

/**
 * Close an exact render-derived set. The URL guard prevents a stale tab id
 * (including one revived from a startup snapshot after an id reuse) from
 * closing a page that no longer matches the action the user selected. Returns
 * confirmed snapshots plus mutation status and attempted/removed/failed counts.
 */
export async function closeTabsByTargetsResult(
  targets: readonly DashboardTabMutationTarget[],
  opts: CloseOptions = {}
): Promise<TabCloseResult> {
  if (targets.length === 0) return emptyTabCloseResult('complete')
  const { preserveGroups = false, preservePinnedTabOut = true } = opts
  const expectedUrlById = new Map(targets.map((target) => [target.tabId, target.tabUrl]))
  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) return emptyTabCloseResult('unknown')
  const allTabs = allTabsResult.value
  const toCloseTabs = allTabs.filter((tab) => {
    if (typeof tab.id !== 'number') return false
    const expectedUrl = expectedUrlById.get(tab.id)
    if (!expectedUrl) return false
    const effectiveUrl = unwrapSuspenderUrl(liveTabUrlForIdentity(tab))
    if (effectiveUrl !== expectedUrl) return false
    if (preserveGroups && isGroupedTab(tab)) return false
    return !(preservePinnedTabOut && tab.pinned && isTabOutPageUrl(effectiveUrl))
  })
  return closeResolvedTabsResult(toCloseTabs, { includeTabOutUrls: true })
}

/**
 * focusTab(url) — switch Chrome to the tab matching `url` (exact first,
 * hostname fallback) and focus its window.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function focusTab(url: string): Promise<boolean> {
  return focusTabTarget(url)
}

export type ExactTabFocusOrOpenResult =
  | { status: 'focused' | 'activated' | 'failed' | 'unknown' }
  | { status: 'opened' | 'open-failed' }

/** Open only when a successful browser read proves no matching tab exists. */
export async function focusExactTabOrOpenResult(url: string): Promise<ExactTabFocusOrOpenResult> {
  const result = await focusExactTabTargetResult(url)
  if (result.status === 'not-found') {
    return { status: await openTabUrl(url) ? 'opened' : 'open-failed' }
  }
  return { status: result.status }
}

/**
 * openTabUrl(url, opts) — open a URL in a new tab in the current window.
 * Defaults to an active (foreground) tab; pass { active: false } to open it
 * in the background and keep the current tab focused.
 *
 * @param {string} url
 * @param {{ active?: boolean }} [opts]
 * @returns {Promise<boolean>} whether Chrome created the tab
 */
export async function openTabUrl(url: string, opts: { active?: boolean } = {}): Promise<boolean> {
  if (!url) return false
  const { active = true } = opts
  return !!(await createTab({ url, active }))
}

/**
 * openTabUrlInNewWindow(url) — open a URL in a new focused Chrome window.
 *
 * @param {string} url
 * @returns {Promise<boolean>} whether Chrome created the window
 */
export async function openTabUrlInNewWindow(url: string): Promise<boolean> {
  if (!url) return false
  return !!(await createWindow({ url, focused: true, type: 'normal' }))
}

/**
 * closeDuplicateTabsResult(urls, keepOne) — closes duplicate tabs of each
 * URL according to the dedup policy (mirrors renderDomainCard's button
 * count math):
 *   • Mixed grouped + ungrouped → close every ungrouped (grouped is the keep).
 *   • All ungrouped (≥2)        → keep one ungrouped, close the rest.
 *   • All grouped, single group → keep one, close the rest within that group.
 *   • All grouped, multi groups → skip (would empty a slot in each group).
 * Returns confirmed Undo snapshots plus mutation status and
 * attempted/removed/failed counts.
 *
 * @param {string[]} urls
 * @param {boolean} [keepOne=true]
 * @param {{ currentWindowId?: number, preservePinned?: boolean, preservePinnedTabOut?: boolean }} [opts]
 * @returns {Promise<TabCloseResult>}
 */
export async function closeDuplicateTabsResult(
  urls: string[],
  keepOne = true,
  opts: DedupeOptions = {}
): Promise<TabCloseResult> {
  const requestedUrls = [...new Set(urls.map(canonicalDedupeKey).filter(Boolean))]
  if (requestedUrls.length === 0) return emptyTabCloseResult('complete')
  const { preservePinned = false, preservePinnedTabOut = false } = opts
  const suppliedCurrentWindowId = opts.currentWindowId
  const hasSuppliedCurrentWindow =
    typeof suppliedCurrentWindowId === 'number' &&
    Number.isInteger(suppliedCurrentWindowId) &&
    suppliedCurrentWindowId >= 0
  let currentWindowId = hasSuppliedCurrentWindow
    ? suppliedCurrentWindowId
    : -1
  let currentWindowKnown = currentWindowId >= 0
  if (!currentWindowKnown) {
    const currentWindowResult = await getCurrentWindowResult()
    currentWindowId = currentWindowResult.value?.id ?? -1
    currentWindowKnown = currentWindowResult.ok && currentWindowId >= 0
  }
  if (!currentWindowKnown && requestedUrls.some((url) => isTabOutPageUrl(url))) {
    return emptyTabCloseResult('unknown')
  }
  // Keep the live-tab inventory as the final awaited read before selecting
  // removals. A slow current-window lookup must not leave a stale URL snapshot
  // that can close a tab which started navigating in the meantime.
  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) return emptyTabCloseResult('unknown')
  const allTabs = allTabsResult.value
  const requestedUrlSet = new Set(requestedUrls)
  const tabsByDedupeKey = new Map<string, chrome.tabs.Tab[]>()
  for (const tab of allTabs) {
    const key = canonicalDedupeKey(unwrapSuspenderUrl(liveTabUrlForIdentity(tab)))
    if (!requestedUrlSet.has(key)) continue
    tabsByDedupeKey.getOrInsertComputed(key, () => []).push(tab)
  }
  const toCloseTabs: chrome.tabs.Tab[] = []

  for (const url of requestedUrls) {
    const matching = tabsByDedupeKey.get(url) ?? []
    toCloseTabs.push(
      ...pickDuplicateTabsToClose(matching, {
        keepOne,
        currentWindowId,
        preservePinned,
        preservePinnedTabOut,
        isTabOutUrl: isTabOutPageUrl
      })
    )
  }

  return closeResolvedTabsResult(toCloseTabs, { includeTabOutUrls: true })
}
