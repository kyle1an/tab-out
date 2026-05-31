import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from './dashboard-service-messages.js'
import { normalizeTabHistorySnapshot } from './tab-history.js'
import { emptyWorkingSetActivity, normalizeWorkingSetActivity } from './working-set.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from './types'

export type DashboardServiceState = {
  tabHistory: TabHistorySnapshot
  workingSetActivity: WorkingSetActivityStore
}
type ServiceStateResponse = { ok?: boolean; [key: string]: unknown }

function emptyDashboardServiceState(): DashboardServiceState {
  return {
    tabHistory: normalizeTabHistorySnapshot(null),
    workingSetActivity: emptyWorkingSetActivity()
  }
}

export async function fetchDashboardServiceState(): Promise<DashboardServiceState> {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return emptyDashboardServiceState()
  }

  let response: ServiceStateResponse | null | undefined
  try {
    response = await chrome.runtime.sendMessage({ type: DASHBOARD_SERVICE_STATE_GET_MESSAGE }) as ServiceStateResponse | null | undefined
  } catch {
    return emptyDashboardServiceState()
  }
  if (!response?.ok) {
    return emptyDashboardServiceState()
  }

  return {
    tabHistory: normalizeTabHistorySnapshot(response.tabHistory as Partial<TabHistorySnapshot> | null | undefined),
    workingSetActivity: normalizeWorkingSetActivity(response.workingSetActivity as Partial<WorkingSetActivityStore> | null | undefined)
  }
}
