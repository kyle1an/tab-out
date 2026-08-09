/* ================================================================
   Undo last close action — chrome.tabs.create only

   Each close action calls markClosure(snapshot, label) which:
     • stores the snapshot for one undo opportunity
     • shows the toast with a Base UI Undo action
   Clicking Undo runs undoLastClose() which recreates each closed tab
   via chrome.tabs.create({ active: false }) so the user stays on the
   dashboard. chrome.sessions.restore() would preserve scroll/history
   but activates the restored tab and focuses its window — and that
   focus-steal can't be reliably undone after the fact (Chrome's focus
   event fires even after the promise resolves). tabs.create with
   active:false is the only path that never takes focus in the first
   place, so we use it exclusively.
   ================================================================ */

import { Effect } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { showToast } from './toast.js'
import { requestDashboardRefresh, settleDashboardRefresh } from './dashboard-intake.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { TabSnapshot } from './types'

type ClosureSnapshot = {
  tabs: TabSnapshot[]
  at: number
  undone: boolean
  restoring: boolean
}

export type RestoredTabTarget = {
  tabId: number
  snapshot: TabSnapshot
}

let lastClosure: ClosureSnapshot | null = null

/**
 * undoLastClose() — restore the most recently closed tabs via
 * chrome.tabs.create({ active: false }). The restored tab keeps its
 * original Chrome URL, window placement, tab-strip index, pinned state,
 * and Chrome group membership. For suspended tabs, we try the raw
 * suspender URL first so the tab comes back suspended like Chrome's
 * native reopen path; if Chrome refuses that extension URL, we fall
 * back to the effective page URL. Page state (scroll, form data,
 * navigation history) is not preserved — worth it to avoid the
 * focus-steal of sessions.restore.
 *
 * After restoring, the toast offers a "Switch" button for single-tab
 * undo so the user can jump to the restored tab if they want.
 */
const restoreSnapshotTab = Effect.fn('undo.restoreSnapshotTab')(function* (tab: TabSnapshot) {
  const browserTabs = yield* BrowserTabs
  const restoreUrl = tab.rawUrl || tab.url
  const sharedCreateProperties: chrome.tabs.CreateProperties = {
    url: restoreUrl,
    ...(Number.isInteger(tab.index) ? { index: tab.index } : {}),
    pinned: tab.pinned,
    active: false,
  }
  const createdInOriginalWindow = yield* browserTabs.createTabWithFallbackUrl({
    ...sharedCreateProperties,
    windowId: tab.windowId,
  }, tab.url)
  if (createdInOriginalWindow) return createdInOriginalWindow

  return yield* browserTabs.createTabWithFallbackUrl(sharedCreateProperties, tab.url)
})

const restoreClosureTabs = Effect.fn('undo.restoreClosureTabs')(function* (
  closure: ClosureSnapshot,
) {
  const browserTabs = yield* BrowserTabs
  const restoredTargets: RestoredTabTarget[] = []
  const failedTabs: TabSnapshot[] = []
  const attemptedTabs = tabsInRestoreOrder(closure.tabs)
  for (const tab of attemptedTabs) {
    const created = yield* restoreSnapshotTab(tab)
    if (!created || created.id == null) {
      failedTabs.push(tab)
      continue
    }
    const createdTabId = created.id
    restoredTargets.push({
      tabId: createdTabId,
      snapshot: { ...tab },
    })
    const groupId = tab.groupId
    if (groupId !== undefined && groupId !== -1) {
      // The group may have been dissolved. The gateway reports false, which is
      // still a successfully completed grouping attempt for this restore.
      yield* browserTabs.groupTabs([createdTabId], groupId)
    }
  }
  return { attemptedTabs, failedTabs, restoredTargets }
})

