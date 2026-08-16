import assert from 'node:assert/strict'
import { afterEach, it, vi } from '@effect/vitest'

import { Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'

import { omitUndefined } from '../../src/lib/omit-undefined.js'
import {
  STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS,
  STARTUP_SNAPSHOT_DEBOUNCE_MS,
  STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM,
  STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS,
  STARTUP_SNAPSHOT_MAX_WAIT_MS,
  StartupSnapshot,
  startupSnapshotStorageChangesRequireRefresh,
} from '../../src/extension/background/startup-snapshot-service.js'
import { BrowserTabs } from '../../src/extension/browser-tabs-service.js'
import type { CapturedDashboardServiceState } from '../../src/extension/dashboard-service-messages.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../../src/extension/domain-pins.js'
import { RETAINED_PAGES_STORAGE_KEY } from '../../src/extension/retained-pages-storage.js'
import { PAGE_CHIP_PIN_STORAGE_KEY } from '../../src/extension/page-chip-pins.js'
import {
  SAVED_PAGES_STORAGE_KEY,
  addSavedPageToStore,
  emptySavedPagesStore,
} from '../../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY } from '../../src/extension/section-pins.js'
import {
  DASHBOARD_STARTUP_SEED_CACHE_KEY,
  type DashboardStartupSeed,
} from '../../src/extension/startup-snapshot.js'
import { parseDashboardStartupSeedBoundary } from '../../src/extension/startup-snapshot-schema.js'
import type { WorkingSetActivityStore } from '../../src/extension/types'
import { makeChromeTab } from '../helpers/chrome-tab.js'

afterEach(() => vi.useRealTimers())

const emptyTabHistory = {
  stackSize: 0,
  maxSize: 48,
  cursorIndex: -1,
  currentIndex: -1,
  previousIndex: -1,
  nextIndex: -1,
  activeTabId: null,
  activeWindowId: 1,
  activeWasInserted: false,
  entries: [],
}

const emptyActivity: WorkingSetActivityStore = { version: 1, records: {} }

function dashboardServiceState(
  tabs: chrome.tabs.Tab[],
  workingSetActivity = emptyActivity,
): CapturedDashboardServiceState {
  return {
    tabHistory: emptyTabHistory,
    workingSetActivity,
    retainedPages: [],
    retentionHealth: null,
    openTabsSnapshot: {
      tabs,
      windows: [{
        id: 1,
        focused: true,
        type: 'normal',
        alwaysOnTop: false,
        incognito: false,
      }],
    },
  }
}

function startupSnapshotLayer(
  options: {
    getDashboardServiceState: () => Promise<CapturedDashboardServiceState>
    alarms?: {
      create: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) => Promise<void>
      get: (name: string) => Promise<chrome.alarms.Alarm | undefined>
    }
  },
) {
  return StartupSnapshot.layer(omitUndefined({
    alarms: options.alarms,
    getDashboardServiceState: Effect.tryPromise({
      try: options.getDashboardServiceState,
      catch: (cause) => cause,
    }),
  })).pipe(Layer.provideMerge(BrowserTabs.layer()))
}

type StorageValues = Record<string, unknown>

