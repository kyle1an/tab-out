import { createActiveTabInNormalWindow } from './browser-window.js'
import type { ChromeApi } from './chrome-api.js'

export const OPEN_NEW_TAB_COMMAND = 'open-new-tab'

export async function openNewTab(chromeApi: ChromeApi = chrome): Promise<void> {
  if (await createActiveTabInNormalWindow(chromeApi, {})) return

  try {
    await chromeApi.windows.create({ type: 'normal', focused: true })
  } catch {
    await chromeApi.tabs.create({ active: true })
  }
}