const runUndoClosure = Effect.fn('undo.runClosure')(function* (closure: ClosureSnapshot) {
  if (closure.undone || closure.restoring || !closure.tabs || closure.tabs.length === 0) return
  const { attemptedTabs, failedTabs, restoredTargets } = yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      closure.restoring = true
      return closure
    }),
    () => restoreClosureTabs(closure),
    () => Effect.sync(() => {
      closure.restoring = false
    }),
  )

  closure.tabs = failedTabs
  closure.undone = failedTabs.length === 0
  if (closure.undone && lastClosure === closure) lastClosure = null

  void settleDashboardRefresh(requestDashboardRefresh({ animateCards: true }))

  const n = restoredTargets.length
  const firstTarget = restoredTargets[0]
  if (failedTabs.length > 0) {
    const msg = n === 0
      ? `Could not restore ${failedTabs.length} tab${failedTabs.length !== 1 ? 's' : ''}`
      : `Restored ${n} of ${attemptedTabs.length} tabs`
    showToast(msg, {
      label: 'Retry',
      description: 'Retry the tabs that could not be restored.',
      onClick: () => undoClosure(closure),
    })
  } else if (n === 1 && firstTarget) {
    const msg = 'Restored 1 tab'
    showToast(msg, {
      label: 'Switch',
      description: 'Switch to the restored tab.',
      onClick: () => switchToRestoredTab(firstTarget),
    })
  } else {
    showToast(`Restored ${n} tabs`)
  }
})

function undoClosure(closure: ClosureSnapshot): Promise<void> {
  return getAppRuntime().runPromise(runUndoClosure(closure))
}

export function undoLastClose(): Promise<void> {
  const closure = lastClosure
  return closure ? undoClosure(closure) : Promise.resolve()
}

function restoredTargetMatchesLiveTab(target: RestoredTabTarget, tab: chrome.tabs.Tab | null): tab is chrome.tabs.Tab {
  if (!tab || tab.id !== target.tabId) return false
  const expectedUrl = unwrapSuspenderUrl(target.snapshot.url || target.snapshot.rawUrl || '')
  const liveUrl = unwrapSuspenderUrl(tab.pendingUrl || tab.url || '')
  return !!expectedUrl && liveUrl === expectedUrl
}

const runSwitchToRestoredTab = Effect.fn('undo.switchToRestoredTab')(function* (target: RestoredTabTarget) {
  const browserTabs = yield* BrowserTabs
  const tab = yield* browserTabs.getTab(target.tabId)
  if (!restoredTargetMatchesLiveTab(target, tab)) return

  const updatedTab = yield* browserTabs.updateTab(target.tabId, { active: true })
  if (!restoredTargetMatchesLiveTab(target, updatedTab)) return
  yield* browserTabs.focusWindow(updatedTab.windowId)
})

/** Activate the exact tab created by Undo only while its snapshot identity still matches. */
export function switchToRestoredTab(target: RestoredTabTarget): Promise<void> {
  return getAppRuntime().runPromise(runSwitchToRestoredTab(target))
}

function tabsInRestoreOrder(tabs: TabSnapshot[]): TabSnapshot[] {
  const restoreIndex = (index: number | undefined): number => (
    typeof index === 'number' && Number.isInteger(index)
      ? index
      : Number.POSITIVE_INFINITY
  )
  const windows = new Map<number, Array<{ tab: TabSnapshot, sequence: number }>>()
  tabs.forEach((tab, sequence) => {
    windows.getOrInsertComputed(tab.windowId, () => []).push({ tab, sequence })
  })

  return windows.values().flatMap((bucket) => {
    return bucket
      .toSorted((a, b) => {
        const aIndex = restoreIndex(a.tab.index)
        const bIndex = restoreIndex(b.tab.index)
        if (aIndex !== bIndex) return aIndex - bIndex
        return a.sequence - b.sequence
      })
      .map(({ tab }) => tab)
  }).toArray()
}

/**
 * markClosure(snapshot, label?) — record a close action for undo + show
 * the toast with an "Undo" action. Snapshot is the array returned by the
 * close functions; label is the toast text (defaults to "Closed N tabs").
 */
export function markClosure(snapshot: TabSnapshot[], label?: string): (() => Promise<void>) | null {
  if (!snapshot || snapshot.length === 0) return null
  const closure = { tabs: snapshot, at: Date.now(), undone: false, restoring: false }
  lastClosure = closure
  const undoThisClosure = () => undoClosure(closure)
  const n = snapshot.length
  showToast(label || `Closed ${n} tab${n !== 1 ? 's' : ''}`, {
    label: 'Undo',
    description: 'You can undo this action.',
    onClick: undoThisClosure,
  })
  return undoThisClosure
}
