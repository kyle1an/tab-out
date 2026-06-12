/* ================================================================
   Page-chip suspend targets — pure helpers deciding when the
   "Suspend" context-menu item shows (the chip can represent a live
   tab) and when it is enabled (>=1 live, not-already-suspended tab).

   Pure and dependency-light (like chip-close-targets.ts) so it is
   unit-testable without React, the DOM, or a real chrome.tabs.
   ================================================================ */

import type { DashboardChipData, DashboardChipEnv } from '../extension/types'
import { isSuspended } from '../extension/suspension.js'

type SuspendEnvLike = Pick<DashboardChipEnv, 'sourceType' | 'closedSaved' | 'tabUrl' | 'rawUrl'>

export type SuspendChipLike = Pick<DashboardChipData, 'sourceType' | 'closedSaved' | 'tabUrl' | 'rawUrl'> & {
  envs?: ReadonlyArray<SuspendEnvLike> | null
  titleVariantChips?: ReadonlyArray<unknown>
}

function chipIsFolded(chip: SuspendChipLike): boolean {
  return Array.isArray(chip.envs) && chip.envs.length > 0
}

function chipIsTitleVariantGroup(chip: SuspendChipLike): boolean {
  return Array.isArray(chip.titleVariantChips) && chip.titleVariantChips.length > 1
}

function envIsTabEnv(env: SuspendEnvLike): boolean {
  return (env.sourceType === undefined || env.sourceType === 'tab') && !env.closedSaved
}

/** chipCanShowSuspend — the chip could represent a live tab (visibility). */
export function chipCanShowSuspend(chip: SuspendChipLike): boolean {
  if (chipIsTitleVariantGroup(chip)) return false
  if (chipIsFolded(chip)) return (chip.envs ?? []).some(envIsTabEnv)
  return chip.sourceType === 'tab' && !chip.closedSaved
}

/** chipSuspendableTargetCount — count of live, not-already-suspended tabs (enabled when > 0). */
export function chipSuspendableTargetCount(chip: SuspendChipLike): number {
  if (chipIsTitleVariantGroup(chip)) return 0
  if (chipIsFolded(chip)) {
    return (chip.envs ?? []).filter((env) => envIsTabEnv(env) && !isSuspended(env.rawUrl, env.tabUrl)).length
  }
  if (chip.sourceType === 'tab' && !chip.closedSaved && !isSuspended(chip.rawUrl, chip.tabUrl)) return 1
  return 0
}
