import { Effect } from 'effect'

import { BrowserTabs } from '../browser-tabs-service.js'

export const MOVE_CURRENT_TAB_TO_NEW_WINDOW_MENU_ID = 'move-current-tab-to-new-window'

type ActionContextMenuApi = {
  contextMenus: {
    create: (createProperties: chrome.contextMenus.CreateProperties) => number | string
  }
}

type CurrentTabTarget = Pick<chrome.tabs.Tab, 'id'>

export function registerActionContextMenu(chromeApi: ActionContextMenuApi = chrome): void {
  chromeApi.contextMenus.create({
    id: MOVE_CURRENT_TAB_TO_NEW_WINDOW_MENU_ID,
    title: 'Move current tab to new window',
    contexts: ['action'],
  })
}

export const moveCurrentTabToNewWindowEffect = Effect.fn(
  'actionContextMenu.moveCurrentTabToNewWindow',
)(function* (
  tab: CurrentTabTarget | undefined,
) {
  if (typeof tab?.id !== 'number') return false

  const browserTabs = yield* BrowserTabs
  const createdWindow = yield* browserTabs.createWindow({
    tabId: tab.id,
    focused: true,
    type: 'normal',
  })
  return createdWindow !== null
})
