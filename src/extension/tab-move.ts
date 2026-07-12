/* ================================================================
   Move a page's open tab into another window.

   Resolves the live tab (by numeric tabId, else by effective URL,
   preferring a tab in another window for current-window moves),
   relocates it, and reuses the shared focus/activation path where
   needed. Returns false when no live tab exists, so callers can fall
   back to opening the page. All browser access goes through the
   Browser Tabs Gateway.
   ================================================================ */

import { createWindow, getCurrentWindow, moveTab, queryAllTabs } from './browser-tabs-gateway.js'
import { unwrapSuspenderUrl } from './suspension.js'
import { focusExistingTabTarget, unsuspendExistingTab } from './tab-focus.js'

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
  const { activate = false } = opts

  const tabs = await queryAllTabs()
  const currentWindowId = (await getCurrentWindow())?.id ?? -1
  if (currentWindowId === -1) return false

  const match = findTabForTarget(tabs, target, currentWindowId)
  if (!match || typeof match.id !== 'number') return false

  if (match.windowId !== currentWindowId) {
    const moved = await moveTab(match.id, { windowId: currentWindowId, index: -1 })
    if (!moved) return false
  }

  if (activate) {
    // The move (the primary effect) has already happened, so we report success
    // even if this activation no-ops (e.g. the tab was closed mid-gesture) —
    // returning false here would make the caller open a duplicate tab.
    await focusExistingTabTarget({ tabId: match.id, url: target.tabUrl, rawUrl: target.rawUrl })
  } else {
    await unsuspendExistingTab(match, { url: target.tabUrl, rawUrl: target.rawUrl })
  }

  return true
}

/**
 * moveTabToNewWindow(target) — relocate the page's open tab into a new focused
 * Chrome window. Resolves the tab by numeric tabId, else by effective URL.
 *
 * @param {{ tabId?: number | string, tabUrl?: string, rawUrl?: string }} target
 * @returns {Promise<boolean>} true if a live tab was moved; false if none found
 */
export async function moveTabToNewWindow(target: MoveTabTarget): Promise<boolean> {
  const tabs = await queryAllTabs()
  const currentWindowId = (await getCurrentWindow())?.id ?? -1

  const match = findTabForTarget(tabs, target, currentWindowId)
  if (!match || typeof match.id !== 'number') return false

  const created = await createWindow({ tabId: match.id, focused: true, type: 'normal' })
  if (!created) return false

  await focusExistingTabTarget({ tabId: match.id, url: target.tabUrl, rawUrl: target.rawUrl })
  return true
}
