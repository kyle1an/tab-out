import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Effect, Layer, ManagedRuntime } from 'effect'
import * as TabHistoryService from '../src/extension/background/tab-history-service.js'
import {
  readChromeStorageValue,
  writeChromeStorageValue,
} from '../src/extension/background/chrome-storage.js'
import { WorkingSetActivityStorage } from '../src/extension/background/working-set-activity-storage.js'
import {
  effectiveUrlForHistoryIdentity,
  historyChanged,
  historyForBackgroundTabCreation,
} from '../src/extension/background/tab-history-state.js'
import { normalizeTabHistorySnapshot } from '../src/extension/tab-history.js'
import { emptyWorkingSetActivity, recordWorkingSetActivity } from '../src/extension/working-set.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStore } from '../src/extension/types'

const WORKING_SET_ACTIVITY_KEY = 'working-set-activity-test'
const disposeTabHistoryRuntimes: Array<() => Promise<void>> = []

test.after(async () => {
  for (const dispose of disposeTabHistoryRuntimes) await dispose()
})

function createTabHistoryService(chromeApi: ChromeApi) {
  const storage = chromeApi.storage?.local
  const unavailable = (): Promise<never> => Promise.reject(
    new Error('Chrome local storage is unavailable for Working Set activity'),
  )
  const activityStorage = WorkingSetActivityStorage.layer({
    read: () => storage
      ? readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
      : unavailable(),
    write: (change) => storage
      ? writeChromeStorageValue(
          storage,
          WORKING_SET_ACTIVITY_KEY,
          change.activity,
        )
      : unavailable(),
    replace: (activity) => storage
      ? writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, activity)
      : unavailable(),
  })
  const runtime = ManagedRuntime.make(
    TabHistoryService.TabHistory.layer(chromeApi).pipe(
      Layer.provide(activityStorage),
    ),
  )
  runtime.runSync(Effect.void)
  const service = runtime.runSync(TabHistoryService.TabHistory)
  disposeTabHistoryRuntimes.push(() => runtime.dispose())
  const run = <Value>(
    effect: Effect.Effect<Value, TabHistoryService.TabHistoryTaskError>,
  ) => runtime.runPromise(effect.pipe(
    Effect.catchTag('TabHistoryTaskError', (error) => Effect.fail(error.cause)),
  ))
  return {
    getTabHistorySnapshot: (activity?: WorkingSetActivityStore | null) =>
      run(service.getTabHistorySnapshot(activity)),
    getTabHistorySnapshotCapture: (activity?: WorkingSetActivityStore | null) =>
      run(service.getTabHistorySnapshotCapture(activity)),
    recordFocusedWindowActiveTab: (
      windowId: number,
      capturedActiveTab?: Promise<chrome.tabs.Tab | null>,
    ) => run(service.recordFocusedWindowActiveTab(windowId, capturedActiveTab)),
    recordTabCreation: (tab: chrome.tabs.Tab) => run(service.recordTabCreation(tab)),
    recordTabNavigation: (
      tabId: number,
      changeInfo: { url?: string },
      tab: chrome.tabs.Tab,
    ) => run(service.recordTabNavigation(tabId, changeInfo, tab)),
    recordTabActivation: (
      windowId: number,
      tabId: number,
      capturedTab?: Promise<chrome.tabs.Tab | null>,
    ) => run(service.recordTabActivation(windowId, tabId, capturedTab)),
    removeTabFromHistory: (tabId: number) => run(service.removeTabFromHistory(tabId)),
    replaceTabId: (addedTabId: number, removedTabId: number) =>
      run(service.replaceTabId(addedTabId, removedTabId)),
    resetForBrowserStartup: () => run(service.resetForBrowserStartup()),
    restorePreviousTabAfterClose: (tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) =>
      run(service.restorePreviousTabAfterClose(tabId, removeInfo)),
    switchTabHistory: (direction: number) => run(service.switchTabHistory(direction)),
  }
}

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

