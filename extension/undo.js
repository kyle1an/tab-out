/* ================================================================
   Undo last close action — hybrid sessions + tabs.create

   Each close action calls markClosure(snapshot, label) which:
     • stores the snapshot for one undo opportunity
     • shows the toast with an inline Undo button
   Clicking Undo runs undoLastClose() which tries chrome.sessions.restore()
   for high-fidelity recovery (max 25), then falls back to chrome.tabs.create
   for any unmatched snapshot entries (unlimited depth, lossy on page state).
   ================================================================ */

import { unwrapSuspenderUrl } from './suspender.js'
import { showToast } from './ui.js'

let lastClosure = null

/**
 * undoLastClose() — restore the most recently closed tabs.
 *
 * Hybrid strategy:
 *   1. Pull the up-to-25 most recent sessions from chrome.sessions and
 *      restore any that match a snapshot URL (preserves history & scroll).
 *   2. For snapshot entries we couldn't match, recreate via chrome.tabs.create()
 *      (just URL + window placement; loses page state but works without limit).
 *   3. Re-group restored tabs into their original Chrome group when possible.
 *
 * Focus behavior: chrome.sessions.restore() activates the restored tab by
 * default, which would yank the user off the dashboard. We capture the Tab
 * Out page's tab id + window id before restoring and re-focus it afterwards
 * so the user stays on the dashboard. The "Restored N tabs" toast offers a
 * "Switch" button (single-tab undo only) so they can still jump to the
 * restored tab if they want.
 */
export async function undoLastClose() {
  const closure = lastClosure
  if (!closure || !closure.tabs || closure.tabs.length === 0) return
  lastClosure = null

  let selfTabId = null
  let selfWindowId = null
  try {
    const self = await chrome.tabs.getCurrent()
    if (self) {
      selfTabId = self.id
      selfWindowId = self.windowId
    }
  } catch {}

  const restored = new Set()
  const restoredTabIds = []

  if (chrome.sessions) {
    try {
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 })
      const urlToIndices = new Map()
      closure.tabs.forEach((t, i) => {
        if (!urlToIndices.has(t.url)) urlToIndices.set(t.url, [])
        urlToIndices.get(t.url).push(i)
      })
      for (const session of sessions) {
        if (!session.tab || !session.tab.url) continue
        const indices = urlToIndices.get(unwrapSuspenderUrl(session.tab.url))
        if (!indices || indices.length === 0) continue
        try {
          const result = await chrome.sessions.restore(session.sessionId)
          if (result && result.tab && result.tab.id != null) {
            restoredTabIds.push(result.tab.id)
          }
          restored.add(indices.shift())
        } catch {
          /* one bad session shouldn't kill the rest */
        }
      }
    } catch {
      /* sessions API unavailable — fall through to recreate */
    }
  }

  for (let i = 0; i < closure.tabs.length; i++) {
    if (restored.has(i)) continue
    const t = closure.tabs[i]
    try {
      const created = await chrome.tabs.create({
        url: t.url,
        windowId: t.windowId,
        pinned: t.pinned,
        active: false
      })
      if (created && created.id != null) restoredTabIds.push(created.id)
      if (t.groupId !== undefined && t.groupId !== -1 && chrome.tabs.group) {
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

  if (selfTabId != null) {
    try {
      await chrome.tabs.update(selfTabId, { active: true })
      if (selfWindowId != null) await chrome.windows.update(selfWindowId, { focused: true })
    } catch {
      /* self-tab may have been closed in the meantime — ignore */
    }
  }

  const n = closure.tabs.length
  const firstId = restoredTabIds[0]
  const msg = `Restored ${n} tab${n !== 1 ? 's' : ''}`
  if (n === 1 && firstId != null) {
    showToast(msg, {
      label: 'Switch',
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
 * the toast with an "Undo" button. Snapshot is the array returned by the
 * close functions; label is the toast text (defaults to "Closed N tabs").
 */
export function markClosure(snapshot, label) {
  if (!snapshot || snapshot.length === 0) return
  lastClosure = { tabs: snapshot, at: Date.now() }
  const n = snapshot.length
  showToast(label || `Closed ${n} tab${n !== 1 ? 's' : ''}`, {
    label: 'Undo',
    onClick: undoLastClose
  })
}
