import { Effect, Exit, Schema } from 'effect'

import { getRecentlyClosedResult, type BrowserReadResult } from './browser-tabs-gateway.js'
import {
  CLOSED_TAB_RESTORE_STATE_MESSAGE,
  parseClosedTabRestoreStateMessage,
  type ClosedTabRestoreStateMessage
} from './runtime-messages.js'
import { unwrapSuspenderTitle, unwrapSuspenderUrl } from './suspension.js'
import { isBrowserInternalUrl } from './browser-url-policy.js'

export { CLOSED_TAB_RESTORE_STATE_MESSAGE } from './runtime-messages.js'

let closedTabFetchSuppressUntilMs = 0
let successfulRestoreSuppressUntilMs = 0
const pendingRestoreSuppressions = new Set<string>()
const remoteRestoreWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const closedTabChangeHandlers = new Set<(settleDelayMs: number) => void>()

export const CLOSED_TAB_SESSION_SETTLE_MS = 150
export const CLOSED_TAB_RESTORE_WATCHDOG_MS = 30_000

class ClosedTabRestoreError extends Schema.TaggedErrorClass<ClosedTabRestoreError>()(
  'ClosedTabRestoreError',
  { cause: Schema.Defect() }
) {}

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

const broadcastClosedTabRestoreState = Effect.fn('closedTabs.broadcastRestoreState')(function*(
  message: ClosedTabRestoreStateMessage
) {
  const runtime = globalThis.chrome?.runtime
  if (!runtime?.sendMessage) return
  // Await the start acknowledgement before invoking sessions.restore so the
  // worker cannot observe an early sessions.onChanged without the pending
  // restore guard already installed.
  yield* Effect.tryPromise({
    try: () => runtime.sendMessage(message),
    catch: (cause) => ClosedTabRestoreError.make({ cause })
  }).pipe(
    // The page-local guard remains authoritative when the worker is absent.
    Effect.catchTag('ClosedTabRestoreError', () => Effect.void)
  )
})

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

const hasClosedTabSessionId = Schema.is(Schema.Struct({
  sessionId: Schema.NonEmptyString
}))

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
  if (!tab || !hasClosedTabSessionId(tab)) return null
  const { sessionId } = tab
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

const acquireClosedTabRestore = Effect.fn('closedTabs.acquireRestoreSuppression')(function*() {
  // Arm before calling Chrome: sessions.onChanged may fire before the restore
  // promise settles. Each in-flight restore owns one marker so a slow, failed,
  // or overlapping restore cannot expire or clear another restore's protection.
  const restoreId = crypto.randomUUID()
  pendingRestoreSuppressions.add(restoreId)
  yield* broadcastClosedTabRestoreState({
    type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
    restoreId,
    phase: 'started'
  })
  return restoreId
})

const releaseClosedTabRestore = Effect.fn('closedTabs.releaseRestoreSuppression')(function*(
  restoreId: string,
  restored: boolean
) {
  pendingRestoreSuppressions.delete(restoreId)
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
  yield* broadcastClosedTabRestoreState({
    type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
    restoreId,
    phase: 'settled',
    restored
  })
})

export function restoreClosedTabEffect(
  restore: Effect.Effect<boolean>
): Effect.Effect<boolean> {
  return Effect.acquireUseRelease(
    acquireClosedTabRestore(),
    () => restore,
    (restoreId, exit) => releaseClosedTabRestore(
      restoreId,
      Exit.isSuccess(exit) && exit.value
    )
  )
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
    const restoreState = parseClosedTabRestoreStateMessage(message)
    if (!restoreState) return
    const settleDelayMs = applyRemoteRestoreState(restoreState)
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
