import { isReadOnlyDashboardSourceType } from './dashboard-source.js'
import type { DashboardTab } from './types.js'

type PageChipPolicyTarget = {
  closedSaved?: DashboardTab['closedSaved']
  saved?: DashboardTab['saved']
  sourceType?: DashboardTab['sourceType']
}

type PageChipTargetActionPolicyOptions = {
  interactive?: boolean
}

export type PageChipTargetActionPolicy = {
  canClose: boolean
  canRemoveRetained: boolean
  canToggleSaved: boolean
  canUseChromeTabActions: boolean
  showSavedHint: boolean
}

export function pageChipTargetActionPolicy(
  target: PageChipPolicyTarget,
  { interactive = true }: PageChipTargetActionPolicyOptions = {},
): PageChipTargetActionPolicy {
  const closedSaved = target.sourceType === 'saved-page' ||
    target.sourceType === 'retained-page' ||
    !!target.closedSaved
  const canToggleSaved = interactive && (
    target.sourceType === 'tab' ||
    target.sourceType === 'saved-page' ||
    target.sourceType === 'retained-page'
  )

  return {
    canClose: interactive &&
      !closedSaved &&
      (!isReadOnlyDashboardSourceType(target.sourceType) || target.sourceType === 'history'),
    canRemoveRetained: interactive && target.sourceType === 'retained-page',
    canToggleSaved,
    canUseChromeTabActions: interactive && target.sourceType === 'tab' && !closedSaved,
    showSavedHint: interactive && !!target.saved && !canToggleSaved,
  }
}

export function pageChipTargetClosable(target: PageChipPolicyTarget): boolean {
  return pageChipTargetActionPolicy(target).canClose
}

export function pageChipCloseLeavesSavedPage(target: PageChipPolicyTarget): boolean {
  return !!target.saved && (target.sourceType ?? 'tab') === 'tab' && !target.closedSaved
}

export function groupCloseActionLabel({
  historyCount,
  tabCount,
}: {
  historyCount: number
  tabCount: number
}): string {
  if (tabCount > 0 && historyCount > 0) {
    const closeLabel = tabCount > 1 ? `Close ${tabCount} tabs` : 'Close 1 tab'
    const deleteLabel = historyCount > 1
      ? `delete ${historyCount} from history`
      : 'delete 1 from history'
    return `${closeLabel} and ${deleteLabel}`
  }
  if (historyCount > 0) {
    return historyCount > 1 ? `Delete ${historyCount} from history` : 'Delete from history'
  }
  return tabCount > 1 ? `Close ${tabCount} tabs` : 'Close this tab'
}