function makeChromeApi(state: {
  history?: {
    stack: { windowId: number, tabId: number, url?: string }[]
    index: number
    pending?: { windowId: number, tabId: number, url?: string, createdAt: number }[]
  }
  tabs?: chrome.tabs.Tab[]
  activity?: WorkingSetActivityStore
}): ChromeApi {
  const tabs = state.tabs || []
  const rawHistory = state.history || { stack: [], index: -1 }
  const withIdentity = <Entry extends { tabId: number, url?: string }>(entry: Entry) => ({
    ...entry,
    url: entry.url ?? effectiveUrlForHistoryIdentity(tabs.find((tab) => tab.id === entry.tabId)),
  })
  const history = {
    version: 2,
    stack: rawHistory.stack.map(withIdentity),
    index: rawHistory.index,
    pending: (rawHistory.pending || []).map(withIdentity),
  }
  const activity = state.activity || emptyWorkingSetActivity()
  const storage = new Map<string, unknown>([
    ['globalTabHistory', history],
    [WORKING_SET_ACTIVITY_KEY, activity],
  ])
  return {
    tabs: {
      get: async (tabId: number) => {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error(`Missing tab ${tabId}`)
        return tab
      },
      query: async (q: chrome.tabs.QueryInfo) => {
        if ('windowId' in q && typeof q.windowId === 'number') {
          return tabs.filter((t) => t.windowId === q.windowId && (q.active === undefined || !!t.active === !!q.active))
        }
        return tabs
      },
      update: async () => undefined,
      remove: async () => undefined,
    } as unknown as ChromeApi['tabs'],
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window],
    } as unknown as ChromeApi['windows'],
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (entries: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(entries)) storage.set(k, v)
        },
      },
    } as unknown as ChromeApi['storage'],
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
    tab: { url: 'https://example.com/a', rawUrl: 'https://example.com/a', title: 'A' },
  })

  const service = createTabHistoryService(makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 10 }], index: 0 },
    tabs: [{ id: 10, windowId: 1, url: 'https://example.com/a', title: 'A', active: true } as chrome.tabs.Tab],
    activity,
  }))

  const snapshot = await service.getTabHistorySnapshot()
  assert.equal(snapshot.entries.length, 1)
  assert.equal(valueAt(snapshot.entries, 0).lastActivatedAt, now - 1000)
})

test('getTabHistorySnapshot sets lastActivatedAt to null when the URL has no activity record', async () => {
  const service = createTabHistoryService(makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 10 }], index: 0 },
    tabs: [{ id: 10, windowId: 1, url: 'https://example.com/a', title: 'A', active: true } as chrome.tabs.Tab],
  }))

  const snapshot = await service.getTabHistorySnapshot()
  assert.equal(valueAt(snapshot.entries, 0).lastActivatedAt, null)
})

test('getTabHistorySnapshot marks only live awake loading tabs as loading', async () => {
  const suspendedRawUrl = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/suspended.html#ttl=Example&uri=https%3A%2F%2Fexample.test%2Fsuspended'
  const service = createTabHistoryService(makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10 },
        { windowId: 1, tabId: 11 },
        { windowId: 1, tabId: 12 },
      ],
      index: 0,
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://example.test/loading', title: 'Loading', status: 'loading', active: true } as chrome.tabs.Tab,
      { id: 11, windowId: 1, url: 'https://example.test/complete', title: 'Complete', status: 'complete' } as chrome.tabs.Tab,
      { id: 12, windowId: 1, url: suspendedRawUrl, title: 'Suspended', status: 'loading' } as chrome.tabs.Tab,
    ],
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
    tab: { url: 'https://example.test/b', rawUrl: 'https://example.test/b', title: 'B' },
  })

  const service = createTabHistoryService(makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs: [{ id: 11, windowId: 1, url: 'https://example.test/b', title: 'B', active: true } as chrome.tabs.Tab],
  }))

  const snapshot = await service.getTabHistorySnapshot(activity)
  assert.equal(valueAt(snapshot.entries, 0).lastActivatedAt, now - 500)
})

test('history capture reads all tabs and windows once and returns the exact browser generation it rendered', async () => {
  const tabs = [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab]
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs,
  })
  let allTabsReads = 0
  let allWindowsReads = 0
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (Object.keys(queryInfo).length === 0) allTabsReads += 1
    return tabs
  }
  chromeApi.windows.getAll = async () => {
    allWindowsReads += 1
    return [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window]
  }

  const capture = await createTabHistoryService(chromeApi).getTabHistorySnapshotCapture(emptyWorkingSetActivity())

  assert.equal(allTabsReads, 1)
  assert.equal(allWindowsReads, 1)
  assert.equal(capture.openTabsSnapshot?.tabs, tabs)
  assert.equal(capture.tabHistory.activeTabId, 11)
})

