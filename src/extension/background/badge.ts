import type { ChromeApi } from './chrome-api.js'

/**
 * Counts open real-web tabs and updates the extension toolbar badge.
 * "Real" tabs = not browser internals, extension pages, or about:blank.
 */
export async function updateBadge(chromeApi: ChromeApi = chrome): Promise<void> {
  try {
    const tabs = await chromeApi.tabs.query({})

    const count = tabs.filter((t) => {
      const url = t.url || ''
      return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('about:') && !url.startsWith('edge://') && !url.startsWith('brave://')
    }).length

    await chromeApi.action.setBadgeText({ text: count > 0 ? String(count) : '' })

    if (count === 0) return

    let color: string
    if (count <= 10) {
      color = '#3d7a4a'
    } else if (count <= 20) {
      color = '#b8892e'
    } else {
      color = '#b35a5a'
    }

    await chromeApi.action.setBadgeBackgroundColor({ color })
  } catch {
    chromeApi.action.setBadgeText({ text: '' })
  }
}
