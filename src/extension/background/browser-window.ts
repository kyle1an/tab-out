import type { ChromeApi } from './chrome-api.js'

export async function findNormalBrowserWindow(chromeApi: ChromeApi): Promise<chrome.windows.Window | null> {
  try {
    const lastFocusedNormal = await chromeApi.windows.getLastFocused({ windowTypes: ['normal'] })
    if (typeof lastFocusedNormal?.id === 'number') return lastFocusedNormal
  } catch {}

  try {
    const normalWindows = await chromeApi.windows.getAll({ windowTypes: ['normal'] })
    return normalWindows.find((win) => win.focused) || normalWindows[0] || null
  } catch {
    return null
  }
}