test('history capture starts required browser reads together before either settles', async () => {
  const tabs = [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab]
  const windows = [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window]
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs,
  })
  const started: string[] = []
  const { promise: tabsRead, resolve: resolveTabs } = Promise.withResolvers<chrome.tabs.Tab[]>()
  const { promise: windowsRead, resolve: resolveWindows } = Promise.withResolvers<chrome.windows.Window[]>()
  chromeApi.tabs.query = async () => {
    started.push('tabs')
    return tabsRead
  }
  chromeApi.windows.getAll = async () => {
    started.push('windows')
    return windowsRead
  }

  const capturePromise = createTabHistoryService(chromeApi).getTabHistorySnapshotCapture(emptyWorkingSetActivity())
  await setImmediate()

  try {
    assert.deepEqual(started, ['tabs', 'windows'])
  } finally {
    resolveTabs(tabs)
    resolveWindows(windows)
  }

  const capture = await capturePromise
  assert.equal(capture.openTabsSnapshot.tabs, tabs)
  assert.equal(capture.openTabsSnapshot.windows, windows)
})

test('history snapshot rejects unknown window state instead of returning a partial generation', async () => {
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs: [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab],
  })
  chromeApi.windows.getAll = async () => { throw new Error('windows unavailable') }

  await assert.rejects(
    createTabHistoryService(chromeApi).getTabHistorySnapshot(emptyWorkingSetActivity()),
    /windows unavailable/,
  )
})

test('history snapshot rejects a focused window missing from the captured tabs generation', async () => {
  const chromeApi = makeChromeApi({
    history: { stack: [{ windowId: 1, tabId: 11 }], index: 0 },
    tabs: [{ id: 11, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab],
  })
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
    { id: 2, focused: true, type: 'normal' } as chrome.windows.Window,
  ]

  await assert.rejects(
    createTabHistoryService(chromeApi).getTabHistorySnapshot(emptyWorkingSetActivity()),
    /focus state is unavailable/,
  )
})

test('history mutation retries persisted state after a transient initial storage read failure', async () => {
  const tabs = [
    { id: 1, windowId: 1, url: 'https://example.test/one', title: 'One', active: false } as chrome.tabs.Tab,
    { id: 2, windowId: 1, url: 'https://example.test/two', title: 'Two', active: true } as chrome.tabs.Tab,
  ]
  let persisted: any = {
    version: 2,
    stack: [{ windowId: 1, tabId: 1, url: 'https://example.test/one' }],
    index: 0,
    pending: [],
  }
  let readAttempts = 0
  let writeAttempts = 0
  const readFailure = new Error('storage temporarily unavailable')
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = (async (key: string) => {
    readAttempts += 1
    if (readAttempts === 1) throw readFailure
    return { [key]: persisted }
  }) as typeof chromeApi.storage.local.get
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writeAttempts += 1
    persisted = entries.globalTabHistory
  }
  const service = createTabHistoryService(chromeApi)

  await assert.rejects(service.recordTabActivation(1, 2), (error) => error === readFailure)
  assert.equal(writeAttempts, 0)
  assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1])

  await service.recordTabActivation(1, 2)
  assert.equal(writeAttempts, 1)
  assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1, 2])
})

test('history mutation does not advance its cache until the storage write succeeds', async () => {
  const tabs = [
    { id: 1, windowId: 1, url: 'https://example.test/one', title: 'One', active: false } as chrome.tabs.Tab,
    { id: 2, windowId: 1, url: 'https://example.test/two', title: 'Two', active: true } as chrome.tabs.Tab,
  ]
  let persisted: any = {
    version: 2,
    stack: [{ windowId: 1, tabId: 1, url: 'https://example.test/one' }],
    index: 0,
    pending: [],
  }
  let writeAttempts = 0
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = (async (key: string) => ({ [key]: persisted })) as typeof chromeApi.storage.local.get
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writeAttempts += 1
    if (writeAttempts === 1) throw new Error('storage write failed')
    persisted = entries.globalTabHistory
  }
  const service = createTabHistoryService(chromeApi)

  await assert.rejects(service.recordTabActivation(1, 2), /storage write failed/)
  assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1])

  await service.recordTabActivation(1, 2)
  assert.equal(writeAttempts, 2)
  assert.deepEqual(persisted.stack.map((entry: any) => entry.tabId), [1, 2])
})

