import { makeDashboardItem } from './dashboard-item.js'
import { DEFAULT_HISTORY_RANGE, HISTORY_RANGE_OPTIONS, isHistoryFilterEnabled } from './history-range.js'
import type { DashboardTab } from './types'

export { DEFAULT_HISTORY_RANGE, HISTORY_FILTER_OFF, HISTORY_RANGE_OPTIONS, isHistoryFilterEnabled } from './history-range.js'

type HistoryItemLike = Pick<chrome.history.HistoryItem, 'id' | 'title' | 'url'>

const HISTORY_MAX_RESULTS = 30

export type HistorySourceSearchResult = {
  status: 'ready' | 'error'
  tabs: DashboardTab[]
}

function historyRangeDays(range = DEFAULT_HISTORY_RANGE): number | null {
  const option = HISTORY_RANGE_OPTIONS.find((candidate) => candidate.value === range)
  return option ? option.days : 90
}

/**
 * Turn Chrome history items into read-only DashboardTab-shaped entries so the
 * existing grouping/render pipeline can show them beside bookmarks.
 *
 * @param {Array<{ id?: string, title?: string, url?: string }>} items
 * @returns {DashboardTab[]}
 */
export function flattenHistoryItems(items: HistoryItemLike[]): DashboardTab[] {
  return (items || [])
    .filter((item): item is HistoryItemLike & { url: string } => !!item?.url && !item.url.startsWith('chrome://') && !item.url.startsWith('chrome-extension://'))
    .map((item, index) => makeDashboardItem({
      id: item.id || `history-${index}`,
      url: item.url,
      title: item.title || '',
      sourceType: 'history'
    }))
}

/**
 * Search recent Chrome history for the current filter text.
 *
 * @param {string} query
 * @param {string} [range]
 * @returns {Promise<HistorySourceSearchResult>}
 */
export async function fetchHistorySourceSearch(query = '', range = DEFAULT_HISTORY_RANGE): Promise<HistorySourceSearchResult> {
  const text = query.trim()
  if (!text || !isHistoryFilterEnabled(range)) return { status: 'ready', tabs: [] }
  if (!globalThis.chrome?.history?.search) return { status: 'error', tabs: [] }

  try {
    const days = historyRangeDays(range)
    const startTime = days === null
      ? 0
      : Date.now() - days * 24 * 60 * 60 * 1000
    const searchQuery = { text, startTime, maxResults: HISTORY_MAX_RESULTS }
    const items = await chrome.history.search(searchQuery)
    return { status: 'ready', tabs: flattenHistoryItems(items) }
  } catch {
    return { status: 'error', tabs: [] }
  }
}

export async function fetchHistorySourceItems(query = '', range = DEFAULT_HISTORY_RANGE): Promise<DashboardTab[]> {
  return (await fetchHistorySourceSearch(query, range)).tabs
}

/**
 * Delete every visit for a URL from Chrome history.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function deleteHistorySourceUrl(url = ''): Promise<boolean> {
  const targetUrl = url.trim()
  if (!targetUrl || !globalThis.chrome?.history?.deleteUrl) return false

  try {
    await chrome.history.deleteUrl({ url: targetUrl })
    return true
  } catch {
    return false
  }
}
