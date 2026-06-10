/* ================================================================
   Chrome tabs — fetch / close / focus / snapshot

   `openTabs` is the canonical in-memory cache of all open tabs.
   It's exported as a `let` binding so importers see updates after
   each fetchOpenTabs() call (ES module live bindings). Use
   getRealTabs() to get a filtered subset (skips chrome://, about:,
   extension pages).
   ================================================================ */

import { unwrapSuspenderUrl, unwrapSuspenderTitle } from './suspender.js'
import { rememberSuspendTargetFromTabs } from './suspend-target.js'
import { isGroupedTab, fetchTabGroupColors } from './groups.js'
import { pickDuplicateTabsToClose } from './tab-dedupe-policy.js'
import { focusExactTabTarget, focusTabTarget } from './tab-focus.js'
import type { DashboardTab, TabSnapshot } from './types'

type SnapshotTab = Pick<chrome.tabs.Tab, 'url' | 'title' | 'pinned' | 'groupId' | 'windowId' | 'index'>
type SnapshotOptions = {
  includeTabOutUrls?: boolean
}
type CloseOptions = {
  preserveGroups?: boolean
}
type DedupeOptions = {
  preservePinned?: boolean
  preservePinnedTabOut?: boolean
}
export type ChromeOpenTabsSnapshot = {
  tabs: chrome.tabs.Tab[]
  windows: chrome.windows.Window[]
}

export let openTabs: DashboardTab[] = []

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
 * @param {Array<{ url?: string, title?: string, pinned?: boolean, groupId?: number, windowId: number, index?: number }>} chromeTabs
 * @param {{ includeTabOutUrls?: boolean }} [opts]
 * @returns {TabSnapshot[]}
 */
export function snapshotChromeTabs(chromeTabs: SnapshotTab[], opts: SnapshotOptions = {}): TabSnapshot[] {
  const { includeTabOutUrls = false } = opts
  return chromeTabs
    .map((t) => ({
      url: unwrapSuspenderUrl(t.url || ''),
      rawUrl: t.url || '',
      title: t.title || '',
      pinned: !!t.pinned,
      groupId: typeof t.groupId === 'number' ? t.groupId : -1,
      windowId: t.windowId,
      index: typeof t.index === 'number' ? t.index : undefined
    }))
    .filter((s) => {
      if (!s.url) return false
      if (s.url.startsWith('chrome://')) return includeTabOutUrls && s.url === 'chrome://newtab/'
      if (!s.url.startsWith('chrome-extension://')) return true
      return includeTabOutUrls && isTabOutUrl(s.url)
    })
}

export async function fetchChromeOpenTabsSnapshot(): Promise<ChromeOpenTabsSnapshot> {
  const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll(), fetchTabGroupColors()])
  return { tabs, windows }
}

export function normalizeChromeOpenTabs({ tabs, windows }: ChromeOpenTabsSnapshot): DashboardTab[] {
  const windowTypeById = new Map(windows.filter((w) => typeof w.id === 'number').map((w) => [w.id, w.type]))
  return tabs.map((t) => {
    const rawUrl = t.url || ''
    const effectiveUrl = unwrapSuspenderUrl(rawUrl)
    const suspended = rawUrl !== effectiveUrl
    // For suspended tabs, Chrome's tab.title is unreliable — it can
    // be the full suspender URL, empty, or stale — but the suspender
    // always stores the original page title in the `ttl=` fragment
    // param. Prefer that when it's available so the chip renders
    // the real page title instead of `chrome-extension://.../...`.
    let title = t.title || ''
    if (suspended) {
      const suspenderTitle = unwrapSuspenderTitle(rawUrl)
      if (suspenderTitle) title = suspenderTitle
    }
    const windowType = windowTypeById.get(t.windowId)
    return {
      id: t.id,
      url: effectiveUrl,
      rawUrl: rawUrl,
      suspended,
      title,
      favIconUrl: t.favIconUrl || '',
      audible: !!t.audible,
      muted: !!t.mutedInfo?.muted,
      windowId: t.windowId,
      active: t.active,
      pinned: t.pinned,
      groupId: typeof t.groupId === 'number' ? t.groupId : -1,
      isTabOut: isTabOutUrl(rawUrl),
      isApp: windowType === 'app' || windowType === 'popup',
      index: t.index
    }
  })
}