test('history treats an absent first-run storage key as known empty state', async () => {
  const tab = { id: 1, windowId: 1, url: 'https://example.test/first', title: 'First', active: true } as chrome.tabs.Tab
  const chromeApi = makeChromeApi({ tabs: [tab] })
  chromeApi.storage.local.get = async () => ({})

  const snapshot = await createTabHistoryService(chromeApi).getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.equal(snapshot.activeTabId, 1)
  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [1])
})

test('legacy ID-only persisted history resets once into the identity-bearing schema', async () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://reused.example.test/', title: 'Reused', active: false } as chrome.tabs.Tab,
  ]
  let persisted: unknown = {
    stack: [
      { windowId: 1, tabId: 10 },
      { windowId: 1, tabId: 20 },
    ],
    index: 1,
    pending: [{ windowId: 1, tabId: 30, createdAt: 123 }],
  }
  let writes = 0
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writes += 1
    persisted = entries.globalTabHistory
  }

  const firstSnapshot = await createTabHistoryService(chromeApi).getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(firstSnapshot.entries.map((entry) => entry.tabId), [10])
  assert.deepEqual(persisted, {
    version: 2,
    stack: [{ windowId: 1, tabId: 10, url: 'https://current.example.test/' }],
    index: 0,
    pending: [],
  })
  assert.equal(writes, 2)

  const secondSnapshot = await createTabHistoryService(chromeApi).getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(secondSnapshot.entries.map((entry) => entry.tabId), [10])
  assert.equal(writes, 2)
})

test('malformed versioned history resets instead of retaining a partial store', async () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://previous.example.test/', title: 'Previous', active: false } as chrome.tabs.Tab,
  ]
  let persisted: unknown = {
    version: 2,
    stack: [{ windowId: 1, tabId: 20, url: 'https://previous.example.test/' }],
    index: 0,
    pending: [{ windowId: 1, tabId: 30, url: 'https://pending.example.test/', createdAt: Number.POSITIVE_INFINITY }],
  }
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    persisted = entries.globalTabHistory
  }

  const snapshot = await createTabHistoryService(chromeApi).getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
  assert.deepEqual(persisted, {
    version: 2,
    stack: [{ windowId: 1, tabId: 10, url: 'https://current.example.test/' }],
    index: 0,
    pending: [],
  })
})

test('missed browser startup prunes reused tab IDs whose effective URLs changed', async () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10, url: 'https://previous-session.example.test/current' },
        { windowId: 1, tabId: 20, url: 'https://previous-session.example.test/next' },
      ],
      index: 1,
      pending: [
        { windowId: 1, tabId: 30, url: 'https://previous-session.example.test/pending', createdAt: 123 },
      ],
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://new-session.example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://new-session.example.test/unrelated', title: 'Unrelated', active: false } as chrome.tabs.Tab,
      { id: 30, windowId: 1, url: 'https://new-session.example.test/other', title: 'Other', active: false } as chrome.tabs.Tab,
    ],
  })
  const service = createTabHistoryService(chromeApi)

  const snapshot = await service.getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
  assert.equal(snapshot.previousIndex, -1)
  assert.equal(snapshot.nextIndex, -1)
  assert.equal(snapshot.pendingSize, 0)
})

test('history switch prunes a reused target before cursor repair can focus it', async () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10, url: 'https://previous-session.example.test/target' },
        { windowId: 1, tabId: 20, url: 'https://example.test/current' },
      ],
      index: 1,
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://new-session.example.test/unrelated', title: 'Unrelated', active: false } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
    ],
  })
  const service = createTabHistoryService(chromeApi)

  await service.switchTabHistory(-1)
  const snapshot = await service.getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [20])
  assert.equal(snapshot.previousIndex, -1)
})

