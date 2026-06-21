import { createPinnedPageChipIndex } from './page-chip-pins.js'
import { buildDashboardViewModel, dashboardChipPriorityFromWorkingSet } from './render.js'
import type { DashboardLocalState } from '../hooks/useDashboardLocalState'
import type { DashboardStartupSnapshot, DashboardStartupViewModel } from './startup-snapshot.js'
import type { DashboardTab, DomainGroup } from './types'

export function buildDashboardStartupViewModel(snapshot: DashboardStartupSnapshot, localState: DashboardLocalState | null): DashboardStartupViewModel {
  const pinnedPageChipIds = localState?.loaded ? localState.pinnedPageChipIds : []
  const pinnedSectionIds = localState?.loaded ? localState.pinnedSectionIds : []
  return {
    pinnedPageChipIds,
    pinnedSectionIds,
    viewModel: buildDashboardViewModel({
      realTabs: snapshot.dashboard.realTabs,
      domainGroups: snapshot.dashboard.domainGroups,
      filter: '',
      source: 'tabs',
      currentWindowId: snapshot.dashboard.currentWindowId ?? null,
      chipPriority: dashboardChipPriorityFromWorkingSet(snapshot.workingSet),
      pinnedSections: new Set(pinnedSectionIds),
      pinnedPageChips: createPinnedPageChipIndex(pinnedPageChipIds)
    })
  }
}

function dashboardTabFromCurrentTabOutPage(tab: chrome.tabs.Tab): DashboardTab | null {
  const rawUrl = tab.url || ''
  if (!rawUrl) return null
  return {
    id: tab.id,
    url: rawUrl,
    rawUrl,
    suspended: false,
    title: tab.title || 'Tab Out',
    favIconUrl: tab.favIconUrl || '',
    windowId: tab.windowId,
    active: !!tab.active,
    pinned: !!tab.pinned,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    isTabOut: true,
    isApp: false,
    audible: !!tab.audible,
    muted: !!tab.mutedInfo?.muted,
    index: tab.index
  }
}

function withTabOutGroup(groups: DomainGroup[], tab: DashboardTab, pinned: boolean): DomainGroup[] {
  let found = false
  const nextGroups = groups.map((group) => {
    if (group.domain !== '__tab-out__') return group
    found = true
    return { ...group, pinned: group.pinned || pinned, tabs: [...group.tabs, tab] }
  })
  if (!found) nextGroups.push({ domain: '__tab-out__', label: 'New tabs', tabs: [tab], ...(pinned ? { pinned } : {}) })
  return nextGroups
}

export function addCurrentTabOutPageToStartupSnapshot(
  snapshot: DashboardStartupSnapshot,
  currentTab: chrome.tabs.Tab,
  localState: DashboardLocalState | null
): DashboardStartupSnapshot {
  const tab = dashboardTabFromCurrentTabOutPage(currentTab)
  if (!tab) return snapshot
  if (tab.id !== undefined && snapshot.dashboard.realTabs.some((existing) => existing.id === tab.id)) return snapshot
  const tabOutPinned = localState?.loaded === true && localState.pinnedDomains.includes('__tab-out__')

  const nextSnapshot = {
    ...snapshot,
    dashboard: {
      ...snapshot.dashboard,
      currentWindowId: tab.windowId,
      realTabs: [...snapshot.dashboard.realTabs, tab],
      domainGroups: withTabOutGroup(snapshot.dashboard.domainGroups, tab, tabOutPinned)
    }
  }
  return {
    ...nextSnapshot,
    startupViewModel: buildDashboardStartupViewModel(nextSnapshot, localState)
  }
}
