import { DEFAULT_DASHBOARD_VIEW, dashboardViewFromValue, type DashboardView } from './dashboard-view.js'

export const FOCUS_FILTER_PARAM = 'focusFilter'
const FILTER_PARAM = 'filter'
const VIEW_PARAM = 'view'
const DEFAULT_PAGE_TITLE = '\u200e'

type LocationParts = {
  pathname?: string
  search?: string
  hash?: string
}

type ShortcutEvent = {
  key?: string
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
} | null | undefined

function urlWithSearchParam(
  name: string,
  value: string,
  omittedValue: string,
  locationParts: LocationParts,
): string {
  const { pathname = '', search = '', hash = '' } = locationParts
  const params = new URLSearchParams(search)
  if (value === omittedValue) params.delete(name)
  else params.set(name, value)

  const nextSearch = params.toString()
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash || ''}`
}

export function titleForFilterInput(filterInput = ''): string {
  const keyword = filterInput.trim()
  return keyword ? `${keyword} - Tab Out` : DEFAULT_PAGE_TITLE
}

export function filterInputFromSearch(search = ''): string {
  return new URLSearchParams(search).get(FILTER_PARAM) || ''
}

export function dashboardViewFromSearch(search = ''): DashboardView {
  return dashboardViewFromValue(new URLSearchParams(search).get(VIEW_PARAM))
}

export function urlForFilterInput(filterInput = '', locationParts: LocationParts = {}): string {
  return urlWithSearchParam(FILTER_PARAM, filterInput, '', locationParts)
}

export function urlForDashboardView(
  view: DashboardView = DEFAULT_DASHBOARD_VIEW,
  locationParts: LocationParts = {},
): string {
  return urlWithSearchParam(VIEW_PARAM, view, DEFAULT_DASHBOARD_VIEW, locationParts)
}

export function isFilterFocusShortcut(e: ShortcutEvent, platform = ''): boolean {
  if (!e || (e.key || '').toLowerCase() !== 'k' || e.altKey || e.shiftKey) return false
  const isMac = /mac|iphone|ipad|ipod/i.test(platform)
  return isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
}
