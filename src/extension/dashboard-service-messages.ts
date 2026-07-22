import type { ChromeOpenTabsSnapshot } from './tabs.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from './types'

export const DASHBOARD_SERVICE_STATE_GET_MESSAGE = 'tab-out:get-dashboard-service-state'

/** One worker-owned browser generation shared by dashboard, history, and Working Set composition. */
export type CapturedDashboardServiceState = {
  tabHistory: TabHistorySnapshot
  workingSetActivity: WorkingSetActivityStore
  openTabsSnapshot: ChromeOpenTabsSnapshot
}
