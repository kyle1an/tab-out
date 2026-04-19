/* ================================================================
   Generic UI helpers — toast, card animations, button updates

   showToast              — bottom-screen notification, optionally
                             with an inline action button (e.g. Undo).
   animateCardOut         — fade + scale-down + confetti, then re-pack.
   checkAndShowEmptyState — "Inbox zero" message when grid is empty.
   updateCloseTabsButton  — decrements the count in a "Close N tabs"
                             button label, preserving wording.
   ================================================================ */

import { shootConfetti } from './confetti.js'
import { packMissionsMasonry } from './layout.js'
import { render as preactRender } from './vendor/preact.mjs'

let toastTimer = null

/**
 * showToast(message, action?)
 *
 * action is an optional { label, onClick } pair. With an action, the toast
 * shows an inline button and stays visible longer (6 s instead of 2.5 s).
 * Hovering the toast pauses the auto-hide timer — important for the Undo
 * case so users can cross the mouse to the button without racing the clock.
 * A new showToast call replaces any existing toast (and its action).
 */
export function showToast(message, action = null) {
  const toast = document.getElementById('toast')
  if (!toast) return
  document.getElementById('toastText').textContent = message
  toast.querySelectorAll('.toast-action').forEach((b) => b.remove())
  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button')
    btn.className = 'toast-action'
    btn.textContent = action.label
    btn.addEventListener('click', () => {
      action.onClick()
      toast.classList.remove('visible')
    })
    toast.appendChild(btn)
  }
  toast.classList.add('visible')
  clearTimeout(toastTimer)
  const duration = action ? 6000 : 2500
  const hide = () => toast.classList.remove('visible')
  toastTimer = setTimeout(hide, duration)
  toast.onmouseenter = () => clearTimeout(toastTimer)
  toast.onmouseleave = () => {
    if (!toast.classList.contains('visible')) return
    clearTimeout(toastTimer)
    toastTimer = setTimeout(hide, duration)
  }
}

/**
 * animateCardOut(card) — fade + scale-down + confetti, then remove and
 * re-pack the masonry grid.
 */
export function animateCardOut(card) {
  if (!card) return

  const rect = card.getBoundingClientRect()
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2)

  card.classList.add('closing')
  setTimeout(() => {
    card.remove()
    checkAndShowEmptyState()
    packMissionsMasonry()
  }, 300)
}

/**
 * checkAndShowEmptyState() — "Inbox zero" message when all cards gone.
 *
 * #openTabsMissions is a Preact mount root (see render.js →
 * components/Missions.js). Overwriting its innerHTML directly would
 * leave Preact's internal reconciler holding dangling DOM refs, and
 * the next live-sync render would throw "insertBefore: parameter 1
 * is not of type Node". We call `preactRender(null, el)` first to
 * unmount Preact cleanly; the next renderStaticDashboard call
 * re-mounts from scratch when new cards arrive.
 */
export function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions')
  if (!missionsEl) return

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length
  if (remaining > 0) return

  preactRender(null, missionsEl)

  missionsEl.innerHTML = /*html*/ `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `

  const countEl = document.getElementById('openTabsSectionCount')
  if (countEl) countEl.textContent = '0 domains'
}

/**
 * updateCloseTabsButton(btn, closed) — decrements the numeric count in a
 * "Close ... N tab(s)" button's label by `closed`, preserving any modifier
 * word (e.g. "all" / "ungrouped") and fixing tab/tabs pluralization.
 * No-op if btn is null.
 */
export function updateCloseTabsButton(btn, closed) {
  if (!btn || !closed) return
  btn.innerHTML = btn.innerHTML.replace(/(\d+)(\s+(?:\w+\s+)?)tabs?\b/, (_, numStr, middle) => {
    const next = Math.max(0, parseInt(numStr, 10) - closed)
    return `${next}${middle}tab${next !== 1 ? 's' : ''}`
  })
}
