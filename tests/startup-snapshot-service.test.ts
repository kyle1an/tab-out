import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import FakeTimers from '@sinonjs/fake-timers'

import {
  STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS,
  STARTUP_SNAPSHOT_DEBOUNCE_MS,
  STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS,
  createStartupSnapshotService,
  startupSnapshotStorageChangesRequireRefresh
} from '../src/extension/background/startup-snapshot-service.js'
import { CLOSED_TAB_RESTORE_WATCHDOG_MS, CLOSED_TAB_SESSION_SETTLE_MS } from '../src/extension/closed-tabs.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import { PAGE_CHIP_PIN_STORAGE_KEY, pageChipPinId, pageChipPinKeyForUrl, pageChipPinScopeId } from '../src/extension/page-chip-pins.js'
import { addSavedPageToStore, emptySavedPagesStore, SAVED_PAGES_STORAGE_KEY } from '../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY, subdomainPinId } from '../src/extension/section-pins.js'
import { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY } from '../src/extension/startup-snapshot.js'
import { makeChromeTab } from './helpers/chrome-tab.js'
import { installWebLocksStub } from './helpers/web-locks.js'

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

function installEmptyWorkerChrome(): void {
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} }
    }
  }
}

function captureDashboardServiceState(
  getTabHistorySnapshot: () => Promise<any> = async () => emptyTabHistory,
  getWorkingSetActivity: () => Promise<any> = async () => emptyActivity
) {
  return async () => {
    const [tabHistory, workingSetActivity, tabs, windows] = await Promise.all([
      getTabHistorySnapshot(),
      getWorkingSetActivity(),
      chrome.tabs.query({}),
      chrome.windows.getAll()
    ])
    return {
      tabHistory,
      workingSetActivity,
      openTabsSnapshot: { tabs, windows }
    }
  }
}

test('startup snapshot refreshes only for local state that changes its rendered shape', () => {
  const change = { newValue: [] } as chrome.storage.StorageChange

  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [SECTION_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [PAGE_CHIP_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [SAVED_PAGES_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ 'tab-out:local-path-groupers-active': change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'session'), false)
})

test('startup snapshot service writes a render-ready Warm Snapshot and source-only Durable Checkpoint', async () => {
  const writes: Record<string, any> = {}
  const localReadKeys: Array<string | string[]> = []
  let tabsQueryStartedAt = Number.NaN
  const pinnedSectionId = subdomainPinId('example.com', 'www')
  const pinnedPageChipId = pageChipPinId(
    'tabs',
    pageChipPinScopeId('example.com', '', '', ''),
    pageChipPinKeyForUrl('https://example.com/docs')
  )
  const expectedLocalState = {
    loaded: true,
    pinnedDomains: ['example.com'],
    pinnedSectionIds: [pinnedSectionId],
    pinnedPageChipIds: [pinnedPageChipId]
  }
  const localStore: Record<string, unknown> = {
    [DOMAIN_PIN_STORAGE_KEY]: expectedLocalState.pinnedDomains,
    [SECTION_PIN_STORAGE_KEY]: expectedLocalState.pinnedSectionIds,
    [PAGE_CHIP_PIN_STORAGE_KEY]: expectedLocalState.pinnedPageChipIds,
    'tab-out:local-path-groupers-active': true
  }
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report')
  ]

  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: {
      query: async () => {
        tabsQueryStartedAt = performance.timeOrigin + performance.now()
        return openTabs
      }
    },
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
        get: async (keys: string | string[]) => {
          localReadKeys.push(keys)
          return localStore
        },
        set: async (value: Record<string, unknown>) => {
          Object.assign(localStore, value)
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) writes.local = value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
        }
      }
    }
  }

  const service = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })
  await service.refreshNow()

  assert.ok(writes.session, 'session cache written')
  assert.ok(writes.local, 'durable cache written')
  assert.ok(writes.session.captureStartedAt <= tabsQueryStartedAt)
  assert.deepEqual(writes.session.snapshot.dashboard.domainGroups.map((group: any) => group.domain), ['example.com', 'example.test'])
  assert.deepEqual(writes.local.snapshot.dashboard.realTabs.map((tab: any) => tab.url), openTabs.map((tab) => tab.url))
  assert.deepEqual(writes.session.localState, expectedLocalState)
  assert.deepEqual(writes.local.localState, expectedLocalState)
  assert.deepEqual(writes.session.snapshot.startupViewModel.pinnedDomains, ['example.com'])
  assert.deepEqual(writes.session.snapshot.startupViewModel.pinnedSectionIds, [pinnedSectionId])
  assert.deepEqual(writes.session.snapshot.startupViewModel.pinnedPageChipIds, [pinnedPageChipId])
  assert.equal(writes.session.snapshot.startupViewModel.viewModel.source, 'tabs')
  assert.equal(writes.session.snapshot.startupViewModel.viewModel.matchedCards.length, 2)
  assert.equal(writes.local.snapshot.startupViewModel, undefined)
  assert.equal(localReadKeys.some((keys) => typeof keys === 'string' && [
    DOMAIN_PIN_STORAGE_KEY,
    SECTION_PIN_STORAGE_KEY,
    PAGE_CHIP_PIN_STORAGE_KEY
  ].includes(keys)), false)
  assert.equal(localReadKeys.some((keys) => Array.isArray(keys) && [
    DOMAIN_PIN_STORAGE_KEY,
    SECTION_PIN_STORAGE_KEY,
    PAGE_CHIP_PIN_STORAGE_KEY
  ].every((key) => keys.includes(key))), true)
})