export function replaceOpenTabs(nextOpenTabs: DashboardTab[]): void {
  openTabs = nextOpenTabs
}

export async function fetchOpenTabsSnapshot(): Promise<DashboardTab[]> {
  try {
    const snapshot = await fetchChromeOpenTabsSnapshot()
    const nextOpenTabs = normalizeChromeOpenTabs(snapshot)
    replaceOpenTabs(nextOpenTabs)
    rememberSuspendTargetFromTabs(nextOpenTabs)
    return nextOpenTabs
  } catch {
    replaceOpenTabs([])
    return []
  }
}

/**
 * fetchOpenTabs() — refreshes `openTabs` from chrome.tabs.query(),
 * normalizing each tab into our internal shape. Suspended tabs get
 * `url` = unwrapped real URL, `rawUrl` = Chrome's actual URL.
 *
 * @returns {Promise<void>}
 */
export async function fetchOpenTabs(): Promise<void> {
  await fetchOpenTabsSnapshot()
}

/**
 * getRealTabs() — `openTabs` minus chrome://, extension pages, about:,
 * etc. The grid only ever shows real web pages.
 *
 * @returns {DashboardTab[]}
 */
export function getRealTabs(): DashboardTab[] {
  return openTabs.filter((t) => {
    const url = t.url || ''
    return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:') && !url.startsWith('edge://') && !url.startsWith('brave://')
  })
}

export function getDashboardTabsFromOpenTabs(tabs: readonly DashboardTab[]): DashboardTab[] {
  return tabs.filter((t) => {
    if (t.isTabOut) return true
    const url = t.url || ''
    return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:') && !url.startsWith('edge://') && !url.startsWith('brave://')
  })
}

/**
 * getDashboardTabs() — tabs shown in the dashboard tab source:
 * real web tabs plus Tab Out / Chrome new-tab pages, so the user can
 * explicitly dedupe dashboard tabs from the page itself.
 *
 * @returns {DashboardTab[]}
 */
export function getDashboardTabs(): DashboardTab[] {
  return getDashboardTabsFromOpenTabs(openTabs)
}

/**
 * closeTabsByUrls(urls, opts) — closes tabs whose hostname matches any
 * of the given URLs. file:// URLs are matched exactly (no hostname).
 * Returns a snapshot of what was closed for undo.
 *
 * @param {string[]} urls
 * @param {{ preserveGroups?: boolean }} [opts]
 * @returns {Promise<TabSnapshot[]>}
 */
export async function closeTabsByUrls(urls: string[], opts: CloseOptions = {}): Promise<TabSnapshot[]> {
  if (!urls || urls.length === 0) return []
  const { preserveGroups = false } = opts

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames: string[] = []
  const exactUrls = new Set<string>()

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u)
    } else {
      try {
        targetHostnames.push(new URL(u).hostname)
      } catch {
        /* skip unparseable */
      }
    }
  }

  const allTabs = await chrome.tabs.query({})
  const toCloseTabs = allTabs.filter((tab) => {
    if (preserveGroups && isGroupedTab(tab)) return false
    const tabUrl = unwrapSuspenderUrl(tab.url || '')
    if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true
    try {
      const tabHostname = new URL(tabUrl).hostname
      return tabHostname && targetHostnames.includes(tabHostname)
    } catch {
      return false
    }
  })

  const snapshot = snapshotChromeTabs(toCloseTabs)
  if (toCloseTabs.length > 0) await chrome.tabs.remove(tabIds(toCloseTabs))
  await fetchOpenTabs()
  return snapshot
}

