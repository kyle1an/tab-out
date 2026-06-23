import assert from 'node:assert/strict'
import test from 'node:test'

import { createStartupSnapshotService } from '../src/extension/background/startup-snapshot-service.js'
import { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, LOCAL_GROUPING_CONFIG_ACTIVE_KEY } from '../src/extension/startup-snapshot.js'

function makeChromeTab(id: number, url: string, title: string): chrome.tabs.Tab {
  return {
    id,
    index: id - 1,
    windowId: 1,
    highlighted: false,
    active: id === 1,
    pinned: false,
    incognito: false,
    selected: id === 1,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url,
    title,
    favIconUrl: ''
  } as chrome.tabs.Tab
}

const emptyTabHistory = {
  stackSize: 0,
  maxSize: 48,
  cursorIndex: -1,
  currentIndex: -1,
  previousIndex: -1,
  nextIndex: -1,
  activeTabId: null,
  activeWindowId: null,
  activeWasInserted: false,
  entries: []
}
const emptyActivity = { version: 1, records: {} }

test('startup snapshot service writes session + durable caches from worker-side inputs', async () => {
  const writes: Record<string, any> = {}
  const localStore: Record<string, unknown> = {}
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report')
  ]

  ;(globalThis as any).window = { LOCAL_CUSTOM_GROUPS: [], LOCAL_PATH_GROUPERS: [] }
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => openTabs },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => { writes.session = value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] }
      },
      local: {
        get: async () => localStore,
        set: async (value: Record<string, unknown>) => {
          Object.assign(localStore, value)
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) writes.local = value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
        }
      }
    }
  }

  const service = createStartupSnapshotService({
    getTabHistorySnapshot: async () => emptyTabHistory as any,
    getWorkingSetActivity: async () => emptyActivity as any
  })
  await service.refreshNow()

  assert.ok(writes.session, 'session cache written')
  assert.ok(writes.local, 'durable cache written')
  assert.deepEqual(writes.session.snapshot.dashboard.domainGroups.map((group: any) => group.domain), ['example.com', 'example.test'])
  assert.deepEqual(writes.local.snapshot.dashboard.realTabs.map((tab: any) => tab.url), openTabs.map((tab) => tab.url))
})

test('startup snapshot service defers grouping when local grouping config is active', async () => {
  let sessionWritten = false
  let tabsQueried = false

  ;(globalThis as any).window = { LOCAL_CUSTOM_GROUPS: [], LOCAL_PATH_GROUPERS: [] }
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out' },
    tabs: { query: async () => { tabsQueried = true; return [] } },
    storage: {
      session: { get: async () => ({}), set: async () => { sessionWritten = true } },
      local: { get: async () => ({ [LOCAL_GROUPING_CONFIG_ACTIVE_KEY]: true }), set: async () => {} }
    }
  }

  const service = createStartupSnapshotService({
    getTabHistorySnapshot: async () => emptyTabHistory as any,
    getWorkingSetActivity: async () => emptyActivity as any
  })
  await service.refreshNow()

  assert.equal(tabsQueried, false, 'does not gather tabs when deferring to the page')
  assert.equal(sessionWritten, false, 'does not write a snapshot when page-only grouping config is active')
})
