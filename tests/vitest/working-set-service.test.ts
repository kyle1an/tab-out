import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Effect, Fiber, Layer, Result } from 'effect'

import {
  readChromeStorageValue,
  writeChromeStorageValue,
} from '../../src/extension/background/chrome-storage.js'
import { WorkingSetActivityStorage } from '../../src/extension/background/working-set-activity-storage.js'
import * as WorkingSet from '../../src/extension/background/working-set-service.js'
import type { ChromeApi } from '../../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStore } from '../../src/extension/types'
import { emptyWorkingSetActivity, recordWorkingSetActivity } from '../../src/extension/working-set.js'

const WORKING_SET_ACTIVITY_TEST_KEY = 'working-set-activity-test'

function chromeTab(id: number, path: string, audio: { audible?: boolean, muted?: boolean } = {}): chrome.tabs.Tab {
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
    url: `https://example.test/${path}`,
    title: path,
    audible: audio.audible,
    mutedInfo: { muted: !!audio.muted },
  } as chrome.tabs.Tab
}

function workingSetLayer(chromeApi: ChromeApi) {
  const storage = chromeApi.storage?.local
  const unavailable = (): Promise<never> => Promise.reject(
    new Error('Chrome local storage is unavailable for Working Set activity'),
  )
  const activityStorage = WorkingSetActivityStorage.layer({
    read: () => storage
      ? readChromeStorageValue(storage, WORKING_SET_ACTIVITY_TEST_KEY)
      : unavailable(),
    write: (change) => storage
      ? writeChromeStorageValue(
          storage,
          WORKING_SET_ACTIVITY_TEST_KEY,
          change.activity,
        )
      : unavailable(),
    replace: (activity) => storage
      ? writeChromeStorageValue(
          storage,
          WORKING_SET_ACTIVITY_TEST_KEY,
          activity,
        )
      : unavailable(),
  })
  return WorkingSet.WorkingSet.layer(chromeApi).pipe(
    Layer.provide(activityStorage),
  )
}