test('a worker snapshot rebuild never writes Saved Pages metadata', async () => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  const restoreLocks = installWebLocksStub()
  const savedUrl = 'https://example.com/docs'
  const baseStore = addSavedPageToStore(emptySavedPagesStore(), {
    url: savedUrl,
    rawUrl: savedUrl,
    title: 'Stale saved title',
    favIconUrl: '',
    isTabOut: false,
    isApp: false
  }, 100)
  const localStore: Record<string, unknown> = { [SAVED_PAGES_STORAGE_KEY]: baseStore }
  let savedPagesWrites = 0

  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [makeChromeTab(1, savedUrl, 'Fresh page title')] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: {
        get: async () => localStore,
        set: async (values: Record<string, unknown>) => {
          if (SAVED_PAGES_STORAGE_KEY in values) savedPagesWrites += 1
          Object.assign(localStore, values)
        }
      }
    }
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState()
    })
    await service.refreshNow()
    for (let i = 0; i < 5; i += 1) await delay(0)

    assert.equal(savedPagesWrites, 0, 'the worker build must leave Saved Pages storage to the page')
  } finally {
    ;(globalThis as { chrome?: unknown }).chrome = previousChrome
    restoreLocks()
  }
})

test('startup snapshot service schedules one non-sliding checkpoint and promotes the latest Warm Snapshot without rebuilding', async () => {
  const clock = FakeTimers.install({ now: 100, toFake: ['Date'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  const sessionStore: Record<string, unknown> = {}
  const localStore: Record<string, unknown> = {}
  let sessionWrites = 0
  let durableWrites = 0
  let snapshotBuilds = 0
  let scheduledAlarm: chrome.alarms.Alarm | undefined
  const alarmCreates: chrome.alarms.AlarmCreateInfo[] = []
  let blockNextSessionWrite = false
  const { promise: blockedSessionWriteStarted, resolve: markBlockedSessionWriteStarted } = Promise.withResolvers<void>()
  const { promise: blockedSessionWriteReleased, resolve: releaseBlockedSessionWrite } = Promise.withResolvers<void>()
  let openTabs = [makeChromeTab(1, 'https://first.example/docs', 'First Docs')]

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
        get: async () => sessionStore,
        set: async (value: Record<string, unknown>) => {
          sessionWrites += 1
          if (blockNextSessionWrite) {
            blockNextSessionWrite = false
            markBlockedSessionWriteStarted()
            await blockedSessionWriteReleased
          }
          Object.assign(sessionStore, value)
        }
      },
      local: {
        get: async () => localStore,
        set: async (value: Record<string, unknown>) => {
          durableWrites += 1
          Object.assign(localStore, value)
        }
      }
    }
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState(async () => {
        snapshotBuilds += 1
        return emptyTabHistory
      }),
      alarms: {
        get: async () => scheduledAlarm,
        create: async (name, alarmInfo) => {
          alarmCreates.push(alarmInfo)
          scheduledAlarm = {
            name,
            scheduledTime: alarmInfo.when ?? Date.now()
          }
        }
      }
    })
    await service.refreshNow()
    assert.equal(sessionWrites, 1)
    assert.equal(durableWrites, 1)
    assert.equal(alarmCreates.length, 0)

    clock.setSystemTime(1000)
    openTabs = [makeChromeTab(1, 'https://latest.example/docs', 'Latest Docs')]
    await service.refreshNow()
    assert.equal(sessionWrites, 2)
    assert.equal(durableWrites, 1)
    assert.deepEqual(alarmCreates, [{ when: 100 + STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS }])

    clock.setSystemTime(2000)
    openTabs = [makeChromeTab(1, 'https://newest.example/docs', 'Newest Docs')]
    blockNextSessionWrite = true
    const newestRefresh = service.refreshNow()
    await blockedSessionWriteStarted
    scheduledAlarm = undefined
    clock.setSystemTime(100 + STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS)
    const buildsBeforePromotion = snapshotBuilds
    const promotion = service.promoteDurableCheckpoint()
    releaseBlockedSessionWrite()
    await Promise.all([newestRefresh, promotion])

    assert.equal(sessionWrites, 3)
    assert.equal(alarmCreates.length, 1, 'later changes and concurrent delivery do not replace the pending alarm')

    assert.equal(durableWrites, 2)
    assert.equal(snapshotBuilds, buildsBeforePromotion, 'checkpoint promotion does not capture or rebuild browser state')
    assert.deepEqual(
      (localStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).snapshot.dashboard.domainGroups.map((group: any) => group.domain),
      ['newest.example']
    )
    assert.equal((localStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).snapshot.startupViewModel, undefined)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service uses captured focus when a worker current-window read would be unknown', async () => {
  installEmptyWorkerChrome()
  let cacheWriteCount = 0
  let currentWindowReads = 0
  ;(chrome.windows.getCurrent as any) = async () => {
    currentWindowReads += 1
    return { focused: true, type: 'normal' }
  }
  ;(chrome.storage.session.set as any) = async () => { cacheWriteCount += 1 }
  ;(chrome.storage.local.set as any) = async () => { cacheWriteCount += 1 }

  const service = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })
  await service.refreshNow()

  assert.equal(cacheWriteCount, 2)
  assert.equal(currentWindowReads, 0)
})

