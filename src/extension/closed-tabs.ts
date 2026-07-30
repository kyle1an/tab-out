import { getRecentlyClosedResult, restoreSession, type BrowserReadResult } from './browser-tabs-gateway.js'
import { unwrapSuspenderTitle, unwrapSuspenderUrl } from './suspension.js'
import { isBrowserInternalUrl } from './browser-url-policy.js'

let closedTabFetchSuppressUntilMs = 0
let successfulRestoreSuppressUntilMs = 0
const pendingRestoreSuppressions = new Set<string>()
const remoteRestoreWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const closedTabChangeHandlers = new Set<(settleDelayMs: number) => void>()

export const CLOSED_TAB_SESSION_SETTLE_MS = 150
export const CLOSED_TAB_RESTORE_WATCHDOG_MS = 30_000
export const CLOSED_TAB_RESTORE_STATE_MESSAGE = 'tab-out:closed-tab-restore-state'

type ClosedTabRestoreStateMessage = {
  type: typeof CLOSED_TAB_RESTORE_STATE_MESSAGE
  restoreId: string
  phase: 'started' | 'settled'
  restored?: boolean
}

export function isClosedTabFetchSuppressed(now: number = Date.now()): boolean {
  return pendingRestoreSuppressions.size > 0 || now < closedTabFetchSuppressUntilMs
}

export function closedTabFetchSuppressionRemainingMs(now: number = Date.now()): number {
  if (pendingRestoreSuppressions.size > 0) return Number.POSITIVE_INFINITY
  return Math.max(0, closedTabFetchSuppressUntilMs - now)
}

function recomputeClosedTabFetchSuppression(): void {
  closedTabFetchSuppressUntilMs = successfulRestoreSuppressUntilMs
}

function notifyClosedTabChangeHandlers(settleDelayMs: number): void {
  for (const handler of closedTabChangeHandlers) {
    try {
      handler(settleDelayMs)
    } catch {
      // One mounted consumer must not prevent the others from invalidating.
    }
  }
}

function isClosedTabRestoreStateMessage(message: unknown): message is ClosedTabRestoreStateMessage {
  if (!message || typeof message !== 'object') return false
  const candidate = message as Partial<ClosedTabRestoreStateMessage>
  return candidate.type === CLOSED_TAB_RESTORE_STATE_MESSAGE &&
    typeof candidate.restoreId === 'string' &&
    candidate.restoreId.length > 0 &&
    (candidate.phase === 'started' || candidate.phase === 'settled')
}

function clearRemoteRestoreWatchdog(restoreId: string): void {
  const timer = remoteRestoreWatchdogTimers.get(restoreId)
  if (timer) clearTimeout(timer)
  remoteRestoreWatchdogTimers.delete(restoreId)
}

function applyRemoteRestoreState(message: ClosedTabRestoreStateMessage): number {
  if (message.phase === 'started') {
    pendingRestoreSuppressions.add(message.restoreId)
    clearRemoteRestoreWatchdog(message.restoreId)
    remoteRestoreWatchdogTimers.set(message.restoreId, setTimeout(() => {
      remoteRestoreWatchdogTimers.delete(message.restoreId)
      if (!pendingRestoreSuppressions.delete(message.restoreId)) return
      recomputeClosedTabFetchSuppression()
      notifyClosedTabChangeHandlers(CLOSED_TAB_SESSION_SETTLE_MS)
    }, CLOSED_TAB_RESTORE_WATCHDOG_MS))
    return 0
  }

  clearRemoteRestoreWatchdog(message.restoreId)
  pendingRestoreSuppressions.delete(message.restoreId)
  if (message.restored) {
    successfulRestoreSuppressUntilMs = Math.max(
      successfulRestoreSuppressUntilMs,
      Date.now() + CLOSED_TAB_SESSION_SETTLE_MS
    )
  }
  recomputeClosedTabFetchSuppression()
  return message.restored ? CLOSED_TAB_SESSION_SETTLE_MS : 0
}

async function broadcastRestoreState(message: ClosedTabRestoreStateMessage): Promise<void> {
  const runtime = globalThis.chrome?.runtime
  if (!runtime?.sendMessage) return
  try {
    // Await the start acknowledgement before invoking sessions.restore so the
    // worker cannot observe an early sessions.onChanged without the pending
    // restore guard already installed.
    await runtime.sendMessage(message)
  } catch {
    // The page-local guard remains authoritative when the worker is absent.
  }
}

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

