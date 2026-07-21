import { getRecentlyClosed, restoreSession } from './browser-tabs-gateway.js'
import { unwrapSuspenderTitle, unwrapSuspenderUrl } from './suspension.js'

let closedTabFetchSuppressUntilMs = 0

export function isClosedTabFetchSuppressed(now: number = Date.now()): boolean {
  return now < closedTabFetchSuppressUntilMs
}

const CLOSED_TAB_RESTORE_SUPPRESS_MS = 150

export interface ClosedTabEntry {
  sessionId: string
  tabId: number
  url: string
  rawUrl: string
  displayUrl: string
  title: string
  favIconUrl: string
  lastClosedAt: number
}

const JUNK_PROTOCOLS = new Set([
  'about:',
  'brave:',
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'devtools:',
  'edge:'
])

function displayUrlForClosedTab(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') return parsed.pathname
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

function isTabOutUrl(url: string): boolean {
  const extensionId = globalThis.chrome?.runtime?.id
  if (!extensionId) return false
  return url.startsWith(`chrome-extension://${extensionId}/`)
}

function isJunkUrl(url: string): boolean {
  if (!url) return true
  try {
    const protocol = new URL(url).protocol
    if (JUNK_PROTOCOLS.has(protocol)) return true
  } catch {
    return true
  }
  return isTabOutUrl(url)
}

function normalizeClosedTab(tab: chrome.tabs.Tab | undefined, lastModifiedMs: number): ClosedTabEntry | null {
  if (!tab) return null
  const sessionId = (tab as chrome.tabs.Tab & { sessionId?: string }).sessionId
  if (!sessionId) return null
  const rawUrl = tab.url || ''
  const url = unwrapSuspenderUrl(rawUrl)
  if (isJunkUrl(url)) return null

  const suspendedTitle = unwrapSuspenderTitle(rawUrl)
  const cleanTitle = (tab.title || '').replace(/‎/g, '').trim()
  const displayUrl = displayUrlForClosedTab(url)
  return {
    sessionId,
    tabId: typeof tab.id === 'number' ? tab.id : -1,
    url,
    rawUrl: rawUrl || url,
    displayUrl,
    title: suspendedTitle || cleanTitle || displayUrl,
    favIconUrl: tab.favIconUrl || '',
    lastClosedAt: lastModifiedMs
  }
}

export async function restoreClosedTab(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const restored = await restoreSession(sessionId)
  if (restored) closedTabFetchSuppressUntilMs = Date.now() + CLOSED_TAB_RESTORE_SUPPRESS_MS
  return restored
}

// Event subscriptions stay on the ambient global: the Browser Tabs Gateway
// covers commands only; event listeners are intentionally outside its scope.
export function subscribeClosedTabChanges(handler: () => void): () => void {
  const sessionsApi = globalThis.chrome?.sessions
  const tabsApi = globalThis.chrome?.tabs
  const wrapped = () => handler()
  sessionsApi?.onChanged?.addListener?.(wrapped)
  tabsApi?.onRemoved?.addListener?.(wrapped)
  return () => {
    sessionsApi?.onChanged?.removeListener?.(wrapped)
    tabsApi?.onRemoved?.removeListener?.(wrapped)
  }
}

export async function fetchClosedTabs(): Promise<ClosedTabEntry[]> {
  const sessions = await getRecentlyClosed()

  const entries: ClosedTabEntry[] = []
  for (const session of sessions) {
    const lastModified = session.lastModified || 0
    if (session.tab) {
      const entry = normalizeClosedTab(session.tab, lastModified)
      if (entry) entries.push(entry)
      continue
    }
    if (session.window?.tabs) {
      for (const tab of session.window.tabs) {
        const entry = normalizeClosedTab(tab, lastModified)
        if (entry) entries.push(entry)
      }
    }
  }
  return entries
}
