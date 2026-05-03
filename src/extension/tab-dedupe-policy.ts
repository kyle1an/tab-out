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

export function countClosableDuplicateExtras(tabs: readonly DedupeTabCandidate[], { isTabOutGroup = false } = {}): number {
  if (tabs.length < 2) return 0

  if (isTabOutGroup) {
    const pinnedCount = tabs.filter((tab) => tab.pinned).length
    const unpinnedCount = tabs.length - pinnedCount
    if (pinnedCount >= 1) return unpinnedCount
    if (unpinnedCount >= 2) return unpinnedCount - 1
    return 0
  }

  const ungrouped = tabs.filter((tab) => !isGroupedTab(tab)).length
  const grouped = tabs.length - ungrouped
  const groupIds = new Set(tabs.filter(isGroupedTab).map((tab) => tab.groupId))

  if (grouped >= 1 && ungrouped >= 1) return ungrouped
  if (grouped === 0 && ungrouped >= 2) return ungrouped - 1
  if (grouped >= 2 && groupIds.size === 1) return tabs.length - 1
  return 0
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

  if (preservePinned || preservePinnedTabOut) {
    const pinned = matching.filter((tab) => tab.pinned && (preservePinned || isTabOutUrl(tab.url)))
    if (pinned.length >= 1) {
      const pinnedIds = new Set(pinned.map((tab) => tab.id))
      return matching.filter((tab) => !pinnedIds.has(tab.id))
    }
  }

  if (!keepOne) return matching.slice()

  const grouped = matching.filter((tab) => isGroupedTab(tab))
  const ungrouped = matching.filter((tab) => !isGroupedTab(tab))
  const sortByScore = (tabs: readonly Tab[]) => tabs.slice().sort((a, b) => scoreForKeep(b, currentWindowId) - scoreForKeep(a, currentWindowId))

  if (grouped.length >= 1 && ungrouped.length >= 1) return ungrouped
  if (ungrouped.length >= 2) {
    const keep = sortByScore(ungrouped)[0]
    return keep ? ungrouped.filter((tab) => tab.id !== keep.id) : []
  }
  if (grouped.length >= 2) {
    const distinctGroups = new Set(grouped.map((tab) => tab.groupId))
    if (distinctGroups.size === 1) {
      const keep = sortByScore(grouped)[0]
      return keep ? grouped.filter((tab) => tab.id !== keep.id) : []
    }
  }

  return []
}