function displayUrlForClosedTab(url: string): string {
  const parsed = URL.parse(url)
  if (!parsed) return url
  if (parsed.protocol === 'file:') return parsed.pathname
  return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
}

function isJunkUrl(url: string): boolean {
  if (!url) return true
  if (isBrowserInternalUrl(url)) return true
  return URL.parse(url) === null
}

function normalizeClosedTab(tab: chrome.tabs.Tab | undefined, lastModifiedMs: number): ClosedTabEntry | null {
  if (!tab) return null
  const sessionId = (tab as chrome.tabs.Tab & { sessionId?: string }).sessionId
  if (!sessionId) return null
  const rawUrl = tab.url || ''
  const url = unwrapSuspenderUrl(rawUrl)
  if (isJunkUrl(url)) return null

  const suspendedTitle = unwrapSuspenderTitle(rawUrl)
  const cleanTitle = (tab.title || '').replaceAll('\u200E', '').trim()
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
  // Arm before calling Chrome: sessions.onChanged may fire before the restore
  // promise settles. Each in-flight restore owns one marker so a slow, failed,
  // or overlapping restore cannot expire or clear another restore's protection.
  const messageId = crypto.randomUUID()
  pendingRestoreSuppressions.add(messageId)
  let restored = false
  try {
    await broadcastRestoreState({
      type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
      restoreId: messageId,
      phase: 'started'
    })
    restored = await restoreSession(sessionId)
    return restored
  } finally {
    pendingRestoreSuppressions.delete(messageId)
    if (restored) {
      successfulRestoreSuppressUntilMs = Math.max(
        successfulRestoreSuppressUntilMs,
        Date.now() + CLOSED_TAB_SESSION_SETTLE_MS
      )
    }
    recomputeClosedTabFetchSuppression()
    const settleDelayMs = restored ? CLOSED_TAB_SESSION_SETTLE_MS : 0
    // The early sessions event may have already fired. Notify page consumers
    // again at settlement so they always take one authoritative trailing read.
    notifyClosedTabChangeHandlers(settleDelayMs)
    await broadcastRestoreState({
      type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
      restoreId: messageId,
      phase: 'settled',
      restored
    })
  }
}

// Event subscriptions stay on the ambient global: the Browser Tabs Gateway
// covers commands only; event listeners are intentionally outside its scope.
export function subscribeClosedTabChanges(handler: (settleDelayMs: number) => void): () => void {
  const sessionsApi = globalThis.chrome?.sessions
  const tabsApi = globalThis.chrome?.tabs
  const runtimeApi = globalThis.chrome?.runtime
  // Notify immediately so consumers can invalidate an in-flight read, while
  // carrying the stateless settle delay needed by pages that did not initiate
  // the restore and therefore do not share this module's suppression state.
  const onSessionsChanged = () => handler(CLOSED_TAB_SESSION_SETTLE_MS)
  const onTabRemoved = () => handler(0)
  const onRuntimeMessage = (message: unknown) => {
    if (!isClosedTabRestoreStateMessage(message)) return
    const settleDelayMs = applyRemoteRestoreState(message)
    handler(settleDelayMs)
  }
  closedTabChangeHandlers.add(handler)
  sessionsApi?.onChanged?.addListener?.(onSessionsChanged)
  tabsApi?.onRemoved?.addListener?.(onTabRemoved)
  runtimeApi?.onMessage?.addListener?.(onRuntimeMessage)
  return () => {
    closedTabChangeHandlers.delete(handler)
    sessionsApi?.onChanged?.removeListener?.(onSessionsChanged)
    tabsApi?.onRemoved?.removeListener?.(onTabRemoved)
    runtimeApi?.onMessage?.removeListener?.(onRuntimeMessage)
  }
}

export async function fetchClosedTabsResult(): Promise<BrowserReadResult<ClosedTabEntry[]>> {
  const sessionsResult = await getRecentlyClosedResult()
  if (!sessionsResult.ok) return { ok: false, value: [] }

  const entries: ClosedTabEntry[] = []
  for (const session of sessionsResult.value) {
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
  return { ok: true, value: entries }
}
