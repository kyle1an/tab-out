import type { DashboardCardEntry, DashboardData, DashboardSource, WorkingSetSnapshot } from '../extension/types'

export type StartupTiming = {
  kind: 'timing'
  label: string
  t: number
  durationMs?: number
  detail?: Record<string, unknown>
}

export type StartupOrderDebugCapture = {
  enabledAt: string
  samples: unknown[]
  shifts: unknown[]
  timings: StartupTiming[]
}

export type StartupOrderVmSampleOptions = {
  dashboard: DashboardData | null
  filter: string
  isReady: boolean
  matchedCards: DashboardCardEntry[]
  source: DashboardSource
  workingSet?: WorkingSetSnapshot | null
}