function installWorkerChrome(
  options: {
    sessionValues?: StorageValues
    localValues?: StorageValues
    localGet?: (keys: string | string[]) => Promise<StorageValues>
    sessionGet?: (keys: string | string[]) => Promise<StorageValues>
  } = {},
) {
  const sessionValues = options.sessionValues ?? {}
  const localValues = options.localValues ?? {}
  let sessionWrites = 0
  let durableWrites = 0
  let savedPagesWrites = 0
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out/${path}`,
    },
    tabGroups: { query: async () => [] },
    storage: {
      session: {
        get: options.sessionGet ?? (async () => ({ ...sessionValues })),
        set: async (values: StorageValues) => {
          sessionWrites += 1
          Object.assign(sessionValues, values)
        },
        remove: async (key: string) => { delete sessionValues[key] },
      },
      local: {
        get: options.localGet ?? (async () => ({ ...localValues })),
        set: async (values: StorageValues) => {
          if (Object.hasOwn(values, DASHBOARD_STARTUP_SEED_CACHE_KEY)) durableWrites += 1
          if (Object.hasOwn(values, SAVED_PAGES_STORAGE_KEY)) savedPagesWrites += 1
          Object.assign(localValues, values)
        },
        remove: async (key: string) => { delete localValues[key] },
      },
    },
  })
  return {
    sessionValues,
    localValues,
    sessionWrites: () => sessionWrites,
    durableWrites: () => durableWrites,
    savedPagesWrites: () => savedPagesWrites,
  }
}

function storedSeed(values: StorageValues): DashboardStartupSeed | null {
  return parseDashboardStartupSeedBoundary(values[DASHBOARD_STARTUP_SEED_CACHE_KEY])
}

it('seed refreshes only for local sources that can change compact ordering', () => {
  const change: chrome.storage.StorageChange = { newValue: [] }

  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [RETAINED_PAGES_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [SAVED_PAGES_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [SECTION_PIN_STORAGE_KEY]: change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [PAGE_CHIP_PIN_STORAGE_KEY]: change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'session'), false)
})

it.effect('worker writes compact Warm and Durable seeds while preserving pinned and saved-only card order', () => {
  const savedUrl = 'https://saved.example/report'
  const savedPages = addSavedPageToStore(emptySavedPagesStore(), {
    url: savedUrl,
    rawUrl: savedUrl,
    title: 'Saved report',
    favIconUrl: '',
    isTabOut: false,
    isApp: false,
  }, 10)
  const storage = installWorkerChrome({
    localValues: {
      [DOMAIN_PIN_STORAGE_KEY]: ['example.test'],
      [SAVED_PAGES_STORAGE_KEY]: savedPages,
    },
  })
  const tabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report'),
  ]
  const serviceLayer = startupSnapshotLayer({
    getDashboardServiceState: async () => dashboardServiceState(tabs),
  })

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    yield* service.refreshNow()

    const warm = storedSeed(storage.sessionValues)
    const durable = storedSeed(storage.localValues)
    assert.deepEqual(warm?.cardOrder, [
      'domain-example.test',
      'domain-example.com',
      'domain-saved.example',
    ])
    assert.deepEqual(durable?.cardOrder, warm?.cardOrder)
    assert.equal(durable?.titleRetention, undefined)
    assert.equal(Object.hasOwn(warm ?? {}, 'snapshot'), false)
    assert.equal(Object.hasOwn(warm ?? {}, 'localState'), false)
    assert.equal(storage.savedPagesWrites(), 0)
  }).pipe(Effect.provide(serviceLayer))
})

it.effect('service schedules one non-sliding Durable promotion and promotes the newest Warm seed', () => {
  vi.useFakeTimers({ now: 100, toFake: ['Date'] })
  const storage = installWorkerChrome()
  let tabs = [makeChromeTab(1, 'https://first.example/docs', 'First')]
  let stateReads = 0
  let pendingAlarm: chrome.alarms.Alarm | undefined
  const alarmCreates: chrome.alarms.AlarmCreateInfo[] = []
  const serviceLayer = startupSnapshotLayer({
    getDashboardServiceState: async () => {
      stateReads += 1
      return dashboardServiceState(tabs)
    },
    alarms: {
      get: async () => pendingAlarm,
      create: async (name, alarmInfo) => {
        alarmCreates.push(alarmInfo)
        pendingAlarm = {
          name,
          persistAcrossSessions: alarmInfo.persistAcrossSessions ?? true,
          scheduledTime: alarmInfo.when ?? Date.now(),
        }
      },
    },
  })

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    yield* service.refreshNow()
    assert.deepEqual(storedSeed(storage.localValues)?.cardOrder, ['domain-first.example'])

    vi.setSystemTime(200)
    tabs = [makeChromeTab(2, 'https://second.example/docs', 'Second')]
    yield* service.refreshNow()
    assert.equal(alarmCreates.length, 1)
    assert.equal(alarmCreates[0]?.when, 100 + STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_INTERVAL_MS)
    assert.equal(alarmCreates[0]?.persistAcrossSessions, true)

    vi.setSystemTime(300)
    tabs = [makeChromeTab(3, 'https://latest.example/docs', 'Latest')]
    yield* service.refreshNow()
    assert.equal(alarmCreates.length, 1, 'later Warm changes do not slide the pending checkpoint')
    assert.deepEqual(storedSeed(storage.sessionValues)?.cardOrder, ['domain-latest.example'])
    assert.deepEqual(storedSeed(storage.localValues)?.cardOrder, ['domain-first.example'])

    yield* service.promoteDurableCheckpoint()
    assert.deepEqual(storedSeed(storage.localValues)?.cardOrder, ['domain-latest.example'])
    assert.equal(stateReads, 3, 'promotion copies the Warm seed without rebuilding')
    assert.equal(pendingAlarm?.name, STARTUP_SNAPSHOT_DURABLE_CHECKPOINT_ALARM)
  }).pipe(Effect.provide(serviceLayer))
})

it.effect('a transient cache read failure retries once before performing browser work', () => {
  let sessionReads = 0
  let stateReads = 0
  const storage = installWorkerChrome({
    sessionGet: async () => {
      sessionReads += 1
      if (sessionReads === 1) throw new Error('session storage unavailable')
      return {}
    },
  })
  const serviceLayer = startupSnapshotLayer({
    getDashboardServiceState: async () => {
      stateReads += 1
      return dashboardServiceState([
        makeChromeTab(1, 'https://example.test/docs', 'Example'),
      ])
    },
  })

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    yield* service.refreshNow()
    assert.equal(stateReads, 0)
    assert.equal(storage.sessionWrites(), 0)

    yield* TestClock.adjust(STARTUP_SNAPSHOT_CACHE_SEED_RETRY_MS)
    yield* Effect.yieldNow
    assert.equal(stateReads, 1)
    assert.ok(storedSeed(storage.sessionValues))
  }).pipe(Effect.provide(serviceLayer))
})

it.effect('unknown pin input preserves the prior Warm seed', () => {
  const prior = {
    schemaVersion: 2,
    savedAt: 10,
    captureStartedAt: 10,
    cardOrder: ['domain-prior.test'],
    workingSetPriority: { epoch: 10, keys: [] },
  }
  const sessionValues: StorageValues = { [DASHBOARD_STARTUP_SEED_CACHE_KEY]: prior }
  const storage = installWorkerChrome({
    sessionValues,
    localGet: async (keys) => {
      if (keys === DOMAIN_PIN_STORAGE_KEY) throw new Error('pin storage unavailable')
      return {}
    },
  })
  const serviceLayer = startupSnapshotLayer({
    getDashboardServiceState: async () => dashboardServiceState([
      makeChromeTab(1, 'https://new.test/docs', 'New'),
    ]),
  })

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    yield* service.refreshNow()

    assert.deepEqual(storage.sessionValues[DASHBOARD_STARTUP_SEED_CACHE_KEY], prior)
    assert.equal(storage.sessionWrites(), 0)
  }).pipe(Effect.provide(serviceLayer))
})

it.effect('seed scheduling uses a sliding quiet window with a fixed maximum wait', () => {
  installWorkerChrome()
  let stateReads = 0
  const serviceLayer = startupSnapshotLayer({
    getDashboardServiceState: async () => {
      stateReads += 1
      return dashboardServiceState([])
    },
  })

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    yield* service.scheduleRefresh()
    for (let elapsed = 3_000; elapsed < STARTUP_SNAPSHOT_MAX_WAIT_MS; elapsed += 3_000) {
      yield* TestClock.adjust(3_000)
      assert.equal(stateReads, 0)
      yield* service.scheduleRefresh()
    }

    yield* TestClock.adjust(3_000)
    assert.equal(stateReads, 1, 'fixed max wait refreshes despite a continuously sliding quiet timer')
  }).pipe(Effect.provide(serviceLayer))
})

it.effect('a refresh requested during an active seed flight runs once as a trailing refresh', () => {
  installWorkerChrome()
  const firstRead = Promise.withResolvers<void>()
  const releaseFirstRead = Promise.withResolvers<void>()
  let stateReads = 0
  const serviceLayer = startupSnapshotLayer({
    getDashboardServiceState: async () => {
      stateReads += 1
      if (stateReads === 1) {
        firstRead.resolve()
        await releaseFirstRead.promise
      }
      return dashboardServiceState([])
    },
  })

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    const active = yield* service.refreshNow().pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.promise(() => firstRead.promise)
    const coalesced = yield* service.refreshNow().pipe(Effect.forkChild({ startImmediately: true }))
    releaseFirstRead.resolve()
    yield* Fiber.join(active)
    yield* Fiber.join(coalesced)
    assert.equal(stateReads, 1)

    yield* TestClock.adjust(STARTUP_SNAPSHOT_DEBOUNCE_MS)
    assert.equal(stateReads, 2)
  }).pipe(Effect.provide(serviceLayer))
})

it.effect('a completed seed-flight failure does not block a later refresh', () => {
  const storage = installWorkerChrome()
  let stateReads = 0
  const serviceLayer = startupSnapshotLayer({
    getDashboardServiceState: async () => {
      stateReads += 1
      if (stateReads === 1) throw new Error('worker read unavailable')
      return dashboardServiceState([
        makeChromeTab(1, 'https://recovered.example/docs', 'Recovered'),
      ])
    },
  })

  return Effect.gen(function* () {
    const service = yield* StartupSnapshot
    yield* service.refreshNow()
    yield* service.refreshNow()

    assert.equal(stateReads, 2)
    assert.deepEqual(storedSeed(storage.sessionValues)?.cardOrder, [
      'domain-recovered.example',
    ])
  }).pipe(Effect.provide(serviceLayer))
})
