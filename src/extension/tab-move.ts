/* ================================================================
   Move a page's open tab into another window.

   Resolves the live tab (by numeric tabId, else by effective URL,
   preferring a tab in another window for current-window moves),
   relocates it, and reuses the shared focus/activation path where
   needed. Its result distinguishes a confirmed missing tab from an
   unknown/failed browser operation so callers never open a duplicate
   after a transient Chrome API failure. All browser access goes through
   the Browser Tabs Gateway.
   ================================================================ */

import { Effect } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { unwrapSuspenderUrl } from './suspension.js'
import { focusResolvedTabTargetEffect, unsuspendExistingTabEffect } from './tab-focus.js'
import { liveTabByValidatedId, liveTabUrlForIdentity } from './live-tab-matching.js'

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

export type MoveTabResult = 'handled' | 'not-found' | 'failed'

const focusLatestResolvedTarget = Effect.fn('tabMove.focusLatestResolvedTarget')(function*(
  tabId: number,
  target: MoveTabTarget
) {
  const browserTabs = yield* BrowserTabs
  const liveTab = yield* browserTabs.getTab(tabId)
  if (!liveTab) return { status: 'not-found' as const }
  return yield* focusResolvedTabTargetEffect(liveTab, {
    tabId,
    ...(target.tabUrl === undefined ? {} : { url: target.tabUrl }),
    ...(target.rawUrl === undefined ? {} : { rawUrl: target.rawUrl })
  })
})

function findTabForTarget(tabs: chrome.tabs.Tab[], target: MoveTabTarget, currentWindowId: number): chrome.tabs.Tab | null {
  if (typeof target.tabId === 'number') {
    // A rendered numeric ID identifies one physical tab. If it is gone or has
    // been reused for another URL, do not silently move a same-URL sibling;
    // callers can apply the documented missing-target fallback instead.
    return liveTabByValidatedId(tabs, target)
  }
  const targetEffective = unwrapSuspenderUrl(target.tabUrl || target.rawUrl || '')
  if (!targetEffective) return null
  const matches = tabs.filter((tab) => unwrapSuspenderUrl(liveTabUrlForIdentity(tab)) === targetEffective)
  if (matches.length === 0) return null
  return matches.find((tab) => tab.windowId !== currentWindowId) ?? matches[0] ?? null
}

/**
 * moveTabToCurrentWindow(target, opts) — relocate the page's open tab into the
 * current window (end of the tab strip). Resolves the tab by numeric tabId,
 * else by effective URL (preferring a tab in another window). When opts.activate
 * is set, switches to the tab (unsuspending if needed) via the shared focus path.
 *
 * @param {{ tabId?: number | string, tabUrl?: string, rawUrl?: string }} target
 * @param {{ activate?: boolean }} [opts]
 * @returns {Promise<MoveTabResult>} whether the target was handled, confirmed
 * missing, or could not be resolved/moved because a browser operation failed
 */
export const moveTabToCurrentWindowEffect = Effect.fn('tabMove.toCurrentWindow')(function*(
  target: MoveTabTarget,
  opts: { activate?: boolean } = {}
) {
  const { activate = false } = opts

  const browserTabs = yield* BrowserTabs
  const currentWindowResult = yield* browserTabs.getCurrentWindowResult()
  const currentWindowId = currentWindowResult.value?.id
  if (!currentWindowResult.ok || typeof currentWindowId !== 'number') return 'failed'
  // The inventory is deliberately the final awaited read before moving. A
  // slow window lookup must not leave a stale URL identity behind.
  const tabsResult = yield* browserTabs.queryAllTabsResult()
  if (!tabsResult.ok) return 'failed'

  const match = findTabForTarget(tabsResult.value, target, currentWindowId)
  if (!match || typeof match.id !== 'number') return 'not-found'

  const movedToCurrentWindow = match.windowId !== currentWindowId
  if (movedToCurrentWindow) {
    const moved = yield* browserTabs.moveTab(match.id, { windowId: currentWindowId, index: -1 })
    if (!moved) return 'failed'
  }

  if (activate) {
    // A completed physical move remains handled even if the follow-up focus
    // no-ops, because falling back would open a duplicate. With no preceding
    // move, however, activation itself is the primary effect and must be
    // confirmed before callers refresh or report the gesture as handled.
    const focusResult = yield* focusLatestResolvedTarget(match.id, target)
    if (
      !movedToCurrentWindow &&
      focusResult.status !== 'focused' &&
      focusResult.status !== 'activated'
    ) {
      return 'failed'
    }
  } else {
    yield* unsuspendExistingTabEffect(match, {
      ...(target.tabUrl === undefined ? {} : { url: target.tabUrl }),
      ...(target.rawUrl === undefined ? {} : { rawUrl: target.rawUrl })
    })
  }

  return 'handled'
})

export function moveTabToCurrentWindow(
  target: MoveTabTarget,
  opts: { activate?: boolean } = {}
): Promise<MoveTabResult> {
  return getAppRuntime().runPromise(moveTabToCurrentWindowEffect(target, opts))
}

/**
 * moveTabToNewWindow(target) — relocate the page's open tab into a new focused
 * Chrome window. Resolves the tab by numeric tabId, else by effective URL.
 *
 * @param {{ tabId?: number | string, tabUrl?: string, rawUrl?: string }} target
 * @returns {Promise<MoveTabResult>} whether the target was handled, confirmed
 * missing, or could not be resolved/moved because a browser operation failed
 */
export const moveTabToNewWindowEffect = Effect.fn('tabMove.toNewWindow')(function*(
  target: MoveTabTarget
) {
  const browserTabs = yield* BrowserTabs
  const currentWindowResult = yield* browserTabs.getCurrentWindowResult()
  const currentWindowId = currentWindowResult.ok && typeof currentWindowResult.value?.id === 'number'
    ? currentWindowResult.value.id
    : -1
  const tabsResult = yield* browserTabs.queryAllTabsResult()
  if (!tabsResult.ok) return 'failed'

  const match = findTabForTarget(tabsResult.value, target, currentWindowId)
  if (!match || typeof match.id !== 'number') return 'not-found'

  const created = yield* browserTabs.createWindow({ tabId: match.id, focused: true, type: 'normal' })
  if (!created) return 'failed'

  yield* focusLatestResolvedTarget(match.id, target)
  return 'handled'
})

export function moveTabToNewWindow(target: MoveTabTarget): Promise<MoveTabResult> {
  return getAppRuntime().runPromise(moveTabToNewWindowEffect(target))
}
