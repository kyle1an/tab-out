/* Paint-first popup boot.

   The popup window becomes visible at the document's first paint, and the
   prerendered popup.html shell needs no JavaScript to render. Evaluating the
   React/Effect module graph (~65ms) before that frame races the compositor
   and can double the time until the menu is visible, so this entry stays
   tiny and defers the heavy module until a frame has committed: the rAF
   fires just before the first paint, and the timeout lands after it.

   Hidden documents (a popup.html opened in a background tab) produce no
   frames and no rAF ticks, so they boot immediately; the 300ms timer is a
   safety net for a visible document that fails to produce a frame. */
let booted = false

function bootHeavyModule(): void {
  if (booted) return
  booted = true
  void import('./popup-app.js')
}

if (document.visibilityState === 'hidden') {
  bootHeavyModule()
} else {
  requestAnimationFrame(() => {
    setTimeout(bootHeavyModule, 0)
  })
  setTimeout(bootHeavyModule, 300)
}
