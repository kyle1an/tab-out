import type { DashboardLocalState } from './extension/dashboard-local-state.js'
import { appDashboardStore } from './extension/dashboard-intake.js'
import type { DashboardStartupSnapshot } from './extension/startup-snapshot.js'

export type AppStartupState = {
  historyRange: string
  localState: DashboardLocalState
  snapshot: DashboardStartupSnapshot | null
}

let currentStartupState: AppStartupState | null = null
const startupListeners = new Set<() => void>()

export function applyAppStartup(nextState: AppStartupState): void {
  currentStartupState = nextState
  appDashboardStore.applyStartup({
    historyRange: nextState.historyRange,
    snapshot: nextState.snapshot
  })
  for (const listener of startupListeners) listener()
}

export function subscribeAppStartup(listener: () => void): () => void {
  startupListeners.add(listener)
  return () => startupListeners.delete(listener)
}

export function readAppStartup(): AppStartupState | null {
  return currentStartupState
}

export function readBuildTimeAppStartup(): null {
  return null
}
