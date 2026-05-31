import { isGroupedTab, scoreForKeep } from './groups.js'

export type DedupeTabCandidate = {
  id?: number | string
  url?: string
  groupId?: number
  active?: boolean
  pinned?: boolean
  windowId: number
  index?: number
}

export type DuplicateCloseOptions = {
  keepOne?: boolean
  currentWindowId?: number
  preservePinned?: boolean
  preservePinnedTabOut?: boolean
  isTabOutUrl?: (url?: string) => boolean
}

export type DuplicateCountOptions = {
  isTabOutGroup?: boolean
  currentWindowId?: number | null
  isTabOutUrl?: (url?: string) => boolean
}

function isCurrentTabOutPage(tab: DedupeTabCandidate, currentWindowId: number, isTabOutUrl: (url?: string) => boolean): boolean {
  return currentWindowId >= 0 && tab.active === true && tab.windowId === currentWindowId && isTabOutUrl(tab.url)
}

export function countClosableDuplicateExtras(
  tabs: readonly DedupeTabCandidate[],
  { isTabOutGroup = false, currentWindowId = -1, isTabOutUrl = () => isTabOutGroup }: DuplicateCountOptions = {}
): number {
  if (tabs.length < 2) return 0

  return pickDuplicateTabsToClose(tabs, {
    currentWindowId: typeof currentWindowId === 'number' ? currentWindowId : -1,
    preservePinnedTabOut: isTabOutGroup,
    isTabOutUrl
  }).length
}

export function pickDuplicateTabsToClose<Tab extends DedupeTabCandidate>(
  matching: readonly Tab[],
  {
    keepOne = true,
    currentWindowId = -1,
    preservePinned = false,
    preservePinnedTabOut = false,
    isTabOutUrl = () => false
  }: DuplicateCloseOptions = {}
): Tab[] {
  if (matching.length === 0) return []
  const protectedCurrentTabOutTabs = preservePinnedTabOut
    ? matching.filter((tab) => isCurrentTabOutPage(tab, currentWindowId, isTabOutUrl))
    : []
  const withoutProtectedCurrentTabOut = (tabs: Tab[]): Tab[] =>
    protectedCurrentTabOutTabs.length > 0
      ? tabs.filter((tab) => !protectedCurrentTabOutTabs.includes(tab))
      : tabs
  const sortByScore = (tabs: readonly Tab[]) => tabs.slice().sort((a, b) => scoreForKeep(b, currentWindowId) - scoreForKeep(a, currentWindowId))
  const pickGroupAwareCloseTargets = (candidates: readonly Tab[], protectedCopyAlreadyKept: boolean): Tab[] => {
    const grouped = candidates.filter((tab) => isGroupedTab(tab))
    const ungrouped = candidates.filter((tab) => !isGroupedTab(tab))

    if (grouped.length >= 1 && ungrouped.length >= 1) return withoutProtectedCurrentTabOut(ungrouped)
    if (ungrouped.length >= 2) {
      if (protectedCopyAlreadyKept) return withoutProtectedCurrentTabOut(ungrouped)
      const keep = sortByScore(ungrouped)[0]
      return keep ? withoutProtectedCurrentTabOut(ungrouped.filter((tab) => tab.id !== keep.id)) : []
    }
    if (ungrouped.length === 1 && protectedCopyAlreadyKept) return withoutProtectedCurrentTabOut(ungrouped)
    if (grouped.length >= 2) {
      const distinctGroups = new Set(grouped.map((tab) => tab.groupId))
      if (distinctGroups.size === 1) {
        const keep = sortByScore(grouped)[0]
        return keep ? withoutProtectedCurrentTabOut(grouped.filter((tab) => tab.id !== keep.id)) : []
      }
    }

    return []
  }

  if (preservePinned || preservePinnedTabOut) {
    const pinned = matching.filter((tab) => tab.pinned && (preservePinned || isTabOutUrl(tab.url)))
    if (pinned.length >= 1) {
      const pinnedIds = new Set(pinned.map((tab) => tab.id))
      return pickGroupAwareCloseTargets(matching.filter((tab) => !pinnedIds.has(tab.id)), true)
    }
  }

  if (!keepOne) return withoutProtectedCurrentTabOut(matching.slice())
  return pickGroupAwareCloseTargets(matching, false)
}
