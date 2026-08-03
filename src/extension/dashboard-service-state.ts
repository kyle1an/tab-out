import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from './dashboard-service-messages.js'
import type { CapturedDashboardServiceState } from './dashboard-service-messages.js'
import { parseDashboardServiceStateResponse } from './dashboard-service-state-schema.js'
import { normalizeTabHistorySnapshot } from './tab-history.js'
import { emptyWorkingSetActivity, normalizeWorkingSetActivity } from './working-set.js'
import type { ChromeOpenTabsSnapshot } from './tabs.js'

type DashboardServiceState = Omit<CapturedDashboardServiceState, 'openTabsSnapshot'> & {
  openTabsSnapshot: ChromeOpenTabsSnapshot | null
}
export type DashboardServiceStateResult =
  | { ok: true; value: DashboardServiceState }
  | { ok: false; value: DashboardServiceState }
function emptyDashboardServiceState(): DashboardServiceState {
  return {
    tabHistory: normalizeTabHistorySnapshot(null),
    workingSetActivity: emptyWorkingSetActivity(),
    openTabsSnapshot: null
  }
}

export async function fetchDashboardServiceStateResult(): Promise<DashboardServiceStateResult> {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return { ok: false, value: emptyDashboardServiceState() }
  }

  let response: unknown
  try {
    response = await chrome.runtime.sendMessage({ type: DASHBOARD_SERVICE_STATE_GET_MESSAGE })
  } catch {
    return { ok: false, value: emptyDashboardServiceState() }
  }
  const parsed = parseDashboardServiceStateResponse(response)
  if (!parsed) {
    return { ok: false, value: emptyDashboardServiceState() }
  }

  return {
    ok: true,
    value: {
      tabHistory: normalizeTabHistorySnapshot(parsed.tabHistory),
      workingSetActivity: normalizeWorkingSetActivity(parsed.workingSetActivity),
      openTabsSnapshot: parsed.openTabsSnapshot
    }
  }
}
