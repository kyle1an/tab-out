/* ================================================================
   Chip activation mode — classifies a (modifier) click/keydown on a
   page chip into one of three intents, mirroring the browser's
   "open link in a new tab" gestures.

   Pure and platform-injected (like isFilterFocusShortcut in
   app-url.ts) so it is unit-testable without a real `navigator`.
   ================================================================ */

export type ChipActivationMode = 'focus' | 'new-background' | 'new-foreground'

export interface ChipActivationModifiers {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

/**
 * chipActivationMode(e, platform) — resolve a click/keydown into an intent:
 *   • no primary modifier        → 'focus'          (switch to the existing tab)
 *   • primary modifier, no Shift  → 'new-background' (open a background tab)
 *   • primary modifier + Shift    → 'new-foreground' (open and switch to it)
 *
 * The primary modifier is Cmd on macOS, Ctrl elsewhere, and the opposite key
 * must NOT be held — matching isFilterFocusShortcut so a cross-platform key
 * combo can't satisfy both branches. Shift on its own is intentionally neutral
 * (the browser's new-window gesture is out of scope).
 *
 * @param {{ metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean } | null | undefined} e
 * @param {string} [platform]
 * @returns {ChipActivationMode}
 */
export function chipActivationMode(e: ChipActivationModifiers | null | undefined, platform = ''): ChipActivationMode {
  if (!e) return 'focus'
  const isMac = /mac|iphone|ipad|ipod/i.test(platform)
  const hasPrimaryModifier = isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
  if (!hasPrimaryModifier) return 'focus'
  return e.shiftKey ? 'new-foreground' : 'new-background'
}
