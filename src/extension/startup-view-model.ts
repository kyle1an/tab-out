import { createPinnedPageChipIndex } from './page-chip-pins.js'
import { buildDashboardViewModel, dashboardChipPriorityFromWorkingSet } from './render.js'
import type { DashboardLocalState } from '../hooks/useDashboardLocalState'
import type { DashboardStartupSnapshot, DashboardStartupViewModel } from './startup-snapshot.js'

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
