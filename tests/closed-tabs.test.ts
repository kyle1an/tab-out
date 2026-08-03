import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'

import { CLOSED_TAB_RESTORE_STATE_MESSAGE, CLOSED_TAB_RESTORE_WATCHDOG_MS, CLOSED_TAB_SESSION_SETTLE_MS, closedTabFetchSuppressionRemainingMs, fetchClosedTabsResult, isClosedTabFetchSuppressed, restoreClosedTab, subscribeClosedTabChanges } from '../src/extension/closed-tabs.js'

type Session = chrome.sessions.Session
type SessionTab = chrome.tabs.Tab
type SessionWindow = chrome.windows.Window

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

function setSessionsApi(sessions: Session[]) {
  globalThis.chrome = {
    sessions: {
      getRecentlyClosed: async (_opts?: { maxResults?: number }) => sessions,
      restore: async (_id?: string) => undefined,
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: { id: 'tab-out-test' }
  } as unknown as typeof globalThis.chrome
}

test('fetchClosedTabs flattens single tab sessions and window sessions to one entry per tab', async () => {
  setSessionsApi([
    {
      lastModified: 1_700_000_010,
      tab: {
        sessionId: 'tab-a',
        id: 1,
        windowId: 1,
        url: 'https://example.com/a',
        title: 'A',
        favIconUrl: ''
      } as SessionTab & { sessionId: string }
    },
    {
      lastModified: 1_700_000_020,
      window: {
        tabs: [
          { sessionId: 'tab-b', id: 2, windowId: 2, url: 'https://example.com/b', title: 'B', favIconUrl: '' } as SessionTab & { sessionId: string },
          { sessionId: 'tab-c', id: 3, windowId: 2, url: 'https://example.com/c', title: 'C', favIconUrl: '' } as SessionTab & { sessionId: string }
        ]
      } as SessionWindow
    }
  ])

  const result = (await fetchClosedTabsResult()).value
  assert.equal(result.length, 3)
  assert.equal(valueAt(result, 0).sessionId, 'tab-a')
  assert.equal(valueAt(result, 0).lastClosedAt, 1_700_000_010)
  assert.equal(valueAt(result, 1).sessionId, 'tab-b')
  assert.equal(valueAt(result, 1).lastClosedAt, 1_700_000_020)
  assert.equal(valueAt(result, 2).sessionId, 'tab-c')
  assert.equal(valueAt(result, 2).lastClosedAt, 1_700_000_020)
})

test('fetchClosedTabs drops every browser-internal URL kind', async () => {
  setSessionsApi([
    {
      lastModified: 1,
      tab: { sessionId: 'a', id: 1, windowId: 1, url: 'chrome://newtab/', title: 'New Tab', favIconUrl: '' } as SessionTab & { sessionId: string }
    },
    {
      lastModified: 2,
      tab: { sessionId: 'b', id: 2, windowId: 1, url: 'chrome-extension://tab-out-test/index.html', title: 'Tab Out', favIconUrl: '' } as SessionTab & { sessionId: string }
    },
    {
      lastModified: 3,
      tab: { sessionId: 'c', id: 3, windowId: 1, url: 'chrome-untrusted://new-tab-page/', title: 'New Tab Frame', favIconUrl: '' } as SessionTab & { sessionId: string }
    },
    {
      lastModified: 4,
      tab: { sessionId: 'd', id: 4, windowId: 1, url: 'https://example.com/keep', title: 'Keep', favIconUrl: '' } as SessionTab & { sessionId: string }
    }
  ])

  const result = (await fetchClosedTabsResult()).value
  assert.equal(result.length, 1)
  assert.equal(valueAt(result, 0).sessionId, 'd')
})

test('fetchClosedTabs drops tabs without urls and entries without sessionId', async () => {
  setSessionsApi([
    { lastModified: 1, tab: { id: 1, windowId: 1, url: '', title: 'no url', favIconUrl: '' } as SessionTab },
    { lastModified: 2, tab: { sessionId: '', id: 2, windowId: 1, url: 'https://example.com/x', title: 'x', favIconUrl: '' } as SessionTab & { sessionId: string } }
  ])
  const result = (await fetchClosedTabsResult()).value
  assert.equal(result.length, 0)
})

test('fetchClosedTabs resolves to empty when chrome.sessions is unavailable', async () => {
  globalThis.chrome = {} as unknown as typeof globalThis.chrome
  const result = (await fetchClosedTabsResult()).value
  assert.deepEqual(result, [])
})

test('fetchClosedTabsResult distinguishes a rejected sessions read from confirmed empty', async () => {
  globalThis.chrome = {
    sessions: {
      getRecentlyClosed: async () => { throw new Error('sessions database unavailable') }
    }
  } as unknown as typeof globalThis.chrome

  assert.deepEqual(await fetchClosedTabsResult(), { ok: false, value: [] })
  setSessionsApi([])
  assert.deepEqual(await fetchClosedTabsResult(), { ok: true, value: [] })
})

test('restoreClosedTab calls chrome.sessions.restore and resolves true on success', async () => {
  let calledWith: string | undefined
  const restoreEvents: string[] = []
  const restoreMessages: Array<{ phase: string; restoreId: string; restored?: boolean }> = []
  globalThis.chrome = {
    sessions: {
      restore: async (id?: string) => {
        calledWith = id
        restoreEvents.push('restore')
        return undefined
      }
    },
    runtime: {
      id: 'tab-out-test',
      sendMessage: async (message: unknown) => {
        const restoreMessage = message as { phase: string; restoreId: string; restored?: boolean }
        restoreEvents.push(restoreMessage.phase)
        restoreMessages.push(restoreMessage)
      }
    }
  } as unknown as typeof globalThis.chrome

  const ok = await restoreClosedTab('session-xyz')
  assert.equal(ok, true)
  assert.equal(calledWith, 'session-xyz')
  assert.deepEqual(restoreEvents, ['started', 'restore', 'settled'])
  assert.ok(restoreMessages[0]?.restoreId)
  assert.equal(restoreMessages[1]?.restoreId, restoreMessages[0]?.restoreId)
  assert.equal(restoreMessages[1]?.restored, true)
})

test('restoreClosedTab returns false when chrome.sessions.restore throws', async () => {
  globalThis.chrome = {
    sessions: {
      restore: async () => { throw new Error('refused') }
    },
    runtime: { id: 'tab-out-test' }
  } as unknown as typeof globalThis.chrome

  const ok = await restoreClosedTab('session-xyz')
  assert.equal(ok, false)
})

test('restoreClosedTab broadcasts settlement when Chrome rejects the restore', async () => {
  const restoreMessages: Array<{ phase: string; restored?: boolean }> = []
  globalThis.chrome = {
    sessions: {
      restore: async () => { throw new Error('refused') }
    },
    runtime: {
      id: 'tab-out-test',
      sendMessage: async (message: unknown) => {
        restoreMessages.push(message as { phase: string; restored?: boolean })
      }
    }
  } as unknown as typeof globalThis.chrome

  const ok = await restoreClosedTab('session-xyz')

  assert.equal(ok, false)
  assert.deepEqual(restoreMessages.map(({ phase }) => phase), ['started', 'settled'])
  assert.equal(restoreMessages[1]?.restored, false)
})

test('restoreClosedTab returns false when chrome.sessions is unavailable', async () => {
  globalThis.chrome = {} as unknown as typeof globalThis.chrome
  const ok = await restoreClosedTab('session-xyz')
  assert.equal(ok, false)
})

test('restoreClosedTab returns false when sessionId is empty', async () => {
  globalThis.chrome = {
    sessions: { restore: async () => undefined }
  } as unknown as typeof globalThis.chrome
  const ok = await restoreClosedTab('')
  assert.equal(ok, false)
})

test('subscribeClosedTabChanges registers and unregisters a listener', async () => {
  const listeners: Array<() => void> = []
  globalThis.chrome = {
    sessions: {
      onChanged: {
        addListener: (handler: () => void) => listeners.push(handler),
        removeListener: (handler: () => void) => {
          const i = listeners.indexOf(handler)
          if (i >= 0) listeners.splice(i, 1)
        }
      }
    },
    tabs: {
      onRemoved: {
        addListener: () => {},
        removeListener: () => {}
      }
    }
  } as unknown as typeof globalThis.chrome

  const settleDelays: number[] = []
  const unsubscribe = subscribeClosedTabChanges((settleDelayMs) => { settleDelays.push(settleDelayMs) })
  assert.equal(listeners.length, 1)
  valueAt(listeners, 0)()
  assert.deepEqual(settleDelays, [CLOSED_TAB_SESSION_SETTLE_MS])
  unsubscribe()
  assert.equal(listeners.length, 0)
})

test('restore suppression is armed before Chrome settles the restore promise', async () => {
  const { promise: restoring, resolve: finishRestore } = Promise.withResolvers<void>()
  globalThis.chrome = {
    sessions: {
      restore: async () => restoring
    },
    runtime: { id: 'tab-out-test' }
  } as unknown as typeof globalThis.chrome

  const restore = restoreClosedTab('session-pending')
  assert.equal(isClosedTabFetchSuppressed(), true)
  finishRestore()
  assert.equal(await restore, true)
})

test('a restore gated beyond 150ms stays suppressed and emits a settled trailing refresh', async () => {
  const realNow = Date.now()
  const clock = FakeTimers.install({ now: realNow, toFake: ['Date'] })
  const { promise: restoring, resolve: finishRestore } = Promise.withResolvers<void>()
  const { promise: restoreStarted, resolve: markRestoreStarted } = Promise.withResolvers<void>()
  const sessionListeners: Array<() => void> = []
  const settleDelays: number[] = []
  globalThis.chrome = {
    sessions: {
      restore: async () => {
        markRestoreStarted()
        return restoring
      },
      onChanged: {
        addListener: (handler: () => void) => sessionListeners.push(handler),
        removeListener: () => {}
      }
    },
    tabs: {
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: { id: 'tab-out-test' }
  } as unknown as typeof globalThis.chrome
  const unsubscribe = subscribeClosedTabChanges((settleDelayMs) => { settleDelays.push(settleDelayMs) })

  try {
    const restore = restoreClosedTab('session-slow')
    await restoreStarted
    clock.tick(CLOSED_TAB_SESSION_SETTLE_MS + 1)
    valueAt(sessionListeners, 0)()

    assert.equal(isClosedTabFetchSuppressed(), true)
    assert.equal(closedTabFetchSuppressionRemainingMs(), Number.POSITIVE_INFINITY)
    assert.deepEqual(settleDelays, [CLOSED_TAB_SESSION_SETTLE_MS])

    clock.setSystemTime(realNow)
    finishRestore()
    assert.equal(await restore, true)
    assert.deepEqual(settleDelays, [CLOSED_TAB_SESSION_SETTLE_MS, CLOSED_TAB_SESSION_SETTLE_MS])
    assert.equal(isClosedTabFetchSuppressed(), true)
  } finally {
    unsubscribe()
    finishRestore()
    clock.uninstall()
  }
})

test('a second page suppresses reads for a restore broadcast by another page', () => {
  const runtimeListeners: Array<(message: unknown) => void> = []
  const settleDelays: number[] = []
  globalThis.chrome = {
    sessions: {
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    tabs: {
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      onMessage: {
        addListener: (handler: (message: unknown) => void) => runtimeListeners.push(handler),
        removeListener: () => {}
      }
    }
  } as unknown as typeof globalThis.chrome
  const unsubscribe = subscribeClosedTabChanges((settleDelayMs) => { settleDelays.push(settleDelayMs) })

  try {
    valueAt(runtimeListeners, 0)({
      type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
      restoreId: 'other-page-restore',
      phase: 'started'
    })
    assert.equal(closedTabFetchSuppressionRemainingMs(), Number.POSITIVE_INFINITY)
    assert.deepEqual(settleDelays, [0])

    valueAt(runtimeListeners, 0)({
      type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
      restoreId: 'other-page-restore',
      phase: 'settled',
      restored: true
    })
    assert.notEqual(closedTabFetchSuppressionRemainingMs(), Number.POSITIVE_INFINITY)
    assert.deepEqual(settleDelays, [0, CLOSED_TAB_SESSION_SETTLE_MS])
  } finally {
    unsubscribe()
  }
})

test('a second page ignores malformed restore-state messages', () => {
  const runtimeListeners: Array<(message: unknown) => void> = []
  const settleDelays: number[] = []
  globalThis.chrome = {
    sessions: {
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    tabs: {
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      onMessage: {
        addListener: (handler: (message: unknown) => void) => runtimeListeners.push(handler),
        removeListener: () => {}
      }
    }
  } as unknown as typeof globalThis.chrome
  const unsubscribe = subscribeClosedTabChanges((settleDelayMs) => { settleDelays.push(settleDelayMs) })

  try {
    valueAt(runtimeListeners, 0)({
      type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
      restoreId: 'malformed-restore',
      phase: 'settled',
      restored: 'yes'
    })
    assert.deepEqual(settleDelays, [])
  } finally {
    unsubscribe()
  }
})

test('a second page releases an orphaned restore broadcast through its watchdog', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const runtimeListeners: Array<(message: unknown) => void> = []
  const settleDelays: number[] = []
  globalThis.chrome = {
    sessions: {
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    tabs: {
      onRemoved: { addListener: () => {}, removeListener: () => {} }
    },
    runtime: {
      onMessage: {
        addListener: (handler: (message: unknown) => void) => runtimeListeners.push(handler),
        removeListener: () => {}
      }
    }
  } as unknown as typeof globalThis.chrome
  const unsubscribe = subscribeClosedTabChanges((settleDelayMs) => { settleDelays.push(settleDelayMs) })

  try {
    valueAt(runtimeListeners, 0)({
      type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
      restoreId: 'orphaned-other-page-restore',
      phase: 'started'
    })
    assert.equal(closedTabFetchSuppressionRemainingMs(), Number.POSITIVE_INFINITY)

    await clock.tickAsync(CLOSED_TAB_RESTORE_WATCHDOG_MS)
    assert.notEqual(closedTabFetchSuppressionRemainingMs(), Number.POSITIVE_INFINITY)
    assert.deepEqual(settleDelays, [0, CLOSED_TAB_SESSION_SETTLE_MS])
  } finally {
    unsubscribe()
    clock.uninstall()
  }
})

test('subscribeClosedTabChanges no-ops when chrome.sessions.onChanged is unavailable', () => {
  globalThis.chrome = {} as unknown as typeof globalThis.chrome
  const unsubscribe = subscribeClosedTabChanges(() => {})
  assert.equal(typeof unsubscribe, 'function')
  unsubscribe()
})

test('restoreClosedTab sets a 150ms suppression window on success', async () => {
  globalThis.chrome = {
    sessions: {
      restore: async () => undefined
    },
    runtime: { id: 'tab-out-test' }
  } as unknown as typeof globalThis.chrome

  const start = Date.now()
  const ok = await restoreClosedTab('session-xyz')
  assert.equal(ok, true)
  assert.equal(isClosedTabFetchSuppressed(start), true)
  assert.equal(isClosedTabFetchSuppressed(start + 50), true)
  assert.equal(isClosedTabFetchSuppressed(start + 200), false)
})

test('restoreClosedTab does not set a suppression window on failure', async () => {
  globalThis.chrome = {
    sessions: {
      restore: async () => { throw new Error('refused') }
    },
    runtime: { id: 'tab-out-test' }
  } as unknown as typeof globalThis.chrome

  const baseline = Date.now() + 10_000
  const ok = await restoreClosedTab('session-xyz')
  assert.equal(ok, false)
  assert.equal(isClosedTabFetchSuppressed(baseline), false)
})
