/* ================================================================
   Chrome tabs — fetch / close / focus / snapshot

   `openTabs` is the canonical in-memory cache of all open tabs.
   It's exported as a `let` binding so importers see updates after
   each fetchOpenTabs() call (ES module live bindings). Use
   getRealTabs() to get a filtered subset (skips chrome://, about:,
   extension pages).
   ================================================================ */

import { unwrapSuspenderUrl, unwrapSuspenderTitle } from './suspender.js'
import { isGroupedTab, fetchTabGroupColors, scoreForKeep } from './groups.js'

/** @typedef {import('./types').DashboardTab} DashboardTab */
/** @typedef {import('./types').TabSnapshot} TabSnapshot */

/** @type {DashboardTab[]} */
export let openTabs = []

/**
 * snapshotChromeTabs(chromeTabs) — captures enough info per tab to
 * recreate it later via chrome.tabs.create() (used by undo). Skips
 * chrome:// and chrome-extension:// URLs since those aren't worth
 * recreating.
 *
 * @param {Array<{ url?: string, title?: string, pinned?: boolean, groupId?: number, windowId: number, index?: number }>} chromeTabs
 * @returns {TabSnapshot[]}
 */
export function snapshotChromeTabs(chromeTabs) {
  return chromeTabs
    .map((t) => ({
      url: unwrapSuspenderUrl(t.url || ''),
      title: t.title || '',
      pinned: !!t.pinned,
      groupId: typeof t.groupId === 'number' ? t.groupId : -1,
      windowId: t.windowId,
      index: typeof t.index === 'number' ? t.index : undefined
    }))
    .filter((s) => s.url && !s.url.startsWith('chrome://') && !s.url.startsWith('chrome-extension://'))
}

/**
 * fetchOpenTabs() — refreshes `openTabs` from chrome.tabs.query(),
 * normalizing each tab into our internal shape. Suspended tabs get
 * `url` = unwrapped real URL, `rawUrl` = Chrome's actual URL.
 *
 * @returns {Promise<void>}
 */
export async function fetchOpenTabs() {
  try {
    // Fetch tabs, windows, and tab-group colors in parallel — all
    // network-free API calls. Window types tell us which tabs are
    // running in standalone app/PWA windows (type === 'app' | 'popup').
    const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll(), fetchTabGroupColors()])
    const windowTypeById = new Map(windows.map((w) => [w.id, w.type]))
    openTabs = tabs.map((t) => {
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
        windowId: t.windowId,
        active: t.active,
        pinned: t.pinned,
        groupId: typeof t.groupId === 'number' ? t.groupId : -1,
        isTabOut: isTabOutUrl(rawUrl),
        isApp: windowType === 'app' || windowType === 'popup'
      }
    })
  } catch {
    openTabs = []
  }
}

/**
 * getRealTabs() — `openTabs` minus chrome://, extension pages, about:,
 * etc. The grid only ever shows real web pages.
 *
 * @returns {DashboardTab[]}
 */
