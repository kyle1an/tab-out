/* ================================================================
   Browser Tabs Gateway — the Dashboard's single crossing point to
   live browser tabs, windows, tab groups, and recently-closed
   sessions (see CONTEXT.md).

   Interface contract:
   • Commands only, browser vocabulary. Tab Action policy (matching,
     dedupe, suspend eligibility, undo ordering) stays with callers.
   • Never throws. Failures normalize to [] / null / false / 0 so
     callers branch on values, not try/catch.
   • The chrome-shaped input is resolved from `globalThis.chrome`
     PER CALL — never cached at module load — so tests and fixtures
     that patch the global in any order keep working. Tests may also
     inject directly via setChromeTabsApi().
   • Stateless. The `openTabs` cache stays in tabs.ts.
   ================================================================ */

export type ChromeTabsApi = {
  tabs: {
    query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>
    get?(tabId: number): Promise<chrome.tabs.Tab>
    getCurrent?(): Promise<chrome.tabs.Tab | undefined>
    remove?(tabIds: number | number[]): Promise<void>
    update?(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>
    create?(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>
    move?(tabId: number, moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | chrome.tabs.Tab[] | undefined>
    group?(options: { tabIds: number | number[]; groupId?: number }): Promise<number>
  }
  windows?: {
    getAll?(): Promise<chrome.windows.Window[]>
    getCurrent?(): Promise<chrome.windows.Window>
    update?(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<chrome.windows.Window | undefined>
    create?(createData: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>
  }
  tabGroups?: {
    query(queryInfo: chrome.tabGroups.QueryInfo): Promise<chrome.tabGroups.TabGroup[]>
  }
  sessions?: {
    getRecentlyClosed?(filter?: chrome.sessions.Filter): Promise<chrome.sessions.Session[]>
    restore?(sessionId?: string): Promise<chrome.sessions.Session>
  }
  runtime?: {
    id?: string
    sendMessage?(extensionId: string, message: unknown): Promise<unknown>
  }
}

let injectedChromeTabsApi: ChromeTabsApi | null = null

/** Test seam: inject a chrome-shaped api directly; pass null to restore global resolution. */
export function setChromeTabsApi(api: ChromeTabsApi | null): void {
  injectedChromeTabsApi = api
}

function chromeTabsApi(): ChromeTabsApi | null {
  if (injectedChromeTabsApi) return injectedChromeTabsApi
  const globalChrome = (globalThis as { chrome?: ChromeTabsApi }).chrome
  // Partial fakes are common in tests (a sessions-only or tabs-only patch);
  // every op fully-chains its own guard, so any chrome-shaped object is fine.
  return globalChrome ?? null
}

export async function queryAllTabs(): Promise<chrome.tabs.Tab[]> {
  const api = chromeTabsApi()
  if (!api?.tabs?.query) return []
  try {
    return await api.tabs.query({})
  } catch {
    return []
  }
}

export async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.get) return null
  try {
    return (await api.tabs.get(tabId)) ?? null
  } catch {
    return null
  }
}

/**
 * removeTabs — bulk close with a per-id fallback: Chrome rejects the whole
 * batch when any id is already gone, so a failed batch retries one id at a
 * time. Returns how many tabs were actually removed.
 */
export async function removeTabs(tabIds: number[]): Promise<number> {
  const api = chromeTabsApi()
  if (!api?.tabs?.remove || tabIds.length === 0) return 0
  try {
    await api.tabs.remove(tabIds)
    return tabIds.length
  } catch {
    let removed = 0
    for (const tabId of tabIds) {
      try {
        await api.tabs.remove(tabId)
        removed += 1
      } catch {
        /* already gone — skip */
      }
    }
    return removed
  }
}

export async function updateTab(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.update) return null
  try {
    return (await api.tabs.update(tabId, updateProperties)) ?? null
  } catch {
    return null
  }
}

export async function createTab(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.create) return null
  try {
    return await api.tabs.create(createProperties)
  } catch {
    return null
  }
}

/**
 * createTabWithFallbackUrl — Chrome refuses to create tabs for another
 * extension's URL (e.g. a suspender page). Try the requested URL first,
 * then retry once with the fallback when it differs.
 */
export async function createTabWithFallbackUrl(createProperties: chrome.tabs.CreateProperties, fallbackUrl: string): Promise<chrome.tabs.Tab | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.create) return null
  try {
    return await api.tabs.create(createProperties)
  } catch {
    if (!fallbackUrl || fallbackUrl === createProperties.url) return null
    try {
      return await api.tabs.create({ ...createProperties, url: fallbackUrl })
    } catch {
      return null
    }
  }
}

