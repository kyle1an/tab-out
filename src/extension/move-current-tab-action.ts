import { Effect } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { showToast } from './toast.js'

type CurrentTabTarget = Pick<chrome.tabs.Tab, 'id'>

/**
 * Detach one exact physical tab into a new focused normal window. There is
 * deliberately no URL-opening fallback or same-URL substitution: when the
 * move cannot happen, nothing else happens in its place.
 */
export const moveCurrentTabToNewWindowEffect = Effect.fn(
  'tabActions.moveCurrentTabToNewWindow',
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

/**
 * The Tab Actions Menu variant: resolve the invoking window's active tab as
 * the current tab, then move exactly that tab. Success needs no toast — the
 * new window takes focus, which closes the popup.
 */
export const moveActiveTabToNewWindowEffect = Effect.fn(
  'tabActions.moveActiveTabToNewWindow',
)(function* () {
  const browserTabs = yield* BrowserTabs
  const currentWindowResult = yield* browserTabs.getCurrentWindowResult()
  const windowId = currentWindowResult.ok && typeof currentWindowResult.value?.id === 'number'
    ? currentWindowResult.value.id
    : null
  if (windowId === null) {
    showToast('Could not identify this Chrome window')
    return false
  }

  const tabsResult = yield* browserTabs.queryTabsInWindowResult(windowId)
  const activeTab = tabsResult.ok
    ? tabsResult.value.find((tab) => tab.active)
    : undefined
  if (typeof activeTab?.id !== 'number') {
    showToast('Could not identify the current tab')
    return false
  }

  const moved = yield* moveCurrentTabToNewWindowEffect(activeTab)
  if (!moved) showToast('Could not move the current tab')
  return moved
})

export function moveActiveTabToNewWindow(): Promise<boolean> {
  return getAppRuntime().runPromise(moveActiveTabToNewWindowEffect())
}
