import { createPinnedPageChipIndex } from './page-chip-pins.js'
import { normalizeChromeTabToDashboardItem } from './dashboard-tab-normalization.js'
import { buildDashboardViewModel, dashboardChipPriorityFromWorkingSet } from './render.js'
import type { DashboardLocalState } from './dashboard-local-state.js'
import { applyPinnedDomainsToDashboardGroups } from './startup-snapshot.js'
import type { DashboardStartupSnapshot, DashboardStartupViewModel } from './startup-snapshot.js'
import type { DashboardTab, DomainGroup } from './types'

export function buildDashboardStartupViewModel(snapshot: DashboardStartupSnapshot, localState: DashboardLocalState | null): DashboardStartupViewModel {
  const pinnedDomains = localState?.loaded ? localState.pinnedDomains : []
  const pinnedPageChipIds = localState?.loaded ? localState.pinnedPageChipIds : []
  const pinnedSectionIds = localState?.loaded ? localState.pinnedSectionIds : []
  return {
    pinnedDomains,
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
  const normalized = normalizeChromeTabToDashboardItem(
    { ...tab, title: tab.title || 'Tab Out' },
    { runtimeId: globalThis.chrome?.runtime?.id ?? null }
  )
  return {
    ...normalized,
    isTabOut: true,
    isApp: false
  }
}

function sameDashboardTabState(left: DashboardTab, right: DashboardTab): boolean {
  return left.id === right.id &&
    left.url === right.url &&
    left.rawUrl === right.rawUrl &&
    left.suspended === right.suspended &&
    left.title === right.title &&
    left.status === right.status &&
    left.retainedSuspendedTitle === right.retainedSuspendedTitle &&
    left.favIconUrl === right.favIconUrl &&
    left.windowId === right.windowId &&
    left.active === right.active &&
    left.pinned === right.pinned &&
    left.groupId === right.groupId &&
    left.isTabOut === right.isTabOut &&
    left.isApp === right.isApp &&
    left.audible === right.audible &&
    left.muted === right.muted &&
    left.index === right.index
}

function withTabOutGroup(
  groups: DomainGroup[],
  tab: DashboardTab,
  pinnedDomains: readonly string[] | null
): DomainGroup[] {
  const pinned = pinnedDomains?.includes('__tab-out__') ?? false
  let found = false
  const nextGroups = groups.map((group) => {
    if (group.domain !== '__tab-out__') return group
    found = true
    return { ...group, pinned: group.pinned || pinned, tabs: [...group.tabs, tab] }
  })
  if (!found) nextGroups.push({ domain: '__tab-out__', label: 'New tabs', tabs: [tab], ...(pinned ? { pinned } : {}) })
  return pinnedDomains
    ? applyPinnedDomainsToDashboardGroups(nextGroups, pinnedDomains)
    : nextGroups
}

export function addCurrentTabOutPageToStartupSnapshot(
  snapshot: DashboardStartupSnapshot,
  currentTab: chrome.tabs.Tab,
  localState: DashboardLocalState | null
): DashboardStartupSnapshot {
  const tab = dashboardTabFromCurrentTabOutPage(currentTab)
  if (!tab) return snapshot
  const pinnedDomains = localState?.loaded === true ? localState.pinnedDomains : null
  const cachedCurrentTab = tab.id === undefined
    ? null
    : snapshot.dashboard.realTabs.find((existing) => existing.id === tab.id) ?? null
  if (cachedCurrentTab) {
    const cachedCurrentGroupTab = snapshot.dashboard.domainGroups
      .find((group) => group.domain === '__tab-out__')
      ?.tabs.find((existing) => existing.id === tab.id)
    const cachedTabOutIdentityIsConsistent = cachedCurrentTab.isTabOut && !!cachedCurrentGroupTab?.isTabOut
    if (
      cachedTabOutIdentityIsConsistent &&
      snapshot.dashboard.currentWindowId === tab.windowId &&
      sameDashboardTabState(cachedCurrentTab, tab) &&
      !!cachedCurrentGroupTab &&
      sameDashboardTabState(cachedCurrentGroupTab, tab)
    ) return snapshot
    const replaceCurrentTab = (candidate: DashboardTab) => candidate.id === tab.id ? tab : candidate
    const nextRealTabs = cachedTabOutIdentityIsConsistent
      ? snapshot.dashboard.realTabs.map(replaceCurrentTab)
      : [...snapshot.dashboard.realTabs.filter((candidate) => candidate.id !== tab.id), tab]
    const groupsWithoutReusedId = snapshot.dashboard.domainGroups
      .map((group) => ({
        ...group,
        tabs: group.tabs.filter((candidate) => candidate.id !== tab.id)
      }))
      .filter((group) => group.tabs.length > 0)
    const nextGroups = cachedTabOutIdentityIsConsistent
      ? snapshot.dashboard.domainGroups.map((group) => ({
          ...group,
          tabs: group.tabs.map(replaceCurrentTab)
        }))
      : withTabOutGroup(groupsWithoutReusedId, tab, pinnedDomains)
    const nextSnapshot = {
      ...snapshot,
      dashboard: {
        ...snapshot.dashboard,
        currentWindowId: tab.windowId,
        realTabs: nextRealTabs,
        domainGroups: nextGroups
      }
    }
    return {
      ...nextSnapshot,
      startupViewModel: buildDashboardStartupViewModel(nextSnapshot, localState)
    }
  }

  const nextSnapshot = {
    ...snapshot,
    dashboard: {
      ...snapshot.dashboard,
      currentWindowId: tab.windowId,
      realTabs: [...snapshot.dashboard.realTabs, tab],
      domainGroups: withTabOutGroup(snapshot.dashboard.domainGroups, tab, pinnedDomains)
    }
  }
  return {
    ...nextSnapshot,
    startupViewModel: buildDashboardStartupViewModel(nextSnapshot, localState)
  }
}