test('history switch does not mutate an opener before fresh target validation', async () => {
  const capturedTabs = [
    { id: 10, windowId: 1, url: 'https://example.test/target', title: 'Target', active: false } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
  ]
  const liveTabs = capturedTabs.map((tab) => ({ ...tab }))
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10, url: 'https://example.test/target' },
        { windowId: 1, tabId: 20, url: 'https://example.test/current' },
      ],
      index: 1,
    },
    tabs: capturedTabs,
  })
  let fullTabReads = 0
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (Object.keys(queryInfo).length === 0) {
      fullTabReads += 1
      return (fullTabReads === 1 ? capturedTabs : liveTabs).map((tab) => ({ ...tab }))
    }
    return liveTabs.filter((tab) => (
      (typeof queryInfo.windowId !== 'number' || tab.windowId === queryInfo.windowId) &&
      (queryInfo.active === undefined || tab.active === queryInfo.active)
    ))
  }
  chromeApi.windows.getAll = async () => {
    const firstLiveTab = valueAt(liveTabs, 0)
    liveTabs[0] = {
      ...firstLiveTab,
      url: 'https://example.test/unrelated',
      title: 'Unrelated',
    }
    return [{ id: 1, focused: true, type: 'normal' } as chrome.windows.Window]
  }
  const openerUpdates: Array<{ tabId: number, openerTabId?: number }> = []
  chromeApi.tabs.update = (async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    openerUpdates.push(updateProperties.openerTabId === undefined
      ? { tabId }
      : { tabId, openerTabId: updateProperties.openerTabId })
    return liveTabs.find((tab) => tab.id === tabId)
  }) as typeof chromeApi.tabs.update
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  globalThis.chrome = chromeApi as unknown as typeof globalThis.chrome

  try {
    await assert.rejects(
      createTabHistoryService(chromeApi).switchTabHistory(-1),
      /Could not activate tab history target/,
    )
    assert.deepEqual(openerUpdates, [])
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('history switch fails closed when the last-focused active-tab read is unknown', async () => {
  const tabs = [
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
  ]
  const chromeApi = makeChromeApi({ tabs })
  const queryTabs = chromeApi.tabs.query.bind(chromeApi.tabs)
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (queryInfo.active && queryInfo.lastFocusedWindow) {
      throw new Error('Last-focused tab unavailable')
    }
    return queryTabs(queryInfo)
  }
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
  ]
  let updateCalls = 0
  chromeApi.tabs.update = async () => {
    updateCalls += 1
    return tabs[0]
  }
  chromeApi.windows.update = async () => ({
    id: 1,
    focused: true,
    type: 'normal',
  } as chrome.windows.Window)
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  globalThis.chrome = chromeApi as unknown as typeof globalThis.chrome

  try {
    await assert.rejects(
      createTabHistoryService(chromeApi).switchTabHistory(-1),
      /focus state is unavailable/,
    )
    assert.equal(updateCalls, 0)
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})

test('versioned activation and pending history survive an extension reload when identities still match', async () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://example.test/first', title: 'First', active: false } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
    {
      id: 30,
      windowId: 1,
      url: 'https://example.test/pending',
      title: 'Pending',
      active: false,
      openerTabId: 20,
    } as chrome.tabs.Tab,
  ]
  let persisted: unknown = { version: 2, stack: [], index: -1, pending: [] }
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    persisted = entries.globalTabHistory
  }

  const initialService = createTabHistoryService(chromeApi)
  await initialService.recordTabActivation(1, 10)
  await initialService.recordTabActivation(1, 20)
  await initialService.recordTabCreation(valueAt(tabs, 2))

  const reloadedSnapshot = await createTabHistoryService(chromeApi).getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(
    reloadedSnapshot.entries.map((entry) => ({ tabId: entry.tabId, pending: entry.pending })),
    [
      { tabId: 10, pending: false },
      { tabId: 20, pending: false },
      { tabId: 30, pending: true },
    ],
  )
  assert.deepEqual(
    (persisted as { stack: Array<{ url: string }>, pending: Array<{ url: string }> }).stack.map((entry) => entry.url),
    ['https://example.test/first', 'https://example.test/current'],
  )
  assert.deepEqual(
    (persisted as { pending: Array<{ url: string }> }).pending.map((entry) => entry.url),
    ['https://example.test/pending'],
  )
})

