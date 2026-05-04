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
 * original URL, window placement, pinned state, and Chrome group
 * membership. Page state (scroll, form data, navigation history) is
 * not preserved — worth it to avoid the focus-steal of sessions.restore.
 *
 * After restoring, the toast offers a "Switch" button for single-tab
 * undo so the user can jump to the restored tab if they want.
 */
export async function undoLastClose(): Promise<void> {
  const closure = lastClosure
  if (!closure || !closure.tabs || closure.tabs.length === 0) return
  lastClosure = null

  const restoredTabIds: number[] = []
  for (const t of closure.tabs) {
    try {
      const created = await chrome.tabs.create({
        url: t.url,
        windowId: t.windowId,
        pinned: t.pinned,
        active: false
      })
      if (created && created.id != null) restoredTabIds.push(created.id)
      if (created.id != null && t.groupId !== undefined && t.groupId !== -1 && chrome.tabs.group) {
        try {
          await chrome.tabs.group({ tabIds: [created.id], groupId: t.groupId })
        } catch {
          /* group may have been dissolved — ignore */
        }
      }
    } catch {
      /* tab create failed (e.g., bad URL) — skip */
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
        try {
          const tab = await chrome.tabs.get(firstId)
          await chrome.tabs.update(firstId, { active: true })
          await chrome.windows.update(tab.windowId, { focused: true })
        } catch {}
      }
    })
  } else {
    showToast(msg)
  }
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