/** groupTabs — re-attach tabs to a Chrome tab group; false when grouping is unavailable or the group is gone. */
export async function groupTabs(tabIds: number[], groupId: number): Promise<boolean> {
  const api = chromeTabsApi()
  if (!api?.tabs?.group || tabIds.length === 0) return false
  try {
    await api.tabs.group({ tabIds, groupId })
    return true
  } catch {
    return false
  }
}

export async function moveTab(tabId: number, moveProperties: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | chrome.tabs.Tab[] | null> {
  const api = chromeTabsApi()
  if (!api?.tabs?.move) return null
  try {
    return (await api.tabs.move(tabId, moveProperties)) ?? null
  } catch {
    return null
  }
}

export async function getAllWindows(): Promise<chrome.windows.Window[]> {
  const api = chromeTabsApi()
  if (!api?.windows?.getAll) return []
  try {
    return await api.windows.getAll()
  } catch {
    return []
  }
}

export async function getCurrentWindow(): Promise<chrome.windows.Window | null> {
  const api = chromeTabsApi()
  if (!api?.windows?.getCurrent) return null
  try {
    return (await api.windows.getCurrent()) ?? null
  } catch {
    return null
  }
}

export async function focusWindow(windowId: number): Promise<boolean> {
  const api = chromeTabsApi()
  if (!api?.windows?.update) return false
  try {
    await api.windows.update(windowId, { focused: true })
    return true
  } catch {
    return false
  }
}

export async function createWindow(createData: chrome.windows.CreateData): Promise<chrome.windows.Window | null> {
  const api = chromeTabsApi()
  if (!api?.windows?.create) return null
  try {
    return (await api.windows.create(createData)) ?? null
  } catch {
    return null
  }
}

export async function queryTabGroups(): Promise<chrome.tabGroups.TabGroup[]> {
  const api = chromeTabsApi()
  if (!api?.tabGroups) return []
  try {
    return await api.tabGroups.query({})
  } catch {
    return []
  }
}

export async function getRecentlyClosed(filter?: chrome.sessions.Filter): Promise<chrome.sessions.Session[]> {
  const api = chromeTabsApi()
  if (!api?.sessions?.getRecentlyClosed) return []
  try {
    return (await api.sessions.getRecentlyClosed(filter)) ?? []
  } catch {
    return []
  }
}

/** restoreSession — reopen a recently-closed session entry; false when unavailable or already gone. */
export async function restoreSession(sessionId?: string): Promise<boolean> {
  const api = chromeTabsApi()
  if (!api?.sessions?.restore) return false
  try {
    await api.sessions.restore(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * requestExternalUnsuspend — ask another extension (a tab suspender) to
 * unsuspend a tab it owns. False when the target is this extension itself,
 * messaging is unavailable, or the suspender reports an error.
 */
export async function requestExternalUnsuspend(extensionId: string, tabId: number): Promise<boolean> {
  const api = chromeTabsApi()
  if (!extensionId || !api?.runtime?.sendMessage || extensionId === api.runtime.id) return false
  try {
    const response = await api.runtime.sendMessage(extensionId, { action: 'unsuspend', tabId })
    return !(typeof response === 'string' && response.startsWith('Error:'))
  } catch {
    return false
  }
}
