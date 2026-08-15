import {
  compileSameTitlePageChip,
  resolveSameTitlePageChip,
} from '../../src/extension/same-title-page-chip-plan.js'
import type { DashboardChipData, SameTitlePageChipPlan } from '../../src/extension/types.js'

export function sameTitlePageChipPlan(
  targets: readonly DashboardChipData[],
): SameTitlePageChipPlan {
  const result = compileSameTitlePageChip(targets)
  if (!result.ok) throw new Error(`Could not compile same-title Page Chip plan: ${result.reason}`)
  return result.plan
}

export function sameTitlePageChipTargets(
  plan: SameTitlePageChipPlan | undefined,
): readonly DashboardChipData[] {
  if (!plan) return []
  const decision = resolveSameTitlePageChip(plan, { kind: 'debug-targets' })
  return decision.kind === 'debug-targets'
    ? decision.exactTargets.map(({ target }) => target)
    : []
}
