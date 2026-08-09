import type { ChromeTabsApi } from '../../src/extension/browser-tabs-gateway'

export type FakeChromeEvent = {
  addListener(handler: (...args: unknown[]) => void): void
  removeListener(handler: (...args: unknown[]) => void): void
  dispatch(...args: unknown[]): void
}

export type FakeChromeState = {
  tabs?: chrome.tabs.Tab[]
  windows?: chrome.windows.Window[]
  tabGroups?: chrome.tabGroups.TabGroup[]
  recentlyClosed?: chrome.sessions.Session[]
  storageSeed?: Record<string, unknown>
  getBookmarkTree?: () => unknown[]
  historySearch?: () => unknown[]
  sendMessage?: ((...args: unknown[]) => Promise<unknown>) | null
  getURL?: (path: string) => string
  runtimeId?: string
  tabCommandLog?: {
    duplicate: number[]
    reload: number[]
  }
}

export type FakeChromeApi = ChromeTabsApi & {
  tabs: ChromeTabsApi['tabs'] & Record<`on${string}`, FakeChromeEvent>
  windows: NonNullable<ChromeTabsApi['windows']> & { onFocusChanged: FakeChromeEvent }
  tabGroups: NonNullable<ChromeTabsApi['tabGroups']> & Record<`on${string}`, FakeChromeEvent>
  runtime: NonNullable<ChromeTabsApi['runtime']> & { getURL: (path: string) => string }
  storage: {
    local: {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    onChanged: FakeChromeEvent
  }
  bookmarks: { getTree(): Promise<unknown[]> } & Record<`on${string}`, FakeChromeEvent>
  history: { search(): Promise<unknown[]>, deleteUrl(): Promise<void> } & Record<`on${string}`, FakeChromeEvent>
}

export declare function createFakeChromeApi(state?: FakeChromeState): FakeChromeApi
