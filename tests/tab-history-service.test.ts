import assert from 'node:assert/strict'
import test from 'node:test'
import { createTabHistoryService } from '../src/extension/background/tab-history-service.js'
import { normalizeTabHistorySnapshot } from '../src/extension/tab-history.js'
import { emptyWorkingSetActivity, recordWorkingSetActivity } from '../src/extension/working-set.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStore } from '../src/extension/types'

function makeChromeApi(state: {
  history?: {
    stack: { windowId: number; tabId: number }[]
    index: number
    pending?: { windowId: number; tabId: number; createdAt: number }[]
  }
  tabs?: chrome.tabs.Tab[]
  activity?: WorkingSetActivityStore
}): ChromeApi {
  const history = state.history || { stack: [], index: -1 }
  const tabs = state.tabs || []
  const activity = state.activity || emptyWorkingSetActivity()
  const storage = new Map<string, unknown>([
    ['globalTabHistory', history],
    ['workingSetActivity', activity]
  ])
  return {
    tabs: {
      query: async (q: chrome.tabs.QueryInfo) => {
        if ('windowId' in q && typeof q.windowId === 'number') {
          return tabs.filter((t) => t.windowId === q.windowId && (q.active === undefined || !!t.active === !!q.active))
        }
        return tabs
      },
      update: async () => undefined,
      remove: async () => undefined
    } as unknown as ChromeApi['tabs'],
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window]
    } as unknown as ChromeApi['windows'],
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) storage.set(k, v)
        }
      }
    } as unknown as ChromeApi['storage']
  } as ChromeApi
}

test('getTabHistorySnapshot populates lastActivatedAt from the activity log', async () => {
  // Anchor to the live clock: getTabHistorySnapshot prunes activity older than
  // ACTIVITY_RETENTION_MS (30 days) relative to Date.now(), so a hardcoded past
  // date rots out of the window and the record disappears.
  const now = Date.now()
  let activity = emptyWorkingSetActivity()
  activity = recordWorkingSetActivity(activity, {
    kind: 'activation',
    at: now - 1000,
    tab: { url: 'https://example.com/a', rawUrl: 'https://example.com/a', title: 'A' }
  })

  const service = createTabHistoryService(makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 10 }], index: 0 },
    tabs: [{ id: 10, windowId: 1, url: 'https://example.com/a', title: 'A', active: true } as chrome.tabs.Tab],
    activity
  }))

  const snapshot = await service.getTabHistorySnapshot()
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0].lastActivatedAt, now - 1000)
})

test('getTabHistorySnapshot sets lastActivatedAt to null when the URL has no activity record', async () => {
  const service = createTabHistoryService(makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 10 }], index: 0 },
    tabs: [{ id: 10, windowId: 1, url: 'https://example.com/a', title: 'A', active: true } as chrome.tabs.Tab]
  }))

  const snapshot = await service.getTabHistorySnapshot()
  assert.equal(snapshot.entries[0].lastActivatedAt, null)
})

test('getTabHistorySnapshot marks only live awake loading tabs as loading', async () => {
  const suspendedRawUrl = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/suspended.html#ttl=Example&uri=https%3A%2F%2Fexample.test%2Fsuspended'
  const service = createTabHistoryService(makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10 },
        { windowId: 1, tabId: 11 },
        { windowId: 1, tabId: 12 }
      ],
      index: 0
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://example.test/loading', title: 'Loading', status: 'loading', active: true } as chrome.tabs.Tab,
      { id: 11, windowId: 1, url: 'https://example.test/complete', title: 'Complete', status: 'complete' } as chrome.tabs.Tab,
      { id: 12, windowId: 1, url: suspendedRawUrl, title: 'Suspended', status: 'loading' } as chrome.tabs.Tab
    ]
  }))

  const snapshot = await service.getTabHistorySnapshot()
  const byTabId = new Map(snapshot.entries.map((entry) => [entry.tabId, entry]))

  assert.equal(byTabId.get(10)?.loading, true)
  assert.equal(byTabId.get(11)?.loading, false)
  assert.equal(byTabId.get(12)?.loading, false)
})

test('getTabHistorySnapshot can use an already-read activity snapshot', async () => {
  // Anchor to the live clock: getTabHistorySnapshot prunes activity older than
  // ACTIVITY_RETENTION_MS (30 days) relative to Date.now(), so a hardcoded past
  // date rots out of the window and the record disappears.
  const now = Date.now()
  let activity = emptyWorkingSetActivity()
  activity = recordWorkingSetActivity(activity, {
    kind: 'activation',
    at: now - 500,
    tab: { url: 'https://example.test/b', rawUrl: 'https://example.test/b', title: 'B' }
  })

  const service = createTabHistoryService(makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs: [{ id: 11, windowId: 1, url: 'https://example.test/b', title: 'B', active: true } as chrome.tabs.Tab]
  }))

  const snapshot = await service.getTabHistorySnapshot(activity)
  assert.equal(snapshot.entries[0].lastActivatedAt, now - 500)
})

test('activated history reserves the bounded index budget before pending tabs', async () => {
  const stack = Array.from({ length: 47 }, (_, index) => ({
    windowId: 1,
    tabId: index + 1
  }))
  const pending = Array.from({ length: 3 }, (_, index) => ({
    windowId: 1,
    tabId: index + 48,
    createdAt: index + 1
  }))
  const tabs = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    url: `https://tab-${index + 1}.example/`,
    title: `Tab ${index + 1}`,
    active: index === 46
  } as chrome.tabs.Tab))
  const service = createTabHistoryService(makeChromeApi({
    history: { stack, index: 46, pending },
    tabs
  }))

  const snapshot = await service.getTabHistorySnapshot()

  assert.equal(snapshot.stackSize, 47)
  assert.equal(snapshot.pendingSize, 1)
  assert.equal(snapshot.entries.length, 48)
  assert.equal(snapshot.entries.at(-1)?.tabId, 48)
  assert.equal(snapshot.entries.at(-1)?.pending, true)
})

test('normalizeTabHistorySnapshot preserves lastActivatedAt on entries', () => {
  const result = normalizeTabHistorySnapshot({
    stackSize: 1,
    maxSize: 24,
    cursorIndex: 0,
    currentIndex: 0,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: 10,
    activeWindowId: 1,
    activeWasInserted: false,
    entries: [
      {
        index: 0,
        tabId: 10,
        windowId: 1,
        exists: true,
        active: true,
        activeInOtherWindow: false,
        isApp: false,
        pinned: false,
        discarded: false,
        suspended: false,
        cursor: true,
        current: true,
        previousTarget: false,
        nextTarget: false,
        title: 'A',
        url: 'https://example.com/a',
        rawUrl: 'https://example.com/a',
        displayUrl: 'example.com/a',
        favIconUrl: '',
        lastActivatedAt: 1_700_000_000
      }
    ]
  })
  assert.equal(result.entries[0].lastActivatedAt, 1_700_000_000)
})

test('normalizeTabHistorySnapshot defaults missing lastActivatedAt to null', () => {
  const result = normalizeTabHistorySnapshot({
    entries: [{ tabId: 10, windowId: 1 } as unknown as never]
  })
  assert.equal(result.entries[0].lastActivatedAt, null)
})
