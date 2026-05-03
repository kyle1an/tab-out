import { getRealTabs } from './tabs.js'
import { isGroupedTab } from './groups.js'

/** @typedef {import('./types').DashboardTab} DashboardTab */

/**
 * @param {Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>} tab
 * @param {string} filter
 * @returns {boolean}
 */
export function tabMatchesFilter(tab, filter) {
  if (!filter) return true
  const q = filter.toLowerCase()
  const rawTitle = tab.title || ''
  const searchableTitle = tab.isTabOut ? rawTitle.replace(/^.+ - Tab Out$/i, 'Tab Out') : rawTitle
  let searchableUrl = tab.url || ''
  if (tab.isTabOut) {
    try {
      const parsed = new URL(searchableUrl)
      parsed.search = ''
      searchableUrl = parsed.toString()
    } catch {}
  }
  const title = searchableTitle.toLowerCase()
  const url = searchableUrl.toLowerCase()
  return title.includes(q) || url.includes(q)
}

/**
 * getFilteredCloseableUrls(realTabs, filter) — URLs of tabs the global
 * "Close N filtered tabs" action should close: filter-matching,
 * ungrouped, non-chrome. Returns [] when no filter is active.
 */
/**
 * @param {DashboardTab[]} [realTabs]
 * @param {string} [filter]
 * @returns {string[]}
 */
export function getFilteredCloseableUrls(realTabs = getRealTabs(), filter = '') {
  if (!filter) return []
  return realTabs
    .filter((t) => !t.isApp)
    .filter((t) => !isGroupedTab(t))
    .filter((t) => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
    .filter((t) => tabMatchesFilter(t, filter))
    .map((t) => t.url)
}