test('a trusted pending tab keeps its FIFO entry when its effective URL redirects', async () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
    {
      id: 30,
      windowId: 1,
      url: 'about:blank',
      title: '',
      active: false,
      openerTabId: 10,
    } as chrome.tabs.Tab,
  ]
  const service = createTabHistoryService(makeChromeApi({
    history: {
      stack: [{ windowId: 1, tabId: 10 }],
      index: 0,
    },
    tabs,
  }))

  const pendingTab = valueAt(tabs, 1)
  await service.recordTabCreation(pendingTab)
  pendingTab.url = 'https://example.test/final'
  await service.recordTabNavigation(30, { url: pendingTab.url }, pendingTab)
  const snapshot = await service.getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(
    snapshot.entries.map((entry) => ({ tabId: entry.tabId, url: entry.url, pending: entry.pending })),
    [
      { tabId: 10, url: 'https://example.test/current', pending: false },
      { tabId: 30, url: 'https://example.test/final', pending: true },
    ],
  )
})

test('a trusted inactive activation-history tab keeps its position when it navigates', async () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://example.test/first', title: 'First', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 1, url: 'https://example.test/current', title: 'Current', active: false } as chrome.tabs.Tab,
  ]
  const service = createTabHistoryService(makeChromeApi({ tabs }))
  const firstTab = valueAt(tabs, 0)
  const secondTab = valueAt(tabs, 1)

  await service.recordTabActivation(1, 10)
  firstTab.active = false
  secondTab.active = true
  await service.recordTabActivation(1, 20)
  firstTab.url = 'https://example.test/first-after-navigation'
  await service.recordTabNavigation(10, { url: firstTab.url }, firstTab)
  const snapshot = await service.getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(
    snapshot.entries.map((entry) => ({ tabId: entry.tabId, url: entry.url })),
    [
      { tabId: 10, url: 'https://example.test/first-after-navigation' },
      { tabId: 20, url: 'https://example.test/current' },
    ],
  )
  assert.equal(snapshot.currentIndex, 1)
})

test('an untrusted navigation cannot rebase a reused id from a previous browser session', async () => {
  const reusedTab = {
    id: 30,
    windowId: 1,
    url: 'https://new-session.example.test/unrelated',
    title: 'Unrelated',
    active: false,
  } as chrome.tabs.Tab
  const service = createTabHistoryService(makeChromeApi({
    history: {
      stack: [{ windowId: 1, tabId: 10, url: 'https://example.test/current' }],
      index: 0,
      pending: [{
        windowId: 1,
        tabId: 30,
        url: 'https://previous-session.example.test/pending',
        createdAt: 123,
      }],
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
      reusedTab,
    ],
  }))

  assert.ok(reusedTab.url)
  await service.recordTabNavigation(30, { url: reusedTab.url }, reusedTab)
  const snapshot = await service.getTabHistorySnapshot(emptyWorkingSetActivity())

  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
  assert.equal(snapshot.pendingSize, 0)
})

test('history comparison treats effective URL identity changes as mutations', () => {
  const first = {
    stack: [{ windowId: 1, tabId: 10, url: 'https://example.test/first' }],
    index: 0,
    pending: [{ windowId: 1, tabId: 20, url: 'https://example.test/pending', createdAt: 1 }],
  }

  assert.equal(historyChanged(first, first), false)
  assert.equal(historyChanged(first, {
    ...first,
    stack: [{ ...first.stack[0], url: 'https://example.test/reused' }],
  }), true)
  assert.equal(historyChanged(first, {
    ...first,
    pending: [{ ...first.pending[0], url: 'https://example.test/reused-pending' }],
  }), true)
})

test('background tab creation replaces a stale same-id history entry with the new pending lifetime', () => {
  const result = historyForBackgroundTabCreation({
    stack: [
      { windowId: 1, tabId: 10, url: 'https://example.test/current' },
      { windowId: 1, tabId: 30, url: 'https://previous-session.example.test/stale' },
    ],
    index: 1,
    pending: [],
  }, {
    windowId: 2,
    tabId: 30,
    url: 'https://example.test/new-pending',
    createdAt: 123,
  })

  assert.deepEqual(result.history, {
    stack: [{ windowId: 1, tabId: 10, url: 'https://example.test/current' }],
    index: 0,
    pending: [{
      windowId: 2,
      tabId: 30,
      url: 'https://example.test/new-pending',
      createdAt: 123,
    }],
  })
  assert.equal(result.changed, true)
})

