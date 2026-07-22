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

import { createTabWithFallbackUrl, focusWindow, getTab, groupTabs, updateTab } from './browser-tabs-gateway.js'
import { showToast } from './toast.js'
import { requestDashboardRefresh, settleDashboardRefresh } from './dashboard-controller.js'
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
export async function undoLastClose(): Promise<void> {
  const closure = lastClosure
  if (!closure) return
  await undoClosure(closure)
}

async function undoClosure(closure: ClosureSnapshot): Promise<void> {
  if (closure.undone || closure.restoring || !closure.tabs || closure.tabs.length === 0) return
  closure.restoring = true

  const restoredTargets: RestoredTabTarget[] = []
  const failedTabs: TabSnapshot[] = []
  const attemptedTabs = tabsInRestoreOrder(closure.tabs)
  try {
    for (const tab of attemptedTabs) {
      const created = await restoreSnapshotTab(tab)
      if (!created || created.id == null) {
        failedTabs.push(tab)
        continue
      }
      restoredTargets.push({
        tabId: created.id,
        snapshot: { ...tab }
      })
      if (tab.groupId !== undefined && tab.groupId !== -1) {
        // group may have been dissolved — the gateway reports false; ignore
        await groupTabs([created.id], tab.groupId)
      }
    }
  } finally {
    closure.restoring = false
  }

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
      onClick: () => undoClosure(closure)
    })
  } else if (n === 1 && firstTarget) {
    const msg = 'Restored 1 tab'
    showToast(msg, {
      label: 'Switch',
      description: 'Switch to the restored tab.',
      onClick: () => switchToRestoredTab(firstTarget)
    })
  } else {
    showToast(`Restored ${n} tabs`)
  }
}

function restoredTargetMatchesLiveTab(target: RestoredTabTarget, tab: chrome.tabs.Tab | null): tab is chrome.tabs.Tab {
  if (!tab || tab.id !== target.tabId) return false
  const expectedUrl = unwrapSuspenderUrl(target.snapshot.url || target.snapshot.rawUrl || '')
  const liveUrl = unwrapSuspenderUrl(tab.pendingUrl || tab.url || '')
  return !!expectedUrl && liveUrl === expectedUrl
}

/** Activate the exact tab created by Undo only while its snapshot identity still matches. */
export async function switchToRestoredTab(target: RestoredTabTarget): Promise<void> {
  const tab = await getTab(target.tabId)
  if (!restoredTargetMatchesLiveTab(target, tab)) return

  const updatedTab = await updateTab(target.tabId, { active: true })
  if (!restoredTargetMatchesLiveTab(target, updatedTab)) return
  await focusWindow(updatedTab.windowId)
}

async function restoreSnapshotTab(tab: TabSnapshot): Promise<chrome.tabs.Tab | null> {
  const restoreUrl = tab.rawUrl || tab.url
  const sharedCreateProperties: chrome.tabs.CreateProperties = {
    url: restoreUrl,
    ...(Number.isInteger(tab.index) ? { index: tab.index } : {}),
    pinned: tab.pinned,
    active: false
  }
  const createdInOriginalWindow = await createTabWithFallbackUrl({
    ...sharedCreateProperties,
    windowId: tab.windowId
  }, tab.url)
  if (createdInOriginalWindow) return createdInOriginalWindow

  return createTabWithFallbackUrl(sharedCreateProperties, tab.url)
}

function tabsInRestoreOrder(tabs: TabSnapshot[]): TabSnapshot[] {
  const windows = new Map<number, Array<{ tab: TabSnapshot; sequence: number }>>()
  tabs.forEach((tab, sequence) => {
    const bucket = windows.get(tab.windowId) ?? []
    bucket.push({ tab, sequence })
    windows.set(tab.windowId, bucket)
  })

  return Array.from(windows.values()).flatMap((bucket) => {
    return bucket
      .slice()
      .sort((a, b) => {
        const aIndex = Number.isInteger(a.tab.index) ? a.tab.index as number : Number.POSITIVE_INFINITY
        const bIndex = Number.isInteger(b.tab.index) ? b.tab.index as number : Number.POSITIVE_INFINITY
        if (aIndex !== bIndex) return aIndex - bIndex
        return a.sequence - b.sequence
      })
      .map(({ tab }) => tab)
  })
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
    onClick: undoThisClosure
  })
  return undoThisClosure
}
