/* ================================================================
   Move a page's open tab into the current window.

   Resolves the live tab (by numeric tabId, else by effective URL,
   preferring a tab in another window), relocates it to the end of
   the current window, and optionally switches to it by reusing the
   shared focus/activation path. Returns false when no live tab
   exists, so callers can fall back to opening the page.

   Reads globalThis.chrome (tests assign it), mirroring how the
   tab-focus tests drive the chrome API.
   ================================================================ */

import { unwrapSuspenderUrl } from './suspension.js'
import { focusExistingTabTarget } from './tab-focus.js'

type ChromeTabMoveApi = {
  tabs: {
    query: (queryInfo: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
    move: (tabId: number, moveProperties: chrome.tabs.MoveProperties) => Promise<chrome.tabs.Tab | chrome.tabs.Tab[] | undefined>
  }
  windows: {
    getCurrent?: () => Promise<chrome.windows.Window>
  }
}

export type MoveTabTarget = {
  // A real open tab has a numeric id; saved/history chips carry a synthetic
  // string id. Only a numeric id is used for the direct tab lookup — a string
  // id intentionally falls through to effective-URL resolution (and, failing
  // that, the caller opens the page instead). The type stays `number | string`
  // so callers can forward a chip's id verbatim without narrowing.
  tabId?: number | string
  tabUrl?: string
  rawUrl?: string
}

function chromeApiOrNull(): ChromeTabMoveApi | null {
  return (globalThis.chrome as ChromeTabMoveApi | undefined) || null
}

function findTabForTarget(tabs: chrome.tabs.Tab[], target: MoveTabTarget, currentWindowId: number): chrome.tabs.Tab | null {
  if (typeof target.tabId === 'number') {
    const byId = tabs.find((tab) => tab.id === target.tabId)
    if (byId) return byId
  }
  const targetEffective = unwrapSuspenderUrl(target.tabUrl || target.rawUrl || '')
  if (!targetEffective) return null
  const matches = tabs.filter((tab) => unwrapSuspenderUrl(tab.url || '') === targetEffective)
  if (matches.length === 0) return null
  return matches.find((tab) => tab.windowId !== currentWindowId) || matches[0]
}

/**
 * moveTabToCurrentWindow(target, opts) — relocate the page's open tab into the
 * current window (end of the tab strip). Resolves the tab by numeric tabId,
 * else by effective URL (preferring a tab in another window). When opts.activate
 * is set, switches to the tab (unsuspending if needed) via the shared focus path.
 *
 * @param {{ tabId?: number | string, tabUrl?: string, rawUrl?: string }} target
 * @param {{ activate?: boolean }} [opts]
 * @returns {Promise<boolean>} true if a live tab was moved/activated; false if none found
 */
export async function moveTabToCurrentWindow(target: MoveTabTarget, opts: { activate?: boolean } = {}): Promise<boolean> {
  const api = chromeApiOrNull()
  if (!api) return false
  const { activate = false } = opts

  try {
    const tabs = await api.tabs.query({})
    let currentWindowId = -1
    try {
      currentWindowId = (await api.windows.getCurrent?.())?.id ?? -1
    } catch {}
    if (currentWindowId === -1) return false

    const match = findTabForTarget(tabs, target, currentWindowId)
    if (!match || typeof match.id !== 'number') return false

    if (match.windowId !== currentWindowId) {
      await api.tabs.move(match.id, { windowId: currentWindowId, index: -1 })
    }

    if (activate) {
      // The move (the primary effect) has already happened, so we report success
      // even if this activation no-ops (e.g. the tab was closed mid-gesture) —
      // returning false here would make the caller open a duplicate tab.
      await focusExistingTabTarget({ tabId: match.id, url: target.tabUrl, rawUrl: target.rawUrl })
    }

    return true
  } catch {
    return false
  }
}
