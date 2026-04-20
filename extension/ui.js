/* ================================================================
   Generic UI helpers — toast only.

   Close animations now live in CSS (`.closing` class on .mission-card,
   .page-chip, .action-btn, .chip-dupe-badge). Every handler that used
   to call animateCardOut / imperative style mutations now just adds
   the class, awaits the transition, and lets renderStaticDashboard
   rebuild the VM — Preact drops the absent nodes on its own.

   The "Inbox zero" empty state moved into the <Missions> component,
   so checkAndShowEmptyState (which injected innerHTML into a Preact-
   owned root) is gone too.

   showToast — bottom-screen notification, optionally with an inline
               action button (e.g. Undo).
   ================================================================ */

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