test('startup snapshot service reuses one browser capture so dashboard and history cannot mix generations', async () => {
  const firstTab = makeChromeTab(1, 'https://first.example.test/', 'First generation')
  const laterTab = makeChromeTab(2, 'https://later.example.test/', 'Later generation')
  const windows = [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[]
  let tabsQueryCount = 0
  let windowsGetAllCount = 0
  let windowsGetCurrentCount = 0
  let cachedSnapshot: any = null

  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        return tabsQueryCount === 1 ? [firstTab] : [laterTab]
      }
    },
    windows: {
      getAll: async () => {
        windowsGetAllCount += 1
        return windows
      },
      getCurrent: async () => {
        windowsGetCurrentCount += 1
        return windows[0]
      }
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          cachedSnapshot = value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
        }
      },
      local: { get: async () => ({}), set: async () => {} }
    }
  }

  const tabHistory = {
    ...emptyTabHistory,
    stackSize: 1,
    cursorIndex: 0,
    currentIndex: 0,
    activeTabId: 1,
    activeWindowId: 1,
    entries: [{
      index: 0,
      tabId: 1,
      windowId: 1,
      exists: true,
      active: true,
      title: 'First generation',
      url: 'https://first.example.test/',
      rawUrl: 'https://first.example.test/'
    }]
  }
  const service = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState(async () => tabHistory)
  })

  await service.refreshNow()

  assert.equal(tabsQueryCount, 1)
  assert.equal(windowsGetAllCount, 1)
  assert.equal(windowsGetCurrentCount, 0)
  assert.deepEqual(cachedSnapshot.snapshot.dashboard.realTabs.map((tab: any) => tab.id), [1])
  assert.deepEqual(cachedSnapshot.snapshot.tabHistory.entries.map((entry: any) => entry.tabId), [1])
})

