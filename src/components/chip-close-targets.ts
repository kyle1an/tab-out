/* ================================================================
   Group page-chip close targets — pure helpers for folded targets
   and History deletion completion.

   Pure and dependency-light (like tab-activation.ts) so it is
   unit-testable without React, the DOM, or a real chrome.tabs.
   ================================================================ */

import type { DashboardChipEnv } from '../extension/types'
import { pageChipTargetClosable } from '../extension/page-chip-target-policy.js'

type HistoryDeleteCompletion = {
  deletedCount: number
}

export function foldedTabCloseTargets(
  envs: readonly DashboardChipEnv[],
): DashboardChipEnv[] {
  return envs.filter(pageChipTargetClosable)
}

export function historyDeleteFullyRemoved(
  requestedCount: number,
  result: HistoryDeleteCompletion | null,
): boolean {
  return requestedCount === 0 || result?.deletedCount === requestedCount
}
