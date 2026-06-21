/* ================================================================
   Chip activation mode — classifies a (modifier) click/keydown on a
   page chip into one of three intents: focus the existing tab, or
   bring the tab into the current window (in the background, or in the
   foreground and switch to it).

   Pure and platform-injected (like isFilterFocusShortcut in
   app-url.ts) so it is unit-testable without a real `navigator`.
   ================================================================ */

export type ChipActivationMode = 'focus' | 'bring-background' | 'bring-foreground'

export interface ChipActivationModifiers {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

/**
 * chipActivationMode(e, platform) — resolve a click/keydown into an intent:
 *   • no move modifier             → 'focus'            (switch to the existing tab)
 *   • primary modifier, no Shift    → 'bring-background' (move the tab into the current window)
 *   • Shift                         → 'bring-foreground' (move it here and switch to it)
 *
 * The primary modifier is Cmd on macOS, Ctrl elsewhere, and the opposite key
 * must NOT be held — matching isFilterFocusShortcut so a cross-platform key
 * combo can't satisfy both branches. Shift is the foreground move gesture.
 *
 * @param {{ metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean } | null | undefined} e
 * @param {string} [platform]
 * @returns {ChipActivationMode}
 */
export function chipActivationMode(e: ChipActivationModifiers | null | undefined, platform = ''): ChipActivationMode {
  if (!e) return 'focus'
  if (e.shiftKey) return 'bring-foreground'
  const isMac = /mac|iphone|ipad|ipod/i.test(platform)
  const hasPrimaryModifier = isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
  if (!hasPrimaryModifier) return 'focus'
  return 'bring-background'
}

/**
 * shouldSuppressSelectionForGesture(e, platform) — true when a pointer event
 * carries one of the move modifiers (i.e. chipActivationMode is not 'focus').
 *
 * The chip and history-row click targets are <div role="button"> whose title is
 * ordinary selectable text — unlike a real <a>/<button>, a <div> has no
 * activation behavior, so the browser starts a native text selection on the same
 * Shift-click and ⌘/⌃-click gestures we've overloaded to MOVE the tab.
 * Calling preventDefault() on mousedown when this returns true cancels that default for the move gesture
 * only, so the surface behaves like a link while a plain click still drag-selects.
 *
 * @param {{ metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean } | null | undefined} e
 * @param {string} [platform]
 * @returns {boolean}
 */
export function shouldSuppressSelectionForGesture(e: ChipActivationModifiers | null | undefined, platform = ''): boolean {
  return chipActivationMode(e, platform) !== 'focus'
}