test('a restarted startup snapshot service preserves cached card order', async () => {
  let openTabs = [
    makeChromeTab(1, 'https://example.test/one', 'Example Test One'),
    makeChromeTab(2, 'https://example.test/two', 'Example Test Two'),
    makeChromeTab(3, 'https://example.com/one', 'Example Com One')
  ]
  const sessionStore: Record<string, unknown> = {}
  const localStore: Record<string, unknown> = {}

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
        get: async () => sessionStore,
        set: async (value: Record<string, unknown>) => { Object.assign(sessionStore, value) }
      },
      local: {
        get: async () => localStore,
        set: async (value: Record<string, unknown>) => { Object.assign(localStore, value) }
      }
    }
  }

  const firstService = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })
  await firstService.refreshNow()
  const firstCached = sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any
  assert.deepEqual(
    firstCached.snapshot.dashboard.domainGroups.map((group: any) => group.domain),
    ['example.test', 'example.com']
  )

  openTabs = [
    makeChromeTab(1, 'https://example.test/one', 'Example Test One'),
    makeChromeTab(3, 'https://example.com/one', 'Example Com One'),
    makeChromeTab(4, 'https://example.com/two', 'Example Com Two'),
    makeChromeTab(5, 'https://example.com/three', 'Example Com Three')
  ]
  const restartedService = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })
  await restartedService.refreshNow()

  const restartedCached = sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any
  assert.deepEqual(
    restartedCached.snapshot.dashboard.domainGroups.map((group: any) => group.domain),
    ['example.test', 'example.com']
  )
})

test('startup snapshot service does not overwrite a warm cache when browser tab reads fail', async () => {
  let cacheWrites = 0
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: {
      query: async () => {
        throw new Error('Browser state temporarily unavailable')
      }
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: { get: async () => ({}), set: async () => { cacheWrites += 1 } },
      local: { get: async () => ({}), set: async () => { cacheWrites += 1 } }
    }
  }
  const service = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })

  await service.refreshNow()

  assert.equal(cacheWrites, 0)
})

test('startup snapshot service does not overwrite a warm cache when a pin read is unknown', async () => {
  let cacheWrites = 0
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      },
      local: {
        get: async (key: string | string[]) => {
          if (Array.isArray(key) && key.length === 3 && key.includes(SECTION_PIN_STORAGE_KEY)) {
            throw new Error('Pin state temporarily unavailable')
          }
          return {}
        },
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      }
    }
  }
  const service = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })

  await service.refreshNow()

  assert.equal(cacheWrites, 0)
})

test('startup snapshot service does not overwrite a warm cache when Saved Pages cannot be read', async () => {
  let cacheWrites = 0
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      },
      local: {
        get: async (key: string | string[]) => {
          if (key === SAVED_PAGES_STORAGE_KEY) throw new Error('Saved Pages temporarily unavailable')
          return {}
        },
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      }
    }
  }
  const service = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })

  await service.refreshNow()

  assert.equal(cacheWrites, 0)
})

test('startup snapshot service treats absent first-run pin keys as known empty lists', async () => {
  let cacheWrites = 0
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      },
      local: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      }
    }
  }
  const service = createStartupSnapshotService({
    getDashboardServiceState: captureDashboardServiceState()
  })

  await service.refreshNow()

  assert.equal(cacheWrites, 2)
})

