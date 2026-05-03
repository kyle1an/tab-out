export const FOCUS_FILTER_PARAM = 'focusFilter'
export const FILTER_PARAM = 'filter'
export const DEFAULT_PAGE_TITLE = '\u200e'

export function titleForFilterInput(filterInput = '') {
  const keyword = filterInput.trim()
  return keyword ? `${keyword} - Tab Out` : DEFAULT_PAGE_TITLE
}

export function filterInputFromSearch(search = '') {
  return new URLSearchParams(search).get(FILTER_PARAM) || ''
}

export function urlForFilterInput(filterInput = '', locationParts = {}) {
  const { pathname = '', search = '', hash = '' } = locationParts
  const params = new URLSearchParams(search)
  if (filterInput === '') params.delete(FILTER_PARAM)
  else params.set(FILTER_PARAM, filterInput)

  const nextSearch = params.toString()
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash || ''}`
}

export function isFilterFocusShortcut(e, platform = '') {
  if (!e || (e.key || '').toLowerCase() !== 'k' || e.altKey || e.shiftKey) return false
  const isMac = /mac|iphone|ipad|ipod/i.test(platform)
  return isMac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey
}