test('activated history reserves the bounded index budget before pending tabs', async () => {
  const stack = Array.from({ length: 47 }, (_, index) => ({
    windowId: 1,
    tabId: index + 1,
  }))
  const pending = Array.from({ length: 3 }, (_, index) => ({
    windowId: 1,
    tabId: index + 48,
    createdAt: index + 1,
  }))
  const tabs = Array.from({ length: 50 }, (_, index) => ({
    id: index + 1,
    windowId: 1,
    url: `https://tab-${index + 1}.example/`,
    title: `Tab ${index + 1}`,
    active: index === 46,
  } as chrome.tabs.Tab))
  const service = createTabHistoryService(makeChromeApi({
    history: { stack, index: 46, pending },
    tabs,
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
        lastActivatedAt: 1_700_000_000,
      },
    ],
  })
  assert.equal(valueAt(result.entries, 0).lastActivatedAt, 1_700_000_000)
})

test('normalizeTabHistorySnapshot defaults missing lastActivatedAt to null', () => {
  const result = normalizeTabHistorySnapshot({
    entries: [{ tabId: 10, windowId: 1 } as unknown as never],
  })
  assert.equal(valueAt(result.entries, 0).lastActivatedAt, null)
})

test('focused-window history preserves event order when captured active-tab lookups resolve out of order', async () => {
  const tabs = [
    { id: 10, windowId: 1, url: 'https://one.example.test/', title: 'One', active: true } as chrome.tabs.Tab,
    { id: 20, windowId: 2, url: 'https://two.example.test/', title: 'Two', active: true } as chrome.tabs.Tab,
  ]
  const { promise: windowOneLookup, resolve: resolveWindowOne } = Promise.withResolvers<chrome.tabs.Tab[]>()
  const { promise: windowTwoLookup, resolve: resolveWindowTwo } = Promise.withResolvers<chrome.tabs.Tab[]>()
  const chromeApi = makeChromeApi({ tabs })
  chromeApi.tabs.query = async (queryInfo: chrome.tabs.QueryInfo) => {
    if (typeof queryInfo.windowId === 'number') {
      throw new Error('captured focus events must not repeat the active-tab lookup')
    }
    return tabs
  }
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
    { id: 2, focused: true, type: 'normal' } as chrome.windows.Window,
  ]
  const service = createTabHistoryService(chromeApi)

  const firstFocus = service.recordFocusedWindowActiveTab(
    1,
    windowOneLookup.then((resolvedTabs) => resolvedTabs[0] ?? null),
  )
  const secondFocus = service.recordFocusedWindowActiveTab(
    2,
    windowTwoLookup.then((resolvedTabs) => resolvedTabs[0] ?? null),
  )
  resolveWindowTwo([valueAt(tabs, 1)])
  await setImmediate()
  resolveWindowOne([valueAt(tabs, 0)])
  await Promise.all([firstFocus, secondFocus])

  const snapshot = await service.getTabHistorySnapshot()
  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10, 20])
  assert.equal(snapshot.currentIndex, 1)
  assert.equal(snapshot.previousIndex, 0)
})

test('browser startup resets ID-only history before Chrome can reuse old tab ids', async () => {
  const service = createTabHistoryService(makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10 },
        { windowId: 1, tabId: 20 },
      ],
      index: 0,
    },
    tabs: [
      { id: 10, windowId: 1, url: 'https://new-session.example.test/current', title: 'Current', active: true } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://new-session.example.test/unrelated', title: 'Unrelated', active: false } as chrome.tabs.Tab,
    ],
  }))

  await service.resetForBrowserStartup()
  const snapshot = await service.getTabHistorySnapshot()

  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [10])
  assert.equal(snapshot.previousIndex, -1)
  assert.equal(snapshot.nextIndex, -1)
})

