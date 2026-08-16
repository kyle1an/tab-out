import { Context, Effect, Layer } from 'effect'

import {
  createTab,
  createTabWithFallbackUrl,
  createWindow,
  duplicateTab,
  focusWindow,
  getAllWindowsResult,
  getCurrentTab,
  getCurrentWindow,
  getCurrentWindowResult,
  getRecentlyClosedResult,
  getTab,
  getWindow,
  groupTabs,
  highlightTabs,
  moveTab,
  moveTabGroup,
  queryAllTabsResult,
  queryTabGroupsResult,
  queryTabsInWindowResult,
  reloadTab,
  removeTabs,
  requestExternalUnsuspend,
  restoreSession,
  updateTab,
  type BrowserReadResult,
  type RemoveTabsOptions,
} from './browser-tabs-gateway.js'

export class BrowserTabs extends Context.Service<BrowserTabs, {
  readonly createTab: (
    createProperties: chrome.tabs.CreateProperties,
  ) => Effect.Effect<chrome.tabs.Tab | null>
  readonly createTabWithFallbackUrl: (
    createProperties: chrome.tabs.CreateProperties,
    fallbackUrl: string,
  ) => Effect.Effect<chrome.tabs.Tab | null>
  readonly createWindow: (
    createData: chrome.windows.CreateData,
  ) => Effect.Effect<chrome.windows.Window | null>
  readonly duplicateTab: (tabId: number) => Effect.Effect<chrome.tabs.Tab | null>
  readonly focusWindow: (windowId: number) => Effect.Effect<boolean>
  readonly getAllWindowsResult: () => Effect.Effect<
    BrowserReadResult<chrome.windows.Window[]>
  >
  readonly getCurrentTab: () => Effect.Effect<chrome.tabs.Tab | null>
  readonly getCurrentWindow: () => Effect.Effect<chrome.windows.Window | null>
  readonly getCurrentWindowResult: () => Effect.Effect<
    BrowserReadResult<chrome.windows.Window | null>
  >
  readonly getRecentlyClosedResult: (
    filter?: chrome.sessions.Filter,
  ) => Effect.Effect<BrowserReadResult<chrome.sessions.Session[]>>
  readonly getTab: (tabId: number) => Effect.Effect<chrome.tabs.Tab | null>
  readonly getWindow: (windowId: number) => Effect.Effect<chrome.windows.Window | null>
  readonly groupTabs: (tabIds: number[], groupId: number) => Effect.Effect<boolean>
  readonly highlightTabs: (windowId: number, tabIndexes: number[]) => Effect.Effect<boolean>
  readonly moveTab: (
    tabId: number,
    moveProperties: chrome.tabs.MoveProperties,
  ) => Effect.Effect<chrome.tabs.Tab | chrome.tabs.Tab[] | null>
  readonly moveTabGroup: (
    groupId: number,
    moveProperties: chrome.tabGroups.MoveProperties,
  ) => Effect.Effect<chrome.tabGroups.TabGroup | null>
  readonly queryAllTabsResult: () => Effect.Effect<BrowserReadResult<chrome.tabs.Tab[]>>
  readonly queryTabGroupsResult: () => Effect.Effect<
    BrowserReadResult<chrome.tabGroups.TabGroup[]>
  >
  readonly queryTabsInWindowResult: (
    windowId: number,
  ) => Effect.Effect<BrowserReadResult<chrome.tabs.Tab[]>>
  readonly reloadTab: (tabId: number) => Effect.Effect<boolean>
  readonly removeTabs: (
    tabIds: number[],
    options?: RemoveTabsOptions,
  ) => Effect.Effect<number[]>
  readonly requestExternalUnsuspend: (
    extensionId: string,
    tabId: number,
  ) => Effect.Effect<boolean>
  readonly restoreSession: (sessionId?: string) => Effect.Effect<boolean>
  readonly updateTab: (
    tabId: number,
    updateProperties: chrome.tabs.UpdateProperties,
  ) => Effect.Effect<chrome.tabs.Tab | null>
}>()('@tab-out/app/BrowserTabs') {
  static layer(): Layer.Layer<BrowserTabs> {
    return Layer.succeed(BrowserTabs, BrowserTabs.of({
      createTab: (createProperties) => Effect.promise(() => createTab(createProperties)),
      createTabWithFallbackUrl: (createProperties, fallbackUrl) =>
        Effect.promise(() => createTabWithFallbackUrl(createProperties, fallbackUrl)),
      createWindow: (createData) => Effect.promise(() => createWindow(createData)),
      duplicateTab: (tabId) => Effect.promise(() => duplicateTab(tabId)),
      focusWindow: (windowId) => Effect.promise(() => focusWindow(windowId)),
      getAllWindowsResult: () => Effect.promise(() => getAllWindowsResult()),
      getCurrentTab: () => Effect.promise(() => getCurrentTab()),
      getCurrentWindow: () => Effect.promise(() => getCurrentWindow()),
      getCurrentWindowResult: () => Effect.promise(() => getCurrentWindowResult()),
      getRecentlyClosedResult: (filter) =>
        Effect.promise(() => getRecentlyClosedResult(filter)),
      getTab: (tabId) => Effect.promise(() => getTab(tabId)),
      getWindow: (windowId) => Effect.promise(() => getWindow(windowId)),
      groupTabs: (tabIds, groupId) => Effect.promise(() => groupTabs(tabIds, groupId)),
      highlightTabs: (windowId, tabIndexes) =>
        Effect.promise(() => highlightTabs(windowId, tabIndexes)),
      moveTab: (tabId, moveProperties) =>
        Effect.promise(() => moveTab(tabId, moveProperties)),
      moveTabGroup: (groupId, moveProperties) =>
        Effect.promise(() => moveTabGroup(groupId, moveProperties)),
      queryAllTabsResult: () => Effect.promise(() => queryAllTabsResult()),
      queryTabGroupsResult: () => Effect.promise(() => queryTabGroupsResult()),
      queryTabsInWindowResult: (windowId) =>
        Effect.promise(() => queryTabsInWindowResult(windowId)),
      reloadTab: (tabId) => Effect.promise(() => reloadTab(tabId)),
      removeTabs: (tabIds, options) => Effect.promise(() => removeTabs(tabIds, options)),
      requestExternalUnsuspend: (extensionId, tabId) =>
        Effect.promise(() => requestExternalUnsuspend(extensionId, tabId)),
      restoreSession: (sessionId) => Effect.promise(() => restoreSession(sessionId)),
      updateTab: (tabId, updateProperties) =>
        Effect.promise(() => updateTab(tabId, updateProperties)),
    }))
  }
}
