import { createActiveTabInNormalWindow } from './browser-window.js'
import type { ChromeApi } from './chrome-api.js'

export const OPEN_FILTER_TAB_COMMAND = 'open-filter-tab'
const FOCUS_FILTER_PARAM = 'focusFilter'

function filterFocusUrl(chromeApi: ChromeApi): string {
  return `chrome-extension://${chromeApi.runtime.id}/index.html?${FOCUS_FILTER_PARAM}=1`
}

export async function openFilterTab(chromeApi: ChromeApi = chrome): Promise<void> {
  const url = filterFocusUrl(chromeApi)
  if (await createActiveTabInNormalWindow(chromeApi, { url })) return

  try {
    await chromeApi.windows.create({ type: 'normal', url, focused: true })
  } catch {
    await chromeApi.tabs.create({ url, active: true })
  }
}