/**
 * closeTabsExact(urls, opts) — closes tabs by exact URL match.
 * Used for filter-narrowed bulk close paths so we don't accidentally
 * close unrelated tabs from the same hostname.
 *
 * @param {string[]} urls
 * @param {{ preserveGroups?: boolean }} [opts]
 * @returns {Promise<TabSnapshot[]>}
 */
export async function closeTabsExact(urls: string[], opts: CloseOptions = {}): Promise<TabSnapshot[]> {
  if (!urls || urls.length === 0) return []
  const { preserveGroups = false } = opts
  const urlSet = new Set(urls)
  const allTabs = await chrome.tabs.query({})
  const toCloseTabs = allTabs.filter((t) => !(preserveGroups && isGroupedTab(t)) && urlSet.has(unwrapSuspenderUrl(t.url)))
  const snapshot = snapshotChromeTabs(toCloseTabs)
  if (toCloseTabs.length > 0) await chrome.tabs.remove(tabIds(toCloseTabs))
  await fetchOpenTabs()
  return snapshot
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

/**
 * focusExactTab(url) — focus an already-open tab whose effective URL matches
 * exactly. Unlike focusTab(), this does not fall back to hostname matching.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function focusExactTab(url: string): Promise<boolean> {
  return focusExactTabTarget(url)
}

/**
 * openTabUrl(url, opts) — open a URL in a new tab in the current window.
 * Defaults to an active (foreground) tab; pass { active: false } to open it
 * in the background and keep the current tab focused.
 *
 * @param {string} url
 * @param {{ active?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export async function openTabUrl(url: string, opts: { active?: boolean } = {}): Promise<void> {
  if (!url) return
  const { active = true } = opts
  try {
    await chrome.tabs.create({ url, active })
  } catch {}
}

function isTabOutUrl(url?: string): boolean {
  const extensionId = globalThis.chrome?.runtime?.id
  if (url === 'chrome://newtab/') return true
  if (!extensionId) return false
  const tabOutUrl = `chrome-extension://${extensionId}/index.html`
  return url === tabOutUrl || !!url?.startsWith(`${tabOutUrl}?`) || !!url?.startsWith(`${tabOutUrl}#`)
}

/**
 * closeDuplicateTabs(urls, keepOne) — closes duplicate tabs of each
 * URL according to the dedup policy (mirrors renderDomainCard's button
 * count math):
 *   • Mixed grouped + ungrouped → close every ungrouped (grouped is the keep).
 *   • All ungrouped (≥2)        → keep one ungrouped, close the rest.
 *   • All grouped, single group → keep one, close the rest within that group.
 *   • All grouped, multi groups → skip (would empty a slot in each group).
 * Returns a snapshot of what was closed for undo.
 *
 * @param {string[]} urls
 * @param {boolean} [keepOne=true]
 * @param {{ preservePinned?: boolean, preservePinnedTabOut?: boolean }} [opts]
 * @returns {Promise<TabSnapshot[]>}
 */
export async function closeDuplicateTabs(urls: string[], keepOne = true, opts: DedupeOptions = {}): Promise<TabSnapshot[]> {
  const { preservePinned = false, preservePinnedTabOut = false } = opts
  const allTabs = await chrome.tabs.query({})
  let currentWindowId = -1
  try {
    currentWindowId = (await chrome.windows.getCurrent()).id ?? -1
  } catch {}
  const toCloseTabs: chrome.tabs.Tab[] = []

  for (const url of urls) {
    const matching = allTabs.filter((t) => unwrapSuspenderUrl(t.url) === url)
    toCloseTabs.push(
      ...pickDuplicateTabsToClose(matching, {
        keepOne,
        currentWindowId,
        preservePinned,
        preservePinnedTabOut,
        isTabOutUrl
      })
    )
  }

  const snapshot = snapshotChromeTabs(toCloseTabs, { includeTabOutUrls: preservePinnedTabOut })
  if (toCloseTabs.length > 0) await chrome.tabs.remove(tabIds(toCloseTabs))
  await fetchOpenTabs()
  return snapshot
}
