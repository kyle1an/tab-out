/* ================================================================
   Undo last close action — hybrid sessions + tabs.create

   Each close action calls markClosure(snapshot, label) which:
     • stores the snapshot for one undo opportunity
     • shows the toast with an inline Undo button
   Clicking Undo runs undoLastClose() which tries chrome.sessions.restore()
   for high-fidelity recovery (max 25), then falls back to chrome.tabs.create
   for any unmatched snapshot entries (unlimited depth, lossy on page state).
   ================================================================ */

import { unwrapSuspenderUrl } from './suspender.js';
import { showToast } from './ui.js';

let lastClosure = null;

/**
 * undoLastClose() — restore the most recently closed tabs.
 *
 * Hybrid strategy:
 *   1. Pull the up-to-25 most recent sessions from chrome.sessions and
 *      restore any that match a snapshot URL (preserves history & scroll).
 *   2. For snapshot entries we couldn't match, recreate via chrome.tabs.create()
 *      (just URL + window placement; loses page state but works without limit).
 *   3. Re-group restored tabs into their original Chrome group when possible.
 */
export async function undoLastClose() {
  const closure = lastClosure;
  if (!closure || !closure.tabs || closure.tabs.length === 0) return;
  lastClosure = null;

  const restored = new Set(); // snapshot indices already restored

  if (chrome.sessions) {
    try {
      const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
      const urlToIndices = new Map();
      closure.tabs.forEach((t, i) => {
        if (!urlToIndices.has(t.url)) urlToIndices.set(t.url, []);
        urlToIndices.get(t.url).push(i);
      });
      for (const session of sessions) {
        if (!session.tab || !session.tab.url) continue;
        const indices = urlToIndices.get(unwrapSuspenderUrl(session.tab.url));
        if (!indices || indices.length === 0) continue;
        try {
          await chrome.sessions.restore(session.sessionId);
          restored.add(indices.shift());
        } catch { /* one bad session shouldn't kill the rest */ }
      }
    } catch { /* sessions API unavailable — fall through to recreate */ }
  }

  for (let i = 0; i < closure.tabs.length; i++) {
    if (restored.has(i)) continue;
    const t = closure.tabs[i];
    try {
      const created = await chrome.tabs.create({
        url:      t.url,
        windowId: t.windowId,
        pinned:   t.pinned,
        active:   false,
      });
      if (t.groupId !== undefined && t.groupId !== -1 && chrome.tabs.group) {
        try { await chrome.tabs.group({ tabIds: [created.id], groupId: t.groupId }); }
        catch { /* group may have been dissolved — ignore */ }
      }
    } catch { /* tab create failed (e.g., bad URL) — skip */ }
  }

  showToast(`Restored ${closure.tabs.length} tab${closure.tabs.length !== 1 ? 's' : ''}`);
}

/**
 * markClosure(snapshot, label?) — record a close action for undo + show
 * the toast with an "Undo" button. Snapshot is the array returned by the
 * close functions; label is the toast text (defaults to "Closed N tabs").
 */
export function markClosure(snapshot, label) {
  if (!snapshot || snapshot.length === 0) return;
  lastClosure = { tabs: snapshot, at: Date.now() };
  const n = snapshot.length;
  showToast(label || `Closed ${n} tab${n !== 1 ? 's' : ''}`, {
    label:   'Undo',
    onClick: undoLastClose,
  });
}
