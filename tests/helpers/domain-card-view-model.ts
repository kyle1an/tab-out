import { computeDomainCardViewModel } from '../../src/extension/domain-card-view-model.js'
import type {
  DashboardCardVM,
  DashboardChipData,
  DashboardTab,
  DomainGroup
} from '../../src/extension/types'

export function makeDashboardTab(
  overrides: Partial<DashboardTab> & { url: string }
): DashboardTab {
  return {
    url: overrides.url,
    rawUrl: overrides.url,
    suspended: false,
    title: overrides.title ?? overrides.url,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...overrides
  }
}

export function collectDashboardChips(vm: DashboardCardVM): DashboardChipData[] {
  const chips: DashboardChipData[] = []
  for (const section of vm.sections ?? []) {
    chips.push(...section.flatVisibleChips, ...section.flatHiddenChips)
    for (const cluster of section.clusters) {
      chips.push(...cluster.visibleChips, ...cluster.hiddenChips)
    }
    for (const websitePathSection of section.websitePathSections) {
      chips.push(
        ...websitePathSection.flatVisibleChips,
        ...websitePathSection.flatHiddenChips
      )
      for (const cluster of websitePathSection.clusters) {
        chips.push(...cluster.visibleChips, ...cluster.hiddenChips)
      }
    }
  }
  return chips
}

export function dashboardChipFor(
  tabs: DashboardTab[],
  url: string,
  domain = 'example.com'
): DashboardChipData | undefined {
  const group: DomainGroup = { domain, tabs }
  const vm = computeDomainCardViewModel(group, {
    currentWindowId: 1,
    allowMutations: false
  })
  return collectDashboardChips(vm).find((chip) => chip.tabUrl === url)
}
