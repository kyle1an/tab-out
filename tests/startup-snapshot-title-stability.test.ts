import assert from 'node:assert/strict'
import test from 'node:test'

import { createStartupSnapshotService } from '../src/extension/background/startup-snapshot-service.js'
import { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY } from '../src/extension/startup-snapshot.js'
import type { DashboardTab } from '../src/extension/types'

const pageUrl = 'https://example.test/docs'
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

function cachedSuspendedTab(): DashboardTab {
  return {
    id: 7,
    url: pageUrl,
    rawUrl: `chrome-extension://suspender-id/suspended.html#ttl=Example%20Docs&uri=${pageUrl}`,
    suspended: true,
    title: 'Example Docs',
    status: 'complete',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    index: 0
  }
}

test('background startup snapshots retain the cached title of a waking suspended tab', async (t) => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  const sessionStore: Record<string, any> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: {
      savedAt: Date.now(),
      snapshot: {
        dashboard: {
          realTabs: [cachedSuspendedTab()],
          domainGroups: []
        },
        tabHistory: emptyTabHistory,
        workingSet: { items: [] },
        closedTabs: []
      }
    }
  }
  const localStore: Record<string, unknown> = {}

  ;(globalThis as any).window = { LOCAL_CUSTOM_GROUPS: [], LOCAL_PATH_GROUPERS: [] }
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: {
      query: async () => [{
        id: 7,
        url: pageUrl,
        title: 'Example',
        status: 'loading',
        windowId: 1,
        active: false,
        pinned: false,
        groupId: -1,
        index: 0,
        favIconUrl: ''
      }]
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => sessionStore,
        set: async (value: Record<string, unknown>) => Object.assign(sessionStore, value)
      },
      local: {
        get: async () => localStore,
        set: async (value: Record<string, unknown>) => Object.assign(localStore, value)
      }
    }
  }

  t.after(() => {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  })

  const service = createStartupSnapshotService({
    getTabHistorySnapshot: async () => emptyTabHistory as any,
    getWorkingSetActivity: async () => emptyActivity as any
  })
  await service.refreshNow()

  const [cachedTab] = sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY].snapshot.dashboard.realTabs
  assert.equal(cachedTab.title, 'Example Docs')
  assert.equal(cachedTab.retainedSuspendedTitle, true)
})
