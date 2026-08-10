import type { DashboardSource } from './types'

export type DashboardView = 'open-saved' | 'all-tabs' | 'bookmarks'

export const DEFAULT_DASHBOARD_VIEW: DashboardView = 'all-tabs'

export function dashboardViewOptionId(view: DashboardView): string {
  return `dashboard-view-option-${view}`
}

export function dashboardViewFromValue(value: string | null | undefined): DashboardView {
  if (value === 'open-saved' || value === 'all-tabs' || value === 'bookmarks') return value
  return DEFAULT_DASHBOARD_VIEW
}

export function dashboardSourceForView(view: DashboardView): DashboardSource {
  return view === 'bookmarks' ? 'bookmarks' : 'tabs'
}