it.effect('Working Set activity reads wait for mutations that started first', () => {
  const now = Date.now()
  const tabs = [chromeTab(1, 'one'), chromeTab(2, 'two'), chromeTab(3, 'three')]
  let storedActivity: WorkingSetActivityStore = {
    version: 1,
    records: Object.fromEntries(tabs.slice(0, 2).map((tab, index) => {
      const url = tab.url as string
      const at = now - index * 1_000
      return [url, {
        key: url,
        url,
        title: tab.title || '',
        domain: 'example.test',
        lastSeenAt: at,
        lastActivatedAt: at,
        events: [{ kind: 'activation' as const, at }],
      }]
    })),
  }
  const { promise: activationQueryBlocked, resolve: releaseActivationQuery } = Promise.withResolvers<void>()
  const { promise: activationQueryStarted, resolve: markActivationQueryStarted } = Promise.withResolvers<void>()
  let activationQuerySeen = false
  const chromeApi = {
    tabs: {
      query: async (queryInfo: chrome.tabs.QueryInfo) => {
        if (queryInfo.windowId === 1 && !activationQuerySeen) {
          activationQuerySeen = true
          markActivationQueryStarted()
          await activationQueryBlocked
        }
        return tabs
      },
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    const activation = yield* service.recordTabActivation(1, 3).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.promise(() => activationQueryStarted)
    const activity = yield* service.getWorkingSetActivity().pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.yieldNow

    assert.equal(activity.pollUnsafe(), undefined)
    releaseActivationQuery()
    yield* Fiber.join(activation)
    assert.deepEqual(Object.keys((yield* Fiber.join(activity)).records).sort(), [
      'https://example.test/one',
      'https://example.test/three',
      'https://example.test/two',
    ])
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set window-focus activity preserves event order when captured tab lookups resolve out of order', () => {
  const tabs = [chromeTab(1, 'one'), { ...chromeTab(2, 'two'), windowId: 2, active: true, selected: true }]
  const { promise: windowOneLookup, resolve: resolveWindowOne } = Promise.withResolvers<chrome.tabs.Tab[]>()
  const { promise: windowTwoLookup, resolve: resolveWindowTwo } = Promise.withResolvers<chrome.tabs.Tab[]>()
  let storedActivity = emptyWorkingSetActivity()
  const chromeApi = {
    tabs: {
      query: async () => { throw new Error('captured focus events must not repeat the active-tab lookup') },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [
        { id: 1, focused: false, type: 'normal' },
        { id: 2, focused: true, type: 'normal' },
      ],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    const firstFocus = yield* service.recordFocusedWindowActiveTab(
      1,
      windowOneLookup.then((resolvedTabs) => resolvedTabs[0] ?? null),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    const secondFocus = yield* service.recordFocusedWindowActiveTab(
      2,
      windowTwoLookup.then((resolvedTabs) => resolvedTabs[0] ?? null),
    ).pipe(Effect.forkChild({ startImmediately: true }))
    const secondTab = tabs[1]
    const firstTab = tabs[0]
    assert.ok(secondTab)
    assert.ok(firstTab)
    resolveWindowTwo([secondTab])
    yield* Effect.yieldNow
    resolveWindowOne([firstTab])
    yield* Fiber.join(firstFocus)
    yield* Fiber.join(secondFocus)

    const activity = yield* service.getWorkingSetActivity()
    const firstRecord = activity.records['https://example.test/one']
    const secondRecord = activity.records['https://example.test/two']
    assert.ok(firstRecord)
    assert.ok(secondRecord)
    assert.ok((secondRecord.lastActivatedAt ?? 0) > (firstRecord.lastActivatedAt ?? 0))
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set counts paired tab-activation and window-focus signals once', () => {
  const tab = chromeTab(1, 'paired')
  let storedActivity = emptyWorkingSetActivity()
  let writeCount = 0
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeCount += 1
          storedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    yield* Effect.all([
      service.recordTabActivation(1, 1),
      service.recordFocusedWindowActiveTab(1),
    ], { concurrency: 'unbounded' })

    const record = (yield* service.getWorkingSetActivity()).records['https://example.test/paired']
    assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 1)
    assert.equal(writeCount, 1, 'the deduped paired signal must not rewrite the activity store')
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set does not treat same-page reloads as navigation activity', () => {
  const tab = chromeTab(1, 'workflows')
  let storedActivity = emptyWorkingSetActivity()
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    yield* service.recordTabActivation(1, 1)
    assert.ok(tab.url)
    yield* service.recordTabNavigation(1, { url: tab.url }, tab)

    const record = (yield* service.getWorkingSetActivity()).records['https://example.test/workflows']
    assert.deepEqual(record?.events.map((event) => event.kind), ['activation'])
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set tab lookup failures do not rewrite unchanged activity', () => {
  let writeCount = 0
  const chromeApi = {
    tabs: { query: async () => { throw new Error('tab lookup unavailable') } },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: emptyWorkingSetActivity() }),
        set: async () => { writeCount += 1 },
      },
    },
  } as unknown as ChromeApi

  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet
    yield* service.recordTabActivation(1, 1)
    assert.equal(writeCount, 0)
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set ignores active navigation for an unsupported page identity without writing', () => {
  const tab = {
    ...chromeTab(1, 'ignored'),
    url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html',
  }
  let writeCount = 0
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: emptyWorkingSetActivity() }),
        set: async () => { writeCount += 1 },
      },
    },
  } as unknown as ChromeApi

  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet
    yield* service.recordTabNavigation(
      1,
      { url: tab.url },
      tab,
    )
    assert.equal(writeCount, 0)
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set does not dedupe a paired focus event after the activation write fails', () => {
  const tab = chromeTab(1, 'paired-write-retry')
  let storedActivity = emptyWorkingSetActivity()
  let writeAttempts = 0
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeAttempts += 1
          if (writeAttempts === 1) throw new Error('activity write failed')
          storedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    const failure = yield* Effect.result(service.recordTabActivation(1, 1))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.match(String(failure.failure.cause), /activity write failed/)
    yield* service.recordFocusedWindowActiveTab(1)

    const record = (yield* service.getWorkingSetActivity()).records['https://example.test/paired-write-retry']
    assert.equal(writeAttempts, 2)
    assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 1)
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set still records repeated activation signals from the same event source', () => {
  const tab = chromeTab(1, 'repeated')
  let storedActivity = emptyWorkingSetActivity()
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    yield* service.recordTabActivation(1, 1)
    yield* service.recordTabActivation(1, 1)

    const record = (yield* service.getWorkingSetActivity()).records['https://example.test/repeated']
    assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 2)
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set rebases its activation signal when Chrome replaces a tab id', () => {
  const removedTab = chromeTab(1, 'replacement')
  let tabs = [removedTab]
  let storedActivity = emptyWorkingSetActivity()
  let writeCount = 0
  const { promise: activationLookupStarted, resolve: markActivationLookupStarted } = Promise.withResolvers<void>()
  const { promise: activationLookup, resolve: releaseActivationLookup } = Promise.withResolvers<chrome.tabs.Tab[]>()
  let firstLookup = true
  const chromeApi = {
    tabs: {
      query: async () => {
        if (firstLookup) {
          firstLookup = false
          markActivationLookupStarted()
          return activationLookup
        }
        return tabs
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeCount += 1
          storedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    const activation = yield* service.recordTabActivation(1, 1).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.promise(() => activationLookupStarted)
    tabs = [{ ...chromeTab(4, 'replacement'), active: true, index: 0 }]
    const replacement = yield* service.replaceTabId(4, 1).pipe(Effect.forkChild({ startImmediately: true }))
    releaseActivationLookup([removedTab])
    yield* Fiber.join(activation)
    yield* Fiber.join(replacement)
    yield* service.recordFocusedWindowActiveTab(1)
    const [replacementTab] = tabs
    assert.ok(replacementTab)
    assert.ok(replacementTab.url)
    yield* service.recordTabNavigation(4, { url: replacementTab.url }, replacementTab)

    const record = (yield* service.getWorkingSetActivity()).records['https://example.test/replacement']
    assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 1)
    assert.equal(writeCount, 1, 'tab-id rebasing, paired focus, and same-page refresh are in-memory only')
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set mutation retries persisted activity after a transient initial storage read failure', () => {
  const existingTab = chromeTab(1, 'existing')
  const activatedTab = chromeTab(2, 'activated')
  const readFailure = new Error('activity read failed')
  let persistedActivity = recordWorkingSetActivity(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: Date.now() - 1000,
    tab: { url: existingTab.url || '', rawUrl: existingTab.url || '', title: existingTab.title || '' },
  })
  let readAttempts = 0
  let writeAttempts = 0
  const chromeApi = {
    tabs: { query: async () => [existingTab, activatedTab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => {
          readAttempts += 1
          if (readAttempts === 1) throw readFailure
          return { [WORKING_SET_ACTIVITY_TEST_KEY]: persistedActivity }
        },
        set: async (value: Record<string, unknown>) => {
          writeAttempts += 1
          persistedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    const failure = yield* Effect.result(service.recordTabActivation(1, 2))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.equal(failure.failure.cause, readFailure)
    assert.equal(writeAttempts, 0)
    assert.ok(persistedActivity.records['https://example.test/existing'])
    assert.equal(persistedActivity.records['https://example.test/activated'], undefined)

    yield* service.recordTabActivation(1, 2)
    assert.equal(writeAttempts, 1)
    assert.ok(persistedActivity.records['https://example.test/existing'])
    assert.ok(persistedActivity.records['https://example.test/activated'])
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set mutation does not advance its cache until the storage write succeeds', () => {
  const existingTab = chromeTab(1, 'existing-write')
  const activatedTab = chromeTab(2, 'activated-write')
  let persistedActivity = recordWorkingSetActivity(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: Date.now() - 1000,
    tab: { url: existingTab.url || '', rawUrl: existingTab.url || '', title: existingTab.title || '' },
  })
  let writeAttempts = 0
  const chromeApi = {
    tabs: { query: async () => [existingTab, activatedTab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_TEST_KEY]: persistedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeAttempts += 1
          if (writeAttempts === 1) throw new Error('activity write failed')
          persistedActivity = value[WORKING_SET_ACTIVITY_TEST_KEY] as WorkingSetActivityStore
        },
      },
    },
  } as unknown as ChromeApi
  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet

    const failure = yield* Effect.result(service.recordTabActivation(1, 2))
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) assert.match(String(failure.failure.cause), /activity write failed/)
    assert.equal(persistedActivity.records['https://example.test/activated-write'], undefined)

    yield* service.recordTabActivation(1, 2)
    assert.equal(writeAttempts, 2)
    assert.ok(persistedActivity.records['https://example.test/existing-write'])
    assert.ok(persistedActivity.records['https://example.test/activated-write'])
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})

it.effect('Working Set treats an absent first-run storage key as known empty state', () => {
  const chromeApi = {
    tabs: { query: async () => [] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
    },
    storage: {
      local: { get: async () => ({}) },
    },
  } as unknown as ChromeApi

  return Effect.gen(function* () {
    const service = yield* WorkingSet.WorkingSet
    const activity = yield* service.getWorkingSetActivity()
    assert.deepEqual(activity.records, {})
  }).pipe(Effect.provide(workingSetLayer(chromeApi)))
})