test('browser startup reset clears stale IDs before activation without depending on a storage read', async () => {
  let readAttempts = 0
  let persisted: unknown = {
    stack: [{ windowId: 1, tabId: 10 }],
    index: 0,
    pending: [],
  }
  const chromeApi = makeChromeApi({
    tabs: [
      { id: 20, windowId: 1, url: 'https://new-session.example.test/active', title: 'Active', active: true } as chrome.tabs.Tab,
    ],
  })
  chromeApi.storage.local.get = async () => {
    readAttempts += 1
    throw new Error('history read unavailable')
  }
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    persisted = entries.globalTabHistory
  }
  const service = createTabHistoryService(chromeApi)

  await service.resetForBrowserStartup()
  await service.recordTabActivation(1, 20)

  assert.equal(readAttempts, 0)
  assert.deepEqual(persisted, {
    version: 2,
    stack: [{ windowId: 1, tabId: 20, url: 'https://new-session.example.test/active' }],
    index: 0,
    pending: [],
  })
})

test('failed browser startup reset remains a barrier before the next activation', async () => {
  let persisted: unknown = {
    stack: [{ windowId: 1, tabId: 10 }],
    index: 0,
    pending: [],
  }
  let writeAttempts = 0
  const chromeApi = makeChromeApi({
    tabs: [
      { id: 20, windowId: 1, url: 'https://new-session.example.test/active', title: 'Active', active: true } as chrome.tabs.Tab,
    ],
  })
  chromeApi.storage.local.get = async () => ({ globalTabHistory: persisted })
  chromeApi.storage.local.set = async (entries: Record<string, unknown>) => {
    writeAttempts += 1
    if (writeAttempts === 1) throw new Error('history reset write unavailable')
    persisted = entries.globalTabHistory
  }
  const service = createTabHistoryService(chromeApi)

  await assert.rejects(service.resetForBrowserStartup(), /history reset write unavailable/)
  await service.recordTabActivation(1, 20)

  assert.equal(writeAttempts, 3)
  assert.deepEqual(persisted, {
    version: 2,
    stack: [{ windowId: 1, tabId: 20, url: 'https://new-session.example.test/active' }],
    index: 0,
    pending: [],
  })
})

test('tab replacement preserves activated history position under the new tab id', async () => {
  const chromeApi = makeChromeApi({
    history: {
      stack: [
        { windowId: 1, tabId: 10 },
        { windowId: 1, tabId: 20 },
      ],
      index: 0,
    },
    tabs: [
      { id: 30, windowId: 2, url: 'https://replacement.example.test/', title: 'Replacement', active: true } as chrome.tabs.Tab,
      { id: 20, windowId: 1, url: 'https://other.example.test/', title: 'Other', active: false } as chrome.tabs.Tab,
    ],
  })
  chromeApi.windows.getAll = async () => [
    { id: 1, focused: false, type: 'normal' } as chrome.windows.Window,
    { id: 2, focused: true, type: 'normal' } as chrome.windows.Window,
  ]
  const service = createTabHistoryService(chromeApi)

  await service.replaceTabId(30, 10)
  const snapshot = await service.getTabHistorySnapshot()

  assert.deepEqual(snapshot.entries.map((entry) => entry.tabId), [30, 20])
  assert.equal(valueAt(snapshot.entries, 0).windowId, 2)
  assert.equal(snapshot.currentIndex, 0)
  assert.equal(snapshot.entries.some((entry) => entry.tabId === 10), false)
})

test('tab replacement preserves a pending target under the new tab id', async () => {
  const service = createTabHistoryService(makeChromeApi({
    history: {
      stack: [{ windowId: 1, tabId: 20 }],
      index: 0,
      pending: [{ windowId: 1, tabId: 10, createdAt: 123 }],
    },
    tabs: [
      { id: 20, windowId: 1, url: 'https://current.example.test/', title: 'Current', active: true } as chrome.tabs.Tab,
      { id: 30, windowId: 1, url: 'https://pending.example.test/', title: 'Pending', active: false } as chrome.tabs.Tab,
    ],
  }))

  await service.replaceTabId(30, 10)
  const snapshot = await service.getTabHistorySnapshot()
  const pendingEntry = snapshot.entries.find((entry) => entry.pending)

  assert.equal(pendingEntry?.tabId, 30)
  assert.equal(pendingEntry?.createdAt, 123)
  assert.equal(snapshot.entries.some((entry) => entry.tabId === 10), false)
})
