import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { Effect, ManagedRuntime } from 'effect'

import { STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS, StartupSnapshot } from '../src/extension/background/startup-snapshot-service.js'
import { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY } from '../src/extension/startup-snapshot.js'
import { makeCachedSuspendedTab } from './helpers/suspended-tab.js'

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

function createStartupSnapshotService(
  t: TestContext,
  getDashboardServiceState: () => Promise<any>
) {
  const runtime = ManagedRuntime.make(StartupSnapshot.layer({
    getDashboardServiceState: Effect.tryPromise({
      try: getDashboardServiceState,
      catch: (cause) => cause
    })
  }))
  runtime.runSync(Effect.void)
  const service = runtime.runSync(StartupSnapshot)
  t.after(() => runtime.dispose())
  return {
    refreshNow: () => runtime.runPromise(service.refreshNow())
  }
}

test('background startup snapshots retain the cached title of a waking suspended tab', async (t) => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  const sessionStore: Record<string, any> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: {
      savedAt: Date.now(),
      snapshot: {
        dashboard: {
          realTabs: [makeCachedSuspendedTab(pageUrl)],
          domainGroups: []
        },
        tabHistory: emptyTabHistory,
        workingSet: { items: [] },
        closedTabs: []
      }
    }
  }
  const localStore: Record<string, unknown> = {}
  let sessionReadCount = 0
  let tabsQueryCount = 0

  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        return [{
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
      }
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => {
          sessionReadCount += 1
          if (sessionReadCount === 1) throw new Error('session cache temporarily unavailable')
          return sessionStore
        },
        set: async (value: Record<string, unknown>) => Object.assign(sessionStore, value)
      },
      local: {
        get: async () => localStore,
        set: async (value: Record<string, unknown>) => Object.assign(localStore, value)
      }
    }
  }

  t.after(() => {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  })

  const service = createStartupSnapshotService(t, async () => ({
      tabHistory: emptyTabHistory as any,
      workingSetActivity: emptyActivity as any,
      openTabsSnapshot: {
        tabs: await chrome.tabs.query({}),
        windows: await chrome.windows.getAll()
      }
    }))
  await service.refreshNow()
  assert.equal(tabsQueryCount, 0, 'an unknown cache read must preserve the cache and retry seeding')

  await clock.tickAsync(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS)

  const [cachedTab] = sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY].snapshot.dashboard.realTabs
  assert.equal(cachedTab.title, 'Example Docs')
  assert.equal(cachedTab.retainedSuspendedTitle, true)
})
