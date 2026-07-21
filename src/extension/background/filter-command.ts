import { findNormalBrowserWindow } from './browser-window.js'
import type { ChromeApi } from './chrome-api.js'

export const OPEN_FILTER_TAB_COMMAND = 'open-filter-tab'
const FOCUS_FILTER_PARAM = 'focusFilter'

function filterFocusUrl(chromeApi: ChromeApi): string {
  return `chrome-extension://${chromeApi.runtime.id}/index.html?${FOCUS_FILTER_PARAM}=1`
}

export async function openFilterTab(chromeApi: ChromeApi = chrome): Promise<void> {
  const url = filterFocusUrl(chromeApi)
  const normalWindow = await findNormalBrowserWindow(chromeApi)

  if (typeof normalWindow?.id === 'number') {
    await chromeApi.tabs.create({
      windowId: normalWindow.id,
      url,
      active: true
    })
    try {
      await chromeApi.windows.update(normalWindow.id, { focused: true })
    } catch {}
    return
  }

  try {
    await chromeApi.windows.create({ type: 'normal', url, focused: true })
  } catch {
    await chromeApi.tabs.create({ url, active: true })
  }
}
