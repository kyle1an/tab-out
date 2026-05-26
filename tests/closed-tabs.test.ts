import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchClosedTabs, isClosedTabFetchSuppressed, restoreClosedTab, subscribeClosedTabChanges } from '../src/extension/closed-tabs.js'

type Session = chrome.sessions.Session
type SessionTab = chrome.tabs.Tab
type SessionWindow = chrome.windows.Window

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

  const result = await fetchClosedTabs()
  assert.equal(result.length, 3)
  assert.equal(result[0].sessionId, 'tab-a')
  assert.equal(result[0].lastClosedAt, 1_700_000_010)
  assert.equal(result[1].sessionId, 'tab-b')
  assert.equal(result[1].lastClosedAt, 1_700_000_020)
  assert.equal(result[2].sessionId, 'tab-c')
  assert.equal(result[2].lastClosedAt, 1_700_000_020)
})

test('fetchClosedTabs drops chrome:// and chrome-extension:// urls', async () => {
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
      tab: { sessionId: 'c', id: 3, windowId: 1, url: 'https://example.com/keep', title: 'Keep', favIconUrl: '' } as SessionTab & { sessionId: string }
    }
  ])

  const result = await fetchClosedTabs()
  assert.equal(result.length, 1)
  assert.equal(result[0].sessionId, 'c')
})

test('fetchClosedTabs drops tabs without urls and entries without sessionId', async () => {
  setSessionsApi([
    { lastModified: 1, tab: { id: 1, windowId: 1, url: '', title: 'no url', favIconUrl: '' } as SessionTab },
    { lastModified: 2, tab: { sessionId: '', id: 2, windowId: 1, url: 'https://example.com/x', title: 'x', favIconUrl: '' } as SessionTab & { sessionId: string } }
  ])
  const result = await fetchClosedTabs()
  assert.equal(result.length, 0)
})

test('fetchClosedTabs resolves to empty when chrome.sessions is unavailable', async () => {
  globalThis.chrome = {} as unknown as typeof globalThis.chrome
  const result = await fetchClosedTabs()
  assert.deepEqual(result, [])
})

test('restoreClosedTab calls chrome.sessions.restore and resolves true on success', async () => {
  let calledWith: string | undefined
  globalThis.chrome = {
    sessions: {
      restore: async (id?: string) => {
        calledWith = id
        return undefined
      }
    },
    runtime: { id: 'tab-out-test' }
  } as unknown as typeof globalThis.chrome

  const ok = await restoreClosedTab('session-xyz')
  assert.equal(ok, true)
  assert.equal(calledWith, 'session-xyz')
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

  let fired = 0
  const unsubscribe = subscribeClosedTabChanges(() => { fired += 1 })
  assert.equal(listeners.length, 1)
  listeners[0]()
  assert.equal(fired, 1)
  unsubscribe()
  assert.equal(listeners.length, 0)
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
