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
import { requestDashboardRefresh } from './dashboard-controller.js'
import type { TabSnapshot } from './types'

type ClosureSnapshot = {
  tabs: TabSnapshot[]
  at: number
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
  if (!closure || !closure.tabs || closure.tabs.length === 0) return
  lastClosure = null

  const restoredTabIds: number[] = []
  for (const t of tabsInRestoreOrder(closure.tabs)) {
    const created = await restoreSnapshotTab(t)
    if (!created || created.id == null) continue
    restoredTabIds.push(created.id)
    if (t.groupId !== undefined && t.groupId !== -1) {
      // group may have been dissolved — the gateway reports false; ignore
      await groupTabs([created.id], t.groupId)
    }
  }

  await requestDashboardRefresh({ animateCards: true })

  const n = closure.tabs.length
  const firstId = restoredTabIds[0]
  const msg = `Restored ${n} tab${n !== 1 ? 's' : ''}`
  if (n === 1 && firstId != null) {
    showToast(msg, {
      label: 'Switch',
      description: 'Switch to the restored tab.',
      onClick: async () => {
        const tab = await getTab(firstId)
        if (!tab) return
        await updateTab(firstId, { active: true })
        await focusWindow(tab.windowId)
      }
    })
  } else {
    showToast(msg)
  }
}

async function restoreSnapshotTab(tab: TabSnapshot): Promise<chrome.tabs.Tab | null> {
  const restoreUrl = tab.rawUrl || tab.url
  const createProperties: chrome.tabs.CreateProperties = {
    url: restoreUrl,
    windowId: tab.windowId,
    ...(Number.isInteger(tab.index) ? { index: tab.index } : {}),
    pinned: tab.pinned,
    active: false
  }

  return createTabWithFallbackUrl(createProperties, tab.url)
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
export function markClosure(snapshot: TabSnapshot[], label?: string): void {
  if (!snapshot || snapshot.length === 0) return
  lastClosure = { tabs: snapshot, at: Date.now() }
  const n = snapshot.length
  showToast(label || `Closed ${n} tab${n !== 1 ? 's' : ''}`, {
    label: 'Undo',
    description: 'You can undo this action.',
    onClick: undoLastClose
  })
}
