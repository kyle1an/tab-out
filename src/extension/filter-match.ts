import { getRealTabs } from './tabs.js'
import { isGroupedTab } from './groups.js'

import type { DashboardTab } from './types'

export function tabMatchesFilter(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>, filter: string): boolean {
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
export function getFilteredCloseableUrls(realTabs: DashboardTab[] = getRealTabs(), filter = ''): string[] {
  if (!filter) return []
  return realTabs
    .filter((t) => !t.isApp)
    .filter((t) => !isGroupedTab(t))
    .filter((t) => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
    .filter((t) => tabMatchesFilter(t, filter))
    .map((t) => t.url)
}
