/** @typedef {import('./types').DashboardTab} DashboardTab */

const HISTORY_MAX_RESULTS = 30

export const DEFAULT_HISTORY_RANGE = '1d'
export const HISTORY_FILTER_OFF = 'off'
export const HISTORY_RANGE_OPTIONS = [
  { value: HISTORY_FILTER_OFF, label: 'History off', days: 0 },
  { value: '1d', label: 'Last day', days: 1 },
  { value: '7d', label: 'Last week', days: 7 },
  { value: '30d', label: 'Last month', days: 30 },
  { value: '90d', label: 'Last 3 months', days: 90 }
]

export function isHistoryFilterEnabled(range = DEFAULT_HISTORY_RANGE) {
  return range !== HISTORY_FILTER_OFF
}

function historyRangeDays(range = DEFAULT_HISTORY_RANGE) {
  return HISTORY_RANGE_OPTIONS.find((option) => option.value === range)?.days || 90
}

/**
 * Turn Chrome history items into read-only DashboardTab-shaped entries so the
 * existing grouping/render pipeline can show them beside bookmarks.
 *
 * @param {Array<{ id?: string, title?: string, url?: string }>} items
 * @returns {DashboardTab[]}
 */
export function flattenHistoryItems(items) {
  return (items || [])
    .filter((item) => item?.url && !item.url.startsWith('chrome://') && !item.url.startsWith('chrome-extension://'))
    .map((item, index) => ({
      id: item.id || `history-${index}`,
      url: item.url,
      rawUrl: item.url,
      suspended: false,
      title: item.title || '',
      favIconUrl: '',
      windowId: 1,
      active: false,
      pinned: false,
      groupId: -1,
      isTabOut: false,
      isApp: false,
      sourceType: 'history'
    }))
}

/**
 * Search recent Chrome history for the current filter text.
 *
 * @param {string} query
 * @param {string} [range]
 * @returns {Promise<DashboardTab[]>}
 */
export async function fetchHistorySourceItems(query = '', range = DEFAULT_HISTORY_RANGE) {
  const text = query.trim()
  if (!text || !isHistoryFilterEnabled(range) || !globalThis.chrome?.history?.search) return []

  try {
    const startTime = Date.now() - historyRangeDays(range) * 24 * 60 * 60 * 1000
    const items = await chrome.history.search({
      text,
      startTime,
      maxResults: HISTORY_MAX_RESULTS
    })
    return flattenHistoryItems(items)
  } catch {
    return []
  }
}

/**
 * Delete every visit for a URL from Chrome history.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function deleteHistorySourceUrl(url = '') {
  const targetUrl = url.trim()
  if (!targetUrl || !globalThis.chrome?.history?.deleteUrl) return false

  try {
    await chrome.history.deleteUrl({ url: targetUrl })
    return true
  } catch {
    return false
  }
}
