/* ================================================================
   Tab audio state — pure derivation of Chrome's play/mute glyph.

   Chrome keeps `tab.audible` true even while a tab is muted, but the
   tab strip shows the muted glyph in that case. So `muted` always
   wins over `audible` when picking which icon to show.
   ================================================================ */

import type { TabAudioState } from './types'

type AudioFlags = { audible?: boolean; muted?: boolean }

/** Single tab → icon state. Muted wins; else audible → playing; else none. */
export function audioStateForTab({ audible, muted }: AudioFlags): TabAudioState {
  if (muted) return 'muted'
  if (audible) return 'playing'
  return null
}

/** Reduce several icon states into one. playing > muted > null. */
export function mergeAudioStates(states: ReadonlyArray<TabAudioState>): TabAudioState {
  if (states.includes('playing')) return 'playing'
  if (states.includes('muted')) return 'muted'
  return null
}

/** A chip can fold several tabs; aggregate their states into one glyph. */
export function aggregateAudioState(tabs: ReadonlyArray<AudioFlags>): TabAudioState {
  return mergeAudioStates(tabs.map(audioStateForTab))
}

/** Click direction: a playing icon mutes (true); a muted icon unmutes (false). */
export function nextMutedForAudioState(state: TabAudioState): boolean {
  return state === 'playing'
}
