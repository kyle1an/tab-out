/* ================================================================
   Chip activation mode — classifies a (modifier) click/keydown on a
   page chip into one of four intents: focus the existing tab,
   move or open the URL in a new window, or bring the tab into the current
   window (in the background, or in the foreground and switch to it).

   Pure and platform-injected (like isFilterFocusShortcut in
   app-url.ts) so it is unit-testable without a real `navigator`.
   ================================================================ */

import { Effect } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { moveTabToCurrentWindowEffect, moveTabToNewWindowEffect } from './tab-move.js'
import { openTabUrlEffect, openTabUrlInNewWindowEffect } from './tabs.js'
import { showToast } from './toast.js'

export type ChipActivationMode = 'focus' | 'open-window' | 'bring-background' | 'bring-foreground'

export interface ChipActivationModifiers {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

/**
 * chipActivationMode(e, platform) — resolve a click/keydown into an intent:
 *   • no move modifier             → 'focus'            (switch to the existing tab)
 *   • Shift only                   → 'open-window'      (move/open in a new window)
 *   • primary modifier, no Shift    → 'bring-background' (move the tab into the current window)
 *   • primary modifier + Shift      → 'bring-foreground' (move it here and switch to it)
 *
 * The primary modifier is Cmd on macOS, Ctrl elsewhere, and the opposite key
 * must NOT be held — matching isFilterFocusShortcut so a cross-platform key
 * combo can't satisfy both branches. Shift on its own follows Chrome's
 * link-style new-window gesture, moving the live tab when one exists.
 *
 * @param {{ metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean } | null | undefined} e
 * @param {string} [platform]
 * @returns {ChipActivationMode}
 */
export function chipActivationMode(e: ChipActivationModifiers | null | undefined, platform = ''): ChipActivationMode {
  if (!e) return 'focus'
  const isMac = /mac|iphone|ipad|ipod/i.test(platform)
  const hasPrimaryModifier = isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
  if (!hasPrimaryModifier) return e.shiftKey && !e.metaKey && !e.ctrlKey ? 'open-window' : 'focus'
  return e.shiftKey ? 'bring-foreground' : 'bring-background'
}

/**
 * shouldSuppressSelectionForGesture(e, platform) — true when a pointer event
 * carries one of the special modifiers (i.e. chipActivationMode is not 'focus').
 *
 * The chip and history-row click targets are <div role="button"> whose title is
 * ordinary selectable text — unlike a real <a>/<button>, a <div> has no
 * activation behavior, so the browser starts a native text selection on the same
 * Shift-click and ⌘/⌃-click gestures we've overloaded.
 * Calling preventDefault() on mousedown when this returns true cancels that default for the gesture
 * only, so the surface behaves like a link while a plain click still drag-selects.
 *
 * @param {{ metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean } | null | undefined} e
 * @param {string} [platform]
 * @returns {boolean}
 */
export function shouldSuppressSelectionForGesture(e: ChipActivationModifiers | null | undefined, platform = ''): boolean {
  return chipActivationMode(e, platform) !== 'focus'
}

export type DashboardItemActivationTarget = {
  tabId?: number | string
  tabUrl: string
  rawUrl?: string
}

export type DashboardItemActivationOptions = {
  moveExisting?: boolean
}

export type DashboardItemActivationResult = 'unhandled' | 'handled' | 'failed'

function reportOpenFailure(): DashboardItemActivationResult {
  showToast('Could not open page')
  return 'failed'
}

/**
 * Perform the modifier-driven half of Dashboard Item activation. Plain focus
 * remains surface-specific because Page Chips, Working Set rows, history rows,
 * and closed ghosts resolve that intent differently.
 *
 * `unhandled` is reserved for the plain-focus mode so the caller can continue
 * with its local focus path. A failed modifier action remains terminal: falling
 * through could activate or open a different target than the user's gesture.
 */
const performDashboardItemActivationEffect = Effect.fn('tabActivation.perform')(function* (
  mode: ChipActivationMode,
  target: DashboardItemActivationTarget,
  { moveExisting = true }: DashboardItemActivationOptions = {},
) {
  if (mode === 'focus' || !target.tabUrl) return 'unhandled'

  if (mode === 'open-window') {
    if (!moveExisting) {
      return (yield* openTabUrlInNewWindowEffect(target.tabUrl)) ? 'handled' : reportOpenFailure()
    }
    const result = yield* moveTabToNewWindowEffect(target)
    if (result === 'failed') return reportOpenFailure()
    if (result === 'not-found' && !(yield* openTabUrlInNewWindowEffect(target.tabUrl))) {
      return reportOpenFailure()
    }
    return 'handled'
  }

  const activate = mode === 'bring-foreground'
  if (!moveExisting) {
    return (yield* openTabUrlEffect(target.tabUrl, { active: activate }))
      ? 'handled'
      : reportOpenFailure()
  }
  const result = yield* moveTabToCurrentWindowEffect(target, { activate })
  if (result === 'failed') return reportOpenFailure()
  if (result === 'not-found' && !(yield* openTabUrlEffect(target.tabUrl, { active: activate }))) {
    return reportOpenFailure()
  }
  return 'handled'
})

export function performDashboardItemActivation(
  mode: ChipActivationMode,
  target: DashboardItemActivationTarget,
  options: DashboardItemActivationOptions = {},
): Promise<DashboardItemActivationResult> {
  return getAppRuntime().runPromise(performDashboardItemActivationEffect(mode, target, options))
}