test('startup snapshot service retries one transient cache-seed read failure without another browser event', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let sessionReadCount = 0
  let snapshotBuilds = 0
  installEmptyWorkerChrome()
  ;(chrome.storage.session.get as any) = async () => {
    sessionReadCount += 1
    if (sessionReadCount === 1) throw new Error('Session cache temporarily unavailable')
    return {}
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState(async () => {
        snapshotBuilds += 1
        return emptyTabHistory as any
      })
    })

    await service.refreshNow()
    assert.equal(sessionReadCount, 1)
    assert.equal(snapshotBuilds, 0)

    await clock.tickAsync(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS)

    assert.equal(sessionReadCount, 3, 'the successful retry seeds once, then the cache save verifies the session generation')
    assert.equal(snapshotBuilds, 1)
    assert.equal(clock.countTimers(), 0)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service bounds automatic cache-seed retries after repeated read failures', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let sessionReadCount = 0
  installEmptyWorkerChrome()
  ;(chrome.storage.session.get as any) = async () => {
    sessionReadCount += 1
    throw new Error('Session cache remains unavailable')
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState()
    })

    await service.refreshNow()
    assert.equal(sessionReadCount, 1)

    await clock.tickAsync(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS * 10)

    assert.equal(sessionReadCount, 2)
    assert.equal(clock.countTimers(), 0)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service cancels its cache-seed retry after an earlier manual refresh succeeds', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let sessionReadCount = 0
  installEmptyWorkerChrome()
  ;(chrome.storage.session.get as any) = async () => {
    sessionReadCount += 1
    if (sessionReadCount === 1) throw new Error('Session cache temporarily unavailable')
    return {}
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState()
    })

    await service.refreshNow()
    assert.equal(clock.countTimers(), 1)

    await service.refreshNow()
    assert.equal(sessionReadCount, 3)
    assert.equal(clock.countTimers(), 0)

    await clock.tickAsync(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS * 2)
    assert.equal(sessionReadCount, 3)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service coalesces pending debounced refreshes', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let snapshotBuilds = 0
  installEmptyWorkerChrome()

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState(async () => {
        snapshotBuilds += 1
        return emptyTabHistory as any
      })
    })

    service.scheduleRefresh()
    service.scheduleRefresh()
    assert.equal(clock.countTimers(), 2)

    await clock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
    assert.equal(clock.countTimers(), 0)
    assert.equal(snapshotBuilds, 1)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service bounds rebuilds during a sustained sessions event storm', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let snapshotBuilds = 0
  let cacheWrites = 0
  const sessionStore: Record<string, unknown> = {}
  const localStore: Record<string, unknown> = {}
  installEmptyWorkerChrome()
  ;(chrome.storage.session.get as any) = async () => sessionStore
  ;(chrome.storage.session.set as any) = async (value: Record<string, unknown>) => {
    cacheWrites += 1
    Object.assign(sessionStore, value)
  }
  ;(chrome.storage.local.get as any) = async () => localStore
  ;(chrome.storage.local.set as any) = async (value: Record<string, unknown>) => {
    cacheWrites += 1
    Object.assign(localStore, value)
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState(async () => {
        snapshotBuilds += 1
        return emptyTabHistory as any
      })
    })

    for (let elapsedMs = 0; elapsedMs < 120_000; elapsedMs += 1000) {
      service.sessionsChanged()
      await clock.tickAsync(1000)
    }
    await clock.tickAsync(5000)

    assert.ok(snapshotBuilds >= 1, 'a sustained burst still refreshes the warm snapshot')
    assert.ok(snapshotBuilds <= 4, `expected at most four bounded rebuilds, received ${snapshotBuilds}`)
    assert.equal(cacheWrites, 2, 'only the first materialization updates the two cache representations')
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('an immediate startup snapshot refresh consumes a pending debounce', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let snapshotBuilds = 0
  installEmptyWorkerChrome()

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState(async () => {
        snapshotBuilds += 1
        return emptyTabHistory as any
      })
    })

    service.scheduleRefresh()
    assert.equal(clock.countTimers(), 2)
    await service.refreshNow()

    assert.equal(clock.countTimers(), 0)
    assert.equal(snapshotBuilds, 1)
    await clock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
    assert.equal(snapshotBuilds, 1)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service refreshes again after a completed refresh', async () => {
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let snapshotBuilds = 0
  installEmptyWorkerChrome()

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState(async () => {
        snapshotBuilds += 1
        return emptyTabHistory as any
      })
    })

    await service.refreshNow()
    await service.refreshNow()

    assert.equal(snapshotBuilds, 2)
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service runs a trailing refresh requested during an active build', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let snapshotBuilds = 0
  const { promise: firstBuildBlocked, resolve: releaseFirstBuild } = Promise.withResolvers<void>()
  const { promise: firstBuildStarted, resolve: markFirstBuildStarted } = Promise.withResolvers<void>()
  installEmptyWorkerChrome()

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState(async () => {
        snapshotBuilds += 1
        if (snapshotBuilds === 1) {
          markFirstBuildStarted()
          await firstBuildBlocked
        }
        return emptyTabHistory as any
      })
    })

    const firstRefresh = service.refreshNow()
    await firstBuildStarted
    const trailingRefresh = service.refreshNow()
    releaseFirstBuild()
    await Promise.all([firstRefresh, trailingRefresh])

    assert.equal(snapshotBuilds, 1, 'an in-flight request does not start a tight rebuild loop')
    await clock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
    assert.equal(snapshotBuilds, 2)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('sessions changes invalidate an in-flight recently-closed read and schedule one settled retry', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  const { promise: firstSessionsRead, resolve: releaseFirstSessionsRead } = Promise.withResolvers<chrome.sessions.Session[]>()
  let sessionsReadCount = 0
  let cacheWrites = 0

  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: {
      getRecentlyClosed: async () => {
        sessionsReadCount += 1
        return sessionsReadCount === 1 ? firstSessionsRead : []
      }
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      },
      local: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      }
    }
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState()
    })
    const firstRefresh = service.refreshNow()
    for (let turn = 0; sessionsReadCount === 0 && turn < 10; turn += 1) await Promise.resolve()
    assert.equal(sessionsReadCount, 1)

    service.sessionsChanged()
    releaseFirstSessionsRead([])
    await firstRefresh
    assert.equal(cacheWrites, 0)

    await clock.tickAsync(CLOSED_TAB_SESSION_SETTLE_MS)
    assert.equal(sessionsReadCount, 1)
    assert.equal(cacheWrites, 0)

    await clock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
    assert.equal(sessionsReadCount, 2)
    assert.equal(cacheWrites, 2)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service holds a restore beyond 150ms and refreshes only after settlement', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let sessionsReadCount = 0
  let cacheWrites = 0

  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: {
      getRecentlyClosed: async () => {
        sessionsReadCount += 1
        return []
      }
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      },
      local: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      }
    }
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState()
    })
    service.sessionRestoreStarted('restore-slow')
    service.sessionsChanged()
    await service.refreshNow()

    await clock.tickAsync(CLOSED_TAB_SESSION_SETTLE_MS + 1)
    assert.equal(sessionsReadCount, 0)
    assert.equal(cacheWrites, 0)

    service.sessionRestoreSettled('restore-slow')
    await clock.tickAsync(CLOSED_TAB_SESSION_SETTLE_MS - 1)
    assert.equal(sessionsReadCount, 0)
    assert.equal(cacheWrites, 0)

    await clock.tickAsync(1)
    assert.equal(sessionsReadCount, 0)
    assert.equal(cacheWrites, 0)

    await clock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
    assert.equal(sessionsReadCount, 1)
    assert.equal(cacheWrites, 2)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('startup snapshot service releases an orphaned restore start through its watchdog', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let sessionsReadCount = 0
  let cacheWrites = 0

  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out', getURL: (path: string) => `chrome-extension://tab-out${path}` },
    tabs: { query: async () => [] },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: {
      getRecentlyClosed: async () => {
        sessionsReadCount += 1
        return []
      }
    },
    storage: {
      session: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      },
      local: {
        get: async () => ({}),
        set: async (value: Record<string, unknown>) => {
          if (value[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]) cacheWrites += 1
        }
      }
    }
  }

  try {
    const service = createStartupSnapshotService({
      getDashboardServiceState: captureDashboardServiceState()
    })
    service.sessionRestoreStarted('restore-orphaned')
    service.sessionsChanged()

    await clock.tickAsync(CLOSED_TAB_RESTORE_WATCHDOG_MS - 1)
    assert.equal(sessionsReadCount, 0)
    assert.equal(cacheWrites, 0)

    await clock.tickAsync(1 + CLOSED_TAB_SESSION_SETTLE_MS)
    assert.equal(sessionsReadCount, 0)
    assert.equal(cacheWrites, 0)

    await clock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
    assert.equal(sessionsReadCount, 1)
    assert.equal(cacheWrites, 2)
  } finally {
    clock.uninstall()
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})
