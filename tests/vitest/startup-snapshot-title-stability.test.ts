import { assert, it, vi } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { TestClock } from 'effect/testing'

import { STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS, StartupSnapshot } from '../../src/extension/background/startup-snapshot-service.js'
import { BrowserTabs } from '../../src/extension/browser-tabs-service.js'
import type { CapturedDashboardServiceState } from '../../src/extension/dashboard-service-messages.js'
import { DASHBOARD_STARTUP_SEED_CACHE_KEY } from '../../src/extension/startup-snapshot.js'
import { parseDashboardStartupSeedBoundary } from '../../src/extension/startup-snapshot-schema.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from '../../src/extension/types'
import { makeChromeTab } from '../helpers/chrome-tab.js'

const pageUrl = 'https://example.test/docs'
const emptyTabHistory: TabHistorySnapshot = {
  stackSize: 0,
  maxSize: 48,
  cursorIndex: -1,
  currentIndex: -1,
  previousIndex: -1,
  nextIndex: -1,
  activeTabId: null,
  activeWindowId: null,
  activeWasInserted: false,
  entries: [],
}
const emptyActivity: WorkingSetActivityStore = { version: 1, records: {} }

it.effect('background startup snapshots retain the cached title of a waking suspended tab', () => {
  const sessionStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SEED_CACHE_KEY]: {
      schemaVersion: 2,
      savedAt: Date.now(),
      captureStartedAt: Date.now(),
      cardOrder: ['domain-example.test'],
      workingSetPriority: { epoch: Date.now(), keys: [] },
      titleRetention: [{
        tabId: 7,
        url: pageUrl,
        title: 'Example Docs',
        kind: 'suspended',
      }],
    },
  }
  const localStore: Record<string, unknown> = {}
  let sessionReadCount = 0
  let tabsQueryCount = 0

  vi.stubGlobal('chrome', {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        return [{
          ...makeChromeTab(7, pageUrl, 'Example'),
          active: false,
          index: 0,
          status: 'loading',
        }]
      },
    },
    windows: {
      getAll: async () => [{
        id: 1,
        focused: true,
        type: 'normal',
        alwaysOnTop: false,
        incognito: false,
      }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }),
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
        set: async (value: Record<string, unknown>) => Object.assign(sessionStore, value),
      },
      local: {
        get: async () => localStore,
        set: async (value: Record<string, unknown>) => Object.assign(localStore, value),
      },
    },
  })

  const startupLayer = StartupSnapshot.layer({
    getDashboardServiceState: Effect.tryPromise({
      try: async (): Promise<CapturedDashboardServiceState> => ({
        tabHistory: emptyTabHistory,
        workingSetActivity: emptyActivity,
        retainedPages: [],
        retentionHealth: null,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll(),
        },
      }),
      catch: (cause) => cause,
    }),
  }).pipe(Layer.provideMerge(BrowserTabs.layer()))

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    yield* service.refreshNow()
    assert.strictEqual(tabsQueryCount, 0, 'an unknown cache read must preserve the cache and retry seeding')

    yield* TestClock.adjust(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS)
    yield* Effect.yieldNow

    const seed = parseDashboardStartupSeedBoundary(
      sessionStore[DASHBOARD_STARTUP_SEED_CACHE_KEY],
    )
    assert.isNotNull(seed)
    if (seed === null) return
    assert.strictEqual(seed.titleRetention?.[0]?.title, 'Example Docs')
    assert.strictEqual(seed.titleRetention?.[0]?.kind, 'retained-loading')
  }).pipe(Effect.provide(startupLayer))
})
