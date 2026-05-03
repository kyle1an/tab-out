export const FOCUS_FILTER_PARAM = 'focusFilter'
export const FILTER_PARAM = 'filter'
export const DEFAULT_PAGE_TITLE = '\u200e'

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

export function titleForFilterInput(filterInput = ''): string {
  const keyword = filterInput.trim()
  return keyword ? `${keyword} - Tab Out` : DEFAULT_PAGE_TITLE
}

export function filterInputFromSearch(search = ''): string {
  return new URLSearchParams(search).get(FILTER_PARAM) || ''
}

export function urlForFilterInput(filterInput = '', locationParts: LocationParts = {}): string {
  const { pathname = '', search = '', hash = '' } = locationParts
  const params = new URLSearchParams(search)
  if (filterInput === '') params.delete(FILTER_PARAM)
  else params.set(FILTER_PARAM, filterInput)

  const nextSearch = params.toString()
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash || ''}`
}

export function isFilterFocusShortcut(e: ShortcutEvent, platform = ''): boolean {
  if (!e || (e.key || '').toLowerCase() !== 'k' || e.altKey || e.shiftKey) return false
  const isMac = /mac|iphone|ipad|ipod/i.test(platform)
  return isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
}
