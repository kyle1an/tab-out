import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'

import { createStartupSnapshotService, startupSnapshotStorageChangesRequireRefresh } from '../src/extension/background/startup-snapshot-service.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import { PAGE_CHIP_PIN_STORAGE_KEY, pageChipPinId, pageChipPinKeyForUrl, pageChipPinScopeId } from '../src/extension/page-chip-pins.js'
import { SECTION_PIN_STORAGE_KEY, subdomainPinId } from '../src/extension/section-pins.js'
import { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY } from '../src/extension/startup-snapshot.js'

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

test('startup snapshot refreshes only for local state that changes its rendered shape', () => {
  const change = { newValue: [] } as chrome.storage.StorageChange

  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [SECTION_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [PAGE_CHIP_PIN_STORAGE_KEY]: change }, 'local'), true)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ 'tab-out:local-path-groupers-active': change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: change }, 'local'), false)
  assert.equal(startupSnapshotStorageChangesRequireRefresh({ [DOMAIN_PIN_STORAGE_KEY]: change }, 'session'), false)
})

test('startup snapshot service writes render-ready session + durable caches from worker-side inputs', async () => {
  const writes: Record<string, any> = {}
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
  assert.deepEqual(writes.session.localState, expectedLocalState)
  assert.deepEqual(writes.local.localState, expectedLocalState)
  assert.deepEqual(writes.session.snapshot.startupViewModel.pinnedSectionIds, [pinnedSectionId])
  assert.deepEqual(writes.session.snapshot.startupViewModel.pinnedPageChipIds, [pinnedPageChipId])
  assert.equal(writes.session.snapshot.startupViewModel.viewModel.source, 'tabs')
  assert.equal(writes.session.snapshot.startupViewModel.viewModel.matchedCards.length, 2)
})

test('startup snapshot service coalesces pending debounced refreshes', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousChrome = (globalThis as { chrome?: unknown }).chrome
  let snapshotBuilds = 0
  installEmptyWorkerChrome()

  try {
    const service = createStartupSnapshotService({
      getTabHistorySnapshot: async () => {
        snapshotBuilds += 1
        return emptyTabHistory as any
      },
      getWorkingSetActivity: async () => emptyActivity as any
    })

    service.scheduleRefresh()
    service.scheduleRefresh()
    assert.equal(clock.countTimers(), 1)

    await clock.tickAsync(4000)
    assert.equal(clock.countTimers(), 0)
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
      getTabHistorySnapshot: async () => {
        snapshotBuilds += 1
        return emptyTabHistory as any
      },
      getWorkingSetActivity: async () => emptyActivity as any
    })

    await service.refreshNow()
    await service.refreshNow()

    assert.equal(snapshotBuilds, 2)
  } finally {
    if (previousChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = previousChrome
  }
})
