import { makeDashboardItem } from './dashboard-item.js'
import type { DashboardTab } from './types'

type HistoryItemLike = Pick<chrome.history.HistoryItem, 'id' | 'title' | 'url'>

const HISTORY_MAX_RESULTS = 100

export type HistorySourceSearchResult = {
  status: 'ready' | 'error'
  tabs: DashboardTab[]
}

function historyItemDisplayTitle(item: HistoryItemLike & { url: string }): string {
  const title = (item.title || '').trim()
  if (title) return title
  const parsed = URL.parse(item.url)
  if (!parsed) return item.url
  if (parsed.pathname && parsed.pathname !== '/') return parsed.pathname
  return parsed.hostname || item.url
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
      // Chrome may omit titles for redirect and OAuth history entries. Keep
      // those rows visible with a route label; never promote query data into
      // the title fallback.
      title: historyItemDisplayTitle(item),
      sourceType: 'history',
    }))
}

/**
 * Search recent Chrome history for the current filter text.
 *
 * @param {string} query
 * @param {number} startTime
 * @returns {Promise<HistorySourceSearchResult>}
 */
export async function fetchHistorySourceSearch(query: string, startTime: number): Promise<HistorySourceSearchResult> {
  const text = query.trim()
  if (!text) return { status: 'ready', tabs: [] }
  if (!globalThis.chrome?.history?.search) return { status: 'error', tabs: [] }

  try {
    const searchQuery = { text, startTime, maxResults: HISTORY_MAX_RESULTS }
    const items = await chrome.history.search(searchQuery)
    return { status: 'ready', tabs: flattenHistoryItems(items) }
  } catch {
    return { status: 'error', tabs: [] }
  }
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