export function getRealTabs() {
  return openTabs.filter((t) => {
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
export function getDashboardTabs() {
  return openTabs.filter((t) => {
    if (t.isTabOut) return true
    const url = t.url || ''
    return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:') && !url.startsWith('edge://') && !url.startsWith('brave://')
  })
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
export async function closeTabsByUrls(urls, opts = {}) {
  if (!urls || urls.length === 0) return []
  const { preserveGroups = false } = opts

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = []
  const exactUrls = new Set()

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
  if (toCloseTabs.length > 0) await chrome.tabs.remove(toCloseTabs.map((t) => t.id))
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
export async function closeTabsExact(urls, opts = {}) {
  if (!urls || urls.length === 0) return []
  const { preserveGroups = false } = opts
  const urlSet = new Set(urls)
  const allTabs = await chrome.tabs.query({})
  const toCloseTabs = allTabs.filter((t) => !(preserveGroups && isGroupedTab(t)) && urlSet.has(unwrapSuspenderUrl(t.url)))
  const snapshot = snapshotChromeTabs(toCloseTabs)
  if (toCloseTabs.length > 0) await chrome.tabs.remove(toCloseTabs.map((t) => t.id))
  await fetchOpenTabs()
  return snapshot
}

/**
 * focusTab(url) — switch Chrome to the tab matching `url` (exact first,
 * hostname fallback) and focus its window.
 *
 * Cross-window bonus: when the match lives in a different window than
 * the dashboard, plant a Tab Out tab next to it (same window, one
 * index before the match) so the user has a short path back to the
 * dashboard from the newly-visited tab. No duplicate is created if
 * that window already has a Tab Out tab open.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function focusTab(url) {
  if (!url) return false
  const allTabs = await chrome.tabs.query({})
  const currentWindow = await chrome.windows.getCurrent()

  const targetEffective = unwrapSuspenderUrl(url)

  let matches = allTabs.filter((t) => t.url === url || unwrapSuspenderUrl(t.url) === targetEffective)

  if (matches.length === 0) {
    try {
      const targetHost = new URL(targetEffective).hostname
      matches = allTabs.filter((t) => {
        try {
          return new URL(unwrapSuspenderUrl(t.url)).hostname === targetHost
        } catch {
          return false
        }
      })
    } catch {}
  }

  if (matches.length === 0) return false

  const match = matches.find((t) => t.windowId !== currentWindow.id) || matches[0]

  // Skip the pin-anchor guarantee when the match lives in an app or
  // popup window (standalone PWA, DevTools, extension popup). Those
  // windows don't accept new pinned tabs the way a normal browsing
  // window does — `chrome.tabs.create({ windowId: appWindowId,
  // pinned: true })` silently redirects the new tab into the current
  // normal window, which already has its own pinned Tab Out. The
  // result is a duplicate pinned dashboard in the browsing window
  // every time the user focuses an app tab. Resolve the match's
  // window type first and bail the anchor logic when it's not a
  // standard browsing window.
  let matchWindowType = 'normal'
  try {
    const w = await chrome.windows.get(match.windowId)
    matchWindowType = w.type
  } catch {}
  const matchIsApp = matchWindowType === 'app' || matchWindowType === 'popup' || matchWindowType === 'devtools'

  // Anchor-guarantee: wherever the match lives, make sure that window
  // has a PINNED Tab Out tab. Same logic whether we're crossing
  // windows or staying in the same one — the user's "easier reach"
  // goal is just "a pinned dashboard is always in this window." No
  // tab-strip repositioning needed; pinned tabs are anchored to the
  // leftmost section by Chrome, which is as reachable as it gets.
  //
  // Resolution order:
  //   1. pinned Tab Out already present → nothing to do
  //   2. unpinned Tab Out present → pin it (no duplicate, no churn)
  //   3. no Tab Out in that window → create a fresh pinned tab
  //      (Chrome auto-places it in the pinned section; no index
  //      param needed). `active: false` keeps the clicked tab as the
  //      focus target.
  const extensionId = chrome.runtime.id
  const newtabUrl = `chrome-extension://${extensionId}/index.html`
  const hasPinned = allTabs.some((t) => t.windowId === match.windowId && t.pinned && (t.url === newtabUrl || t.url === 'chrome://newtab/'))
  if (!matchIsApp && !hasPinned) {
    const unpinned = allTabs.find((t) => t.windowId === match.windowId && !t.pinned && (t.url === newtabUrl || t.url === 'chrome://newtab/'))
    if (unpinned) {
      await chrome.tabs.update(unpinned.id, { pinned: true })
    } else {
      await chrome.tabs.create({
        windowId: match.windowId,
        url: newtabUrl,
        pinned: true,
        active: false
      })
    }
  }

  await chrome.tabs.update(match.id, { active: true })
  await chrome.windows.update(match.windowId, { focused: true })
  return true
}

/**
 * focusExactTab(url) — focus an already-open tab whose effective URL matches
 * exactly. Unlike focusTab(), this does not fall back to hostname matching.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function focusExactTab(url) {
  if (!url) return false
  const allTabs = await chrome.tabs.query({})
  const targetEffective = unwrapSuspenderUrl(url)
  const matches = allTabs.filter((t) => t.url === url || unwrapSuspenderUrl(t.url) === targetEffective)
  if (matches.length === 0) return false

  let currentWindowId = -1
  try {
    currentWindowId = (await chrome.windows.getCurrent()).id
  } catch {}

  const match = matches.find((t) => t.windowId === currentWindowId) || matches[0]
  await chrome.tabs.update(match.id, { active: true })
  await chrome.windows.update(match.windowId, { focused: true })
  return true
}

/**
 * openTabUrl(url) — open a URL in a new active tab in the current window.
 *
 * @param {string} url
 * @returns {Promise<void>}
 */
export async function openTabUrl(url) {
  if (!url) return
  try {
    await chrome.tabs.create({ url, active: true })
  } catch {}
}

function isTabOutUrl(url) {
  const extensionId = globalThis.chrome?.runtime?.id
  if (url === 'chrome://newtab/') return true
  if (!extensionId) return false
  const tabOutUrl = `chrome-extension://${extensionId}/index.html`
  return url === tabOutUrl || url?.startsWith(`${tabOutUrl}?`) || url?.startsWith(`${tabOutUrl}#`)
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
export async function closeDuplicateTabs(urls, keepOne = true, opts = {}) {
  const { preservePinned = false, preservePinnedTabOut = false } = opts
  const allTabs = await chrome.tabs.query({})
  let currentWindowId = -1
  try {
    currentWindowId = (await chrome.windows.getCurrent()).id
  } catch {}
  const toCloseTabs = []

  for (const url of urls) {
    const matching = allTabs.filter((t) => unwrapSuspenderUrl(t.url) === url)
    if (preservePinned || preservePinnedTabOut) {
      const pinned = matching.filter((t) => t.pinned && (preservePinned || isTabOutUrl(t.url)))
      if (pinned.length >= 1) {
        const pinnedIds = new Set(pinned.map((t) => t.id))
        for (const t of matching) {
          if (!pinnedIds.has(t.id)) toCloseTabs.push(t)
        }
        continue
      }
    }
    if (!keepOne) {
      for (const tab of matching) toCloseTabs.push(tab)
      continue
    }

    const grouped = matching.filter((t) => isGroupedTab(t))
    const ungrouped = matching.filter((t) => !isGroupedTab(t))
    const sortByScore = (arr) => arr.slice().sort((a, b) => scoreForKeep(b, currentWindowId) - scoreForKeep(a, currentWindowId))

    if (grouped.length >= 1 && ungrouped.length >= 1) {
      for (const t of ungrouped) toCloseTabs.push(t)
    } else if (ungrouped.length >= 2) {
      const keep = sortByScore(ungrouped)[0]
      for (const t of ungrouped) {
        if (t.id !== keep.id) toCloseTabs.push(t)
      }
    } else if (grouped.length >= 2) {
      const distinctGroups = new Set(grouped.map((t) => t.groupId))
      if (distinctGroups.size === 1) {
        const keep = sortByScore(grouped)[0]
        for (const t of grouped) {
          if (t.id !== keep.id) toCloseTabs.push(t)
        }
      }
    }
  }

  const snapshot = snapshotChromeTabs(toCloseTabs)
  if (toCloseTabs.length > 0) await chrome.tabs.remove(toCloseTabs.map((t) => t.id))
  await fetchOpenTabs()
  return snapshot
}
