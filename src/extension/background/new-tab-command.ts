import { findNormalBrowserWindow } from './browser-window.js'
import type { ChromeApi } from './chrome-api.js'

export const OPEN_NEW_TAB_COMMAND = 'open-new-tab'

export async function openNewTab(chromeApi: ChromeApi = chrome): Promise<void> {
  const normalWindow = await findNormalBrowserWindow(chromeApi)

  if (typeof normalWindow?.id === 'number') {
    await chromeApi.tabs.create({
      windowId: normalWindow.id,
      active: true
    })
    try {
      await chromeApi.windows.update(normalWindow.id, { focused: true })
    } catch {}
    return
  }

  try {
    await chromeApi.windows.create({ type: 'normal', focused: true })
  } catch {
    await chromeApi.tabs.create({ active: true })
  }
}
