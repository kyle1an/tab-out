import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from './dashboard-service-messages.js'
import type { CapturedDashboardServiceState } from './dashboard-service-messages.js'
import { normalizeTabHistorySnapshot } from './tab-history.js'
import { emptyWorkingSetActivity, normalizeWorkingSetActivity } from './working-set.js'
import type { ChromeOpenTabsSnapshot } from './tabs.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from './types'

type DashboardServiceState = Omit<CapturedDashboardServiceState, 'openTabsSnapshot'> & {
  openTabsSnapshot: ChromeOpenTabsSnapshot | null
}
export type DashboardServiceStateResult =
  | { ok: true; value: DashboardServiceState }
  | { ok: false; value: DashboardServiceState }
type ServiceStateResponse = { ok?: boolean; [key: string]: unknown }
type ValidServiceStateResponse = ServiceStateResponse & {
  ok: true
  openTabsSnapshot: ChromeOpenTabsSnapshot
  tabHistory: Record<string, unknown> & { entries: unknown[] }
  workingSetActivity: Record<string, unknown> & {
    version: 1
    records: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isDashboardServiceStateResponse(
  response: ServiceStateResponse | null | undefined
): response is ValidServiceStateResponse {
  if (!response?.ok || !isRecord(response.tabHistory) || !Array.isArray(response.tabHistory.entries)) return false
  return isRecord(response.workingSetActivity) &&
    response.workingSetActivity.version === 1 &&
    isRecord(response.workingSetActivity.records) &&
    normalizeOpenTabsSnapshot(response.openTabsSnapshot) !== null
}

function emptyDashboardServiceState(): DashboardServiceState {
  return {
    tabHistory: normalizeTabHistorySnapshot(null),
    workingSetActivity: emptyWorkingSetActivity(),
    openTabsSnapshot: null
  }
}

function normalizeOpenTabsSnapshot(value: unknown): ChromeOpenTabsSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Partial<ChromeOpenTabsSnapshot>
  if (!Array.isArray(snapshot.tabs) || !Array.isArray(snapshot.windows)) return null
  return { tabs: snapshot.tabs, windows: snapshot.windows }
}

export async function fetchDashboardServiceStateResult(): Promise<DashboardServiceStateResult> {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return { ok: false, value: emptyDashboardServiceState() }
  }

  let response: ServiceStateResponse | null | undefined
  try {
    response = await chrome.runtime.sendMessage({ type: DASHBOARD_SERVICE_STATE_GET_MESSAGE }) as ServiceStateResponse | null | undefined
  } catch {
    return { ok: false, value: emptyDashboardServiceState() }
  }
  if (!isDashboardServiceStateResponse(response)) {
    return { ok: false, value: emptyDashboardServiceState() }
  }

  return {
    ok: true,
    value: {
      tabHistory: normalizeTabHistorySnapshot(response.tabHistory as Partial<TabHistorySnapshot> | null | undefined),
      workingSetActivity: normalizeWorkingSetActivity(response.workingSetActivity as Partial<WorkingSetActivityStore> | null | undefined),
      // The response guard requires this exact capture. Keeping the fallback
      // nullable only serves failed compatibility callers; successful callers
      // never perform a second page-context browser read.
      openTabsSnapshot: normalizeOpenTabsSnapshot(response.openTabsSnapshot) as ChromeOpenTabsSnapshot
    }
  }
}
