import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { STARTUP_SNAPSHOT_DEBOUNCE_MS } from '../src/extension/background/startup-snapshot-service.js'
import { CLOSED_TAB_RESTORE_STATE_MESSAGE } from '../src/extension/closed-tabs.js'
import type { CapturedDashboardServiceState } from '../src/extension/dashboard-service-messages.js'
import {
  DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY,
  type DashboardStartupSnapshot
} from '../src/extension/startup-snapshot.js'
import { normalizeChromeOpenTabs } from '../src/extension/tabs.js'
import type { TabHistorySnapshot } from '../src/extension/types'
import { buildWorkingSetSnapshot } from '../src/extension/working-set.js'

const backgroundUrl = new URL('../src/extension/background.ts', import.meta.url)
const extensionUrl = 'chrome-extension://tab-out/index.html'
let backgroundImportId = 0
const backgroundClock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })

type BackgroundMockCalls = {
  alarmsCreate: Array<{ name: string; alarmInfo: chrome.alarms.AlarmCreateInfo }>
  badgeColor: chrome.action.BadgeColorDetails[]
  badgeText: chrome.action.BadgeTextDetails[]
  create: chrome.tabs.CreateProperties[]
  remove: number[]
  runtimeMessages: Array<{ extensionId: string; message: unknown }>
  tabGet: number[]
  tabQuery: chrome.tabs.QueryInfo[]
  update: Array<{
    tabId: number
    updateProperties: chrome.tabs.UpdateProperties
  }>
  windowCreate: chrome.windows.CreateData[]
  windowsGetAll: chrome.windows.QueryOptions[]
  windowUpdate: Array<{
    windowId: number
    updateInfo: chrome.windows.UpdateInfo
  }>
}

type DashboardServiceMessageResponse =
  | ({ ok: true } & CapturedDashboardServiceState)
  | {
      ok: false
      openTabsSnapshot: null
      tabHistory: null
      workingSetActivity: null
    }

type TabHistoryMessageResponse =
  | { ok: true; snapshot: TabHistorySnapshot }
  | { ok: false; snapshot: null }

type RuntimeMessageListener = (
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean

type BackgroundRuntimeMessageMock = {
  listeners: {
    runtimeOnMessage: RuntimeMessageListener[]
  }
}

type StartupCacheEnvelope = {
  snapshot: DashboardStartupSnapshot
}

test.after(() => backgroundClock.uninstall())
test.beforeEach(() => backgroundClock.reset())

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

function requireHistorySnapshot(response: TabHistoryMessageResponse): TabHistorySnapshot {
  assert.equal(response.ok, true, 'expected a successful tab-history response')
  return response.snapshot
}

function assertStartupCacheEnvelope(value: unknown): asserts value is StartupCacheEnvelope {
  assert.ok(value !== null && typeof value === 'object', 'expected a startup cache envelope')
  assert.ok('snapshot' in value, 'expected the startup cache to contain a snapshot')
  const { snapshot } = value
  assert.ok(snapshot !== null && typeof snapshot === 'object', 'expected a startup snapshot object')
  assert.ok('dashboard' in snapshot, 'expected cached dashboard state')
  assert.ok('tabHistory' in snapshot, 'expected cached tab-history state')
  assert.ok('workingSet' in snapshot, 'expected cached Working Set state')
  assert.ok('closedTabs' in snapshot, 'expected cached closed-tab state')
}

function requireStartupSnapshot(value: unknown): DashboardStartupSnapshot {
  assertStartupCacheEnvelope(value)
  return value.snapshot
}

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createEventSlot() {
  const listeners: any[] = []
  return {
    listeners,
    api: {
      addListener(fn: any) {
        listeners.push(fn)
      }
    }
  }
}

function createStorageArea(values: Record<string, any>) {
  return {
    async get(keys: string | string[] | Record<string, any> | null = null) {
      if (typeof keys === 'string') return { [keys]: clone(values[keys]) }
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, clone(values[key])]))
      }
      if (keys && typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, defaultValue]) => [
            key,
            values[key] === undefined ? clone(defaultValue) : clone(values[key])
          ])
        )
      }
      return clone(values)
    },
    async set(items: Record<string, any>) {
      Object.assign(values, clone(items))
    }
  }
}

function normalizeWindowTabs(state: any, windowId: number) {
  const tabs = Object.values(state.tabsById as Record<string, any>).filter((tab) => tab.windowId === windowId)
  const pinned = tabs.filter((tab) => tab.pinned).sort((a, b) => a.index - b.index || a.id - b.id)
  const unpinned = tabs.filter((tab) => !tab.pinned).sort((a, b) => a.index - b.index || a.id - b.id)

  ;[...pinned, ...unpinned].forEach((tab, index) => {
    tab.index = index
  })
}

function normalizeAllTabs(state: any) {
  const windowIds = new Set(Object.values(state.tabsById as Record<string, any>).map((tab) => tab.windowId))
  for (const windowId of windowIds) {
    normalizeWindowTabs(state, windowId)
  }
}

function focusWindow(state: any, windowId: number) {
  Object.values(state.windowsById as Record<string, any>).forEach((win) => {
    win.focused = win.id === windowId
  })
  state.lastFocusedWindowId = windowId
}

function createChromeMock(initialTabs: any[], options: any = {}) {
  const runtimeOnInstalled = createEventSlot()
  const runtimeOnMessage = createEventSlot()
  const runtimeOnStartup = createEventSlot()
  const tabsOnCreated = createEventSlot()
  const tabsOnActivated = createEventSlot()
  const tabsOnRemoved = createEventSlot()
  const tabsOnMoved = createEventSlot()
  const tabsOnAttached = createEventSlot()
  const tabsOnDetached = createEventSlot()
  const tabsOnReplaced = createEventSlot()
  const tabsOnUpdated = createEventSlot()
  const windowsOnFocusChanged = createEventSlot()
  const tabGroupsOnCreated = createEventSlot()
  const tabGroupsOnUpdated = createEventSlot()
  const tabGroupsOnRemoved = createEventSlot()
  const tabGroupsOnMoved = createEventSlot()
  const commandsOnCommand = createEventSlot()
  const alarmsOnAlarm = createEventSlot()
  const sessionsOnChanged = createEventSlot()
  const storageOnChanged = createEventSlot()

  const initialWindowIds = [...new Set(initialTabs.map((tab) => tab.windowId))]
  const initialLastFocusedWindowId = initialTabs[0]?.windowId || 1
  const state: any = {
    tabsById: Object.fromEntries(initialTabs.map((tab) => [tab.id, { ...tab }])),
    windowsById: Object.fromEntries(
      initialWindowIds.map((windowId) => {
        const firstTab = initialTabs.find((tab) => tab.windowId === windowId)
        return [windowId, { id: windowId, type: firstTab?.windowType || 'normal', focused: windowId === initialLastFocusedWindowId }]
      })
    ),
    nextTabId: Math.max(...initialTabs.map((tab) => tab.id)) + 1,
    nextWindowId: Math.max(1, ...initialWindowIds) + 1,
    lastFocusedWindowId: initialLastFocusedWindowId
  }
  if (!state.windowsById[initialLastFocusedWindowId]) {
    state.windowsById[initialLastFocusedWindowId] = { id: initialLastFocusedWindowId, type: 'normal', focused: true }
  }
  normalizeAllTabs(state)

  const calls: BackgroundMockCalls = {
    alarmsCreate: [],
    create: [],
    windowCreate: [],
    remove: [],
    update: [],
    windowUpdate: [],
    runtimeMessages: [],
    badgeText: [],
    badgeColor: [],
    tabGet: [],
    tabQuery: [],
    windowsGetAll: []
  }
  const storageValues = {
    local: clone(options.storageValues?.local || {}),
    session: clone(options.storageValues?.session || {})
  }
  const recentlyClosed = clone(options.recentlyClosed || [])
  const alarmsByName = new Map<string, chrome.alarms.Alarm>()

  const chrome: any = {
    runtime: {
      id: 'tab-out',
      onMessage: runtimeOnMessage.api,
      onInstalled: runtimeOnInstalled.api,
      onStartup: runtimeOnStartup.api,
      async sendMessage(extensionId: string, message: any) {
        calls.runtimeMessages.push({ extensionId, message: clone(message) })
        if (extensionId === 'blocked') throw new Error('Cannot message extension')
        if (extensionId === 'rejects') return 'Error: tab is not suspended'
        return undefined
      }
    },
    storage: {
      local: createStorageArea(storageValues.local),
      session: createStorageArea(storageValues.session),
      onChanged: storageOnChanged.api
    },
    alarms: {
      async create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo) {
        calls.alarmsCreate.push({ name, alarmInfo: clone(alarmInfo) })
        alarmsByName.set(name, {
          name,
          scheduledTime: alarmInfo.when ?? Date.now()
        })
      },
      async get(name: string) {
        return clone(alarmsByName.get(name))
      },
      onAlarm: alarmsOnAlarm.api
    },
    sessions: {
      getRecentlyClosed: async () => clone(recentlyClosed),
      onChanged: sessionsOnChanged.api
    },
    action: {
      async setBadgeText(payload: chrome.action.BadgeTextDetails) {
        calls.badgeText.push(clone(payload))
      },
      async setBadgeBackgroundColor(payload: chrome.action.BadgeColorDetails) {
        calls.badgeColor.push(clone(payload))
      }
    },
    tabs: {
      async get(tabId: number) {
        calls.tabGet.push(tabId)
        const tab = state.tabsById[tabId]
        if (!tab) throw new Error(`Missing tab ${tabId}`)
        return clone(tab)
      },
      async query(queryInfo: any = {}) {
        calls.tabQuery.push(clone(queryInfo))
        let tabs = Object.values(state.tabsById as Record<string, any>)
        if (queryInfo.windowId != null) tabs = tabs.filter((tab) => tab.windowId === queryInfo.windowId)
        if (queryInfo.active != null) tabs = tabs.filter((tab) => tab.active === queryInfo.active)
        if (queryInfo.lastFocusedWindow) tabs = tabs.filter((tab) => tab.windowId === state.lastFocusedWindowId)
        return tabs.sort((a, b) => a.index - b.index || a.id - b.id).map((tab) => clone(tab))
      },
      async update(
        tabId: number,
        updateProperties: chrome.tabs.UpdateProperties
      ) {
        const tab = state.tabsById[tabId]
        if (!tab) throw new Error(`Missing tab ${tabId}`)

        calls.update.push({ tabId, updateProperties: clone(updateProperties) })

        if (updateProperties.url !== undefined) {
          tab.url = updateProperties.url
          delete tab.pendingUrl
        }
        if (updateProperties.pinned !== undefined) {
          tab.pinned = updateProperties.pinned
        }
        if (updateProperties.openerTabId !== undefined) {
          tab.openerTabId = updateProperties.openerTabId
        }
        if (updateProperties.active) {
          Object.values(state.tabsById as Record<string, any>)
            .filter((candidate) => candidate.windowId === tab.windowId)
            .forEach((candidate) => {
              candidate.active = candidate.id === tabId
            })
          state.lastFocusedWindowId = tab.windowId
        }

        normalizeAllTabs(state)
        return clone(tab)
      },
      async create(createProperties: chrome.tabs.CreateProperties) {
        const windowId = createProperties.windowId ?? state.lastFocusedWindowId
        if (!state.windowsById[windowId]) {
          state.windowsById[windowId] = { id: windowId, type: 'normal', focused: false }
        }
        const existingTabs = Object.values(state.tabsById as Record<string, any>).filter((tab) => tab.windowId === windowId)
        const nextIndex =
          typeof createProperties.index === 'number'
            ? createProperties.index
            : existingTabs.reduce((max, tab) => Math.max(max, tab.index), -1) + 1

        const tab: any = {
          id: state.nextTabId++,
          windowId,
          url: createProperties.url || 'chrome://newtab/',
          title: '',
          favIconUrl: '',
          active: createProperties.active !== false,
          pinned: !!createProperties.pinned,
          groupId: -1,
          index: nextIndex
        }
        if (typeof createProperties.openerTabId === 'number') {
          tab.openerTabId = createProperties.openerTabId
        }

        if (tab.active) {
          existingTabs.forEach((candidate) => {
            candidate.active = false
          })
          focusWindow(state, windowId)
        }

        state.tabsById[tab.id] = tab
        calls.create.push(clone(createProperties))
        normalizeAllTabs(state)
        for (const listener of tabsOnCreated.listeners) {
          listener(clone(tab))
        }
        return clone(tab)
      },
      async remove(tabIds: number | number[]) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        calls.remove.push(...ids)
        const removedTabs = []
        for (const tabId of ids) {
          if (state.tabsById[tabId]) removedTabs.push(clone(state.tabsById[tabId]))
          delete state.tabsById[tabId]
        }

        for (const tab of removedTabs) {
          if (!tab.active) continue
          const remainingTabs = Object.values(state.tabsById as Record<string, any>)
            .filter((candidate) => candidate.windowId === tab.windowId)
            .sort((a, b) => a.index - b.index || a.id - b.id)
          const opener = remainingTabs.find((candidate) => candidate.id === tab.openerTabId)
          const neighbor = remainingTabs.find((candidate) => candidate.index > tab.index) || remainingTabs.at(-1)
          const nextActive = opener || neighbor
          if (!nextActive) continue
          remainingTabs.forEach((candidate) => {
            candidate.active = candidate.id === nextActive.id
          })
          state.lastFocusedWindowId = nextActive.windowId
        }

        normalizeAllTabs(state)
        for (const tab of removedTabs) {
          for (const listener of tabsOnRemoved.listeners) {
            listener(tab.id, { windowId: tab.windowId, isWindowClosing: false })
          }
        }
      },
      onCreated: tabsOnCreated.api,
      onActivated: tabsOnActivated.api,
      onRemoved: tabsOnRemoved.api,
      onMoved: tabsOnMoved.api,
      onAttached: tabsOnAttached.api,
      onDetached: tabsOnDetached.api,
      onReplaced: tabsOnReplaced.api,
      onUpdated: tabsOnUpdated.api
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: windowsOnFocusChanged.api,
      async getLastFocused(queryOptions: any = {}) {
        let windows = Object.values(state.windowsById as Record<string, any>)
        if (queryOptions.windowTypes) windows = windows.filter((win) => queryOptions.windowTypes.includes(win.type))
        const focusedWindow = windows.find((win) => win.id === state.lastFocusedWindowId) || windows.find((win) => win.focused) || windows[0]
        if (!focusedWindow) throw new Error('No matching focused window')
        return clone(focusedWindow)
      },
      async getCurrent() {
        const currentWindow = state.windowsById[state.lastFocusedWindowId] ||
          Object.values(state.windowsById as Record<string, any>).find((win) => win.focused)
        if (!currentWindow) throw new Error('No current window')
        return clone(currentWindow)
      },
      async getAll(queryOptions: any = {}) {
        calls.windowsGetAll.push(clone(queryOptions))
        let windows = Object.values(state.windowsById as Record<string, any>)
        if (queryOptions.windowTypes) windows = windows.filter((win) => queryOptions.windowTypes.includes(win.type))
        return windows.map((win) => clone(win))
      },
      async update(
        windowId: number,
        updateInfo: chrome.windows.UpdateInfo
      ) {
        const win = state.windowsById[windowId]
        if (!win) throw new Error(`Missing window ${windowId}`)
        calls.windowUpdate.push({ windowId, updateInfo: clone(updateInfo) })
        if (updateInfo.focused) focusWindow(state, windowId)
        return clone(win)
      },
      async create(createData: any = {}) {
        const windowId = state.nextWindowId++
        state.windowsById[windowId] = { id: windowId, type: createData.type || 'normal', focused: false }
        if (createData.focused !== false) focusWindow(state, windowId)
        calls.windowCreate.push(clone(createData))
        return clone(state.windowsById[windowId])
      }
    },
    tabGroups: {
      onCreated: tabGroupsOnCreated.api,
      onUpdated: tabGroupsOnUpdated.api,
      onRemoved: tabGroupsOnRemoved.api,
      onMoved: tabGroupsOnMoved.api
    },
    commands: {
      onCommand: commandsOnCommand.api
    }
  }

  return {
    chrome,
    calls,
    state,
    storageValues,
    recentlyClosed,
    listeners: {
      alarmsOnAlarm: alarmsOnAlarm.listeners,
      runtimeOnInstalled: runtimeOnInstalled.listeners,
      runtimeOnMessage: runtimeOnMessage.listeners,
      runtimeOnStartup: runtimeOnStartup.listeners,
      tabsOnCreated: tabsOnCreated.listeners,
      tabsOnActivated: tabsOnActivated.listeners,
      tabsOnRemoved: tabsOnRemoved.listeners,
      tabsOnReplaced: tabsOnReplaced.listeners,
      tabsOnUpdated: tabsOnUpdated.listeners,
      windowsOnFocusChanged: windowsOnFocusChanged.listeners,
      sessionsOnChanged: sessionsOnChanged.listeners,
      commandsOnCommand: commandsOnCommand.listeners
    },
    getWindowTabs(windowId: number) {
      return Object.values(state.tabsById as Record<string, any>)
        .filter((tab) => tab.windowId === windowId)
        .sort((a, b) => a.index - b.index || a.id - b.id)
        .map((tab) => clone(tab))
    },
    blurAllWindows(lastFocusedWindowId = state.lastFocusedWindowId) {
      state.lastFocusedWindowId = lastFocusedWindowId
      Object.values(state.windowsById as Record<string, any>).forEach((win) => {
        win.focused = false
      })
    },
    activateTab(tabId: number) {
      const tab = state.tabsById[tabId]
      if (!tab) throw new Error(`Missing tab ${tabId}`)
      Object.values(state.tabsById as Record<string, any>)
        .filter((candidate) => candidate.windowId === tab.windowId)
        .forEach((candidate) => {
          candidate.active = candidate.id === tabId
        })
      focusWindow(state, tab.windowId)
    },
    closeTabForWindow(tabId: number) {
      const tab = state.tabsById[tabId]
      if (!tab) throw new Error(`Missing tab ${tabId}`)
      delete state.tabsById[tabId]
      normalizeAllTabs(state)
      for (const listener of tabsOnRemoved.listeners) {
        listener(tab.id, { windowId: tab.windowId, isWindowClosing: true })
      }
    },
    async replaceTab(removedTabId: number, addedTabId: number) {
      const removedTab = state.tabsById[removedTabId]
      if (!removedTab) throw new Error(`Missing tab ${removedTabId}`)
      delete state.tabsById[removedTabId]
      state.tabsById[addedTabId] = { ...removedTab, id: addedTabId }
      state.nextTabId = Math.max(state.nextTabId, addedTabId + 1)
      const tasks = tabsOnReplaced.listeners.map((listener) => listener(addedTabId, removedTabId))
      await Promise.all(tasks.filter((task) => task instanceof Promise))
    }
  }
}

function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: { type: 'tab-out:get-dashboard-service-state' }
): Promise<DashboardServiceMessageResponse>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: 'tab-out:get-tab-history' | 'tab-out:switch-tab-history'
    direction?: -1 | 1
  }
): Promise<TabHistoryMessageResponse>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: {
    type: typeof CLOSED_TAB_RESTORE_STATE_MESSAGE
    phase: 'settled' | 'started'
    restoreId: string
  }
): Promise<{ ok: boolean }>
function sendRuntimeMessage(
  mock: BackgroundRuntimeMessageMock,
  message: Record<string, unknown>
): Promise<unknown> {
  const onMessage = mock.listeners.runtimeOnMessage[0]
  assert.ok(onMessage, 'expected a registered runtime message listener')
  return new Promise((resolve) => {
    const keepAlive = onMessage(message, {}, resolve)
    assert.equal(keepAlive, true)
  })
}

function buildWorkingSetFromServiceState(response: CapturedDashboardServiceState) {
  const focusedWindow = response.openTabsSnapshot.windows.find((win: chrome.windows.Window) => win.focused)
  return buildWorkingSetSnapshot({
    tabs: normalizeChromeOpenTabs(response.openTabsSnapshot),
    activity: response.workingSetActivity,
    currentWindowId: focusedWindow?.id ?? null
  })
}

async function flushBackgroundWork() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function loadBackground(initialTabs: any[], options: any = {}) {
  const mock = createChromeMock(initialTabs, options)
  ;(globalThis as any).chrome = mock.chrome
  await import(`${backgroundUrl.href}?test=${backgroundImportId++}`)
  await flushBackgroundWork()
  return mock
}

async function loadBackgroundWithPendingLinkTabs() {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  onFocusChanged(1)
  await flushBackgroundWork()

  for (const url of ['https://bravo.example/', 'https://charlie.example/']) {
    await mock.chrome.tabs.create({
      windowId: 1,
      url,
      active: false,
      openerTabId: 81
    })
  }
  await flushBackgroundWork()
  return mock
}

test('pinned Tab Out navigation follows Chrome default without dashboard replacement', async () => {
  const mock = await loadBackground([
    {
      id: 11,
      windowId: 1,
      url: 'chrome://newtab/',
      title: 'New Tab',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    },
    {
      id: 12,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onUpdated, 'function')

  await onUpdated(11, { status: 'loading' }, { ...clone(mock.state.tabsById[11]), pendingUrl: 'https://example.com/docs' })
  await flushBackgroundWork()
  mock.state.tabsById[11].url = 'https://example.com/docs'
  delete mock.state.tabsById[11].pendingUrl
  await onUpdated(11, { url: 'https://example.com/docs', status: 'loading' }, clone(mock.state.tabsById[11]))
  await flushBackgroundWork()

  const windowTabs = mock.getWindowTabs(1)

  assert.equal(mock.calls.create.length, 0)
  assert.equal(mock.calls.update.some((call) => call.updateProperties.pinned === false), false)
  assert.equal(windowTabs[0].id, 11)
  assert.equal(windowTabs[0].url, 'https://example.com/docs')
  assert.equal(windowTabs[0].pinned, true)
  assert.equal(windowTabs[0].active, true)
})

test('service worker lifecycle does not rewrite native new tabs into extension URLs', async () => {
  const mock = await loadBackground([
    {
      id: 21,
      windowId: 1,
      url: 'chrome://newtab/',
      title: 'New Tab',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === extensionUrl), false)

  await mock.listeners.runtimeOnStartup[0]()
  await flushBackgroundWork()
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === extensionUrl), false)

  await mock.listeners.runtimeOnInstalled[0]({ reason: 'install' })
  await flushBackgroundWork()
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === extensionUrl), false)
})

test('metadata-only tab updates do not trigger redundant badge tab queries', async () => {
  const mock = await loadBackground([
    {
      id: 25,
      windowId: 1,
      url: 'https://example.test/',
      title: 'Example',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onUpdated, 'function')
  const queriesBeforeUpdate = mock.calls.tabQuery.length

  onUpdated(25, { title: 'Updated', status: 'complete' }, { ...mock.state.tabsById[25], title: 'Updated' })
  await flushBackgroundWork()
  assert.equal(mock.calls.tabQuery.length, queriesBeforeUpdate)

  onUpdated(25, { url: 'https://example.test/next' }, { ...mock.state.tabsById[25], url: 'https://example.test/next' })
  await flushBackgroundWork()
  assert.equal(mock.calls.tabQuery.length, queriesBeforeUpdate + 1)
})

test('dashboard service state captures tabs and windows once for both open tabs and history', async () => {
  const mock = await loadBackground([
    {
      id: 26,
      windowId: 1,
      url: 'https://example.test/current',
      title: 'Current',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const allTabsReadsBefore = mock.calls.tabQuery.filter((query: any) => Object.keys(query).length === 0).length
  const allWindowsReadsBefore = mock.calls.windowsGetAll.length

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })

  assert.equal(response.ok, true)
  assert.deepEqual(response.openTabsSnapshot.tabs.map((tab: any) => tab.id), [26])
  assert.equal(response.tabHistory.activeTabId, 26)
  assert.equal(
    mock.calls.tabQuery.filter((query: any) => Object.keys(query).length === 0).length - allTabsReadsBefore,
    1
  )
  assert.equal(mock.calls.windowsGetAll.length - allWindowsReadsBefore, 1)
})

test('tab activation shares one captured tab across history and Working Set', async () => {
  const tab = {
    id: 27,
    windowId: 1,
    url: 'https://activation.example.test/current',
    title: 'Activation target',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }
  const mock = await loadBackground([tab])
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')
  const tabGetsBefore = mock.calls.tabGet.length
  const tabQueriesBefore = mock.calls.tabQuery.length

  onActivated({ tabId: tab.id, windowId: tab.windowId })
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.tabGet.slice(tabGetsBefore), [tab.id])
  assert.deepEqual(
    mock.calls.tabQuery.slice(tabQueriesBefore),
    [],
    'neither service should repeat the shared activation lookup with a window query'
  )

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
  assert.equal(response.ok, true)
  assert.equal(response.tabHistory.entries.some((entry: any) => entry.tabId === tab.id), true)
  assert.equal(
    Object.values(response.workingSetActivity.records).some((record: any) => record.url === tab.url),
    true
  )
})

test('failed shared activation capture falls back without dropping either service update', async () => {
  const tab = {
    id: 29,
    windowId: 1,
    url: 'https://activation.example.test/fallback',
    title: 'Activation fallback target',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }
  const mock = await loadBackground([tab])
  const originalGet = mock.chrome.tabs.get.bind(mock.chrome.tabs)
  let firstLookup = true
  mock.chrome.tabs.get = async (tabId: number) => {
    if (firstLookup) {
      firstLookup = false
      throw new Error('transient shared tab capture failure')
    }
    return originalGet(tabId)
  }
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')

  onActivated({ tabId: tab.id, windowId: tab.windowId })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
  assert.equal(response.ok, true)
  assert.equal(response.tabHistory.entries.some((entry: any) => entry.tabId === tab.id), true)
  assert.equal(
    Object.values(response.workingSetActivity.records).some((record: any) => record.url === tab.url),
    true
  )
})

test('window focus shares one active-tab query across history and Working Set', async () => {
  const tab = {
    id: 28,
    windowId: 1,
    url: 'https://focus.example.test/current',
    title: 'Focus target',
    active: true,
    pinned: false,
    groupId: -1,
    index: 0
  }
  const mock = await loadBackground([tab])
  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  const tabGetsBefore = mock.calls.tabGet.length
  const tabQueriesBefore = mock.calls.tabQuery.length

  onFocusChanged(tab.windowId)
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.tabGet.slice(tabGetsBefore), [])
  assert.deepEqual(mock.calls.tabQuery.slice(tabQueriesBefore), [
    { windowId: tab.windowId, active: true }
  ])

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
  assert.equal(response.ok, true)
  assert.equal(response.tabHistory.entries.some((entry: any) => entry.tabId === tab.id), true)
  assert.equal(
    Object.values(response.workingSetActivity.records).some((record: any) => record.url === tab.url),
    true
  )
})

test('filter shortcut opens a fresh focus-ready Tab Out tab from a normal page', async () => {
  const mock = await loadBackground([
    {
      id: 31,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create.at(-1), {
    windowId: 1,
    url: `${extensionUrl}?focusFilter=1`,
    active: true
  })

  const createdTab = Object.values(mock.state.tabsById as Record<string, any>).find((tab) => tab.url === `${extensionUrl}?focusFilter=1`)
  assert.ok(createdTab)
  assert.equal(createdTab.active, true)
  assert.equal(createdTab.pinned, false)
})

test('filter shortcut opens a fresh focus-ready Tab Out tab from an existing Tab Out page', async () => {
  const mock = await loadBackground([
    {
      id: 41,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 42,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [
    {
      windowId: 1,
      url: `${extensionUrl}?focusFilter=1`,
      active: true
    }
  ])
  assert.deepEqual(mock.calls.remove, [])
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === `${extensionUrl}?focusFilter=1`), false)
  assert.equal(mock.state.tabsById[41].url, extensionUrl)
  assert.equal(mock.state.tabsById[41].active, false)
  assert.equal(mock.state.tabsById[41].pinned, false)
  assert.equal(mock.state.tabsById[42].active, false)
  assert.equal(mock.state.tabsById[43].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[43].active, true)
  assert.equal(mock.state.tabsById[43].pinned, false)
})

test('filter shortcut opens an unpinned fresh Tab Out tab from a pinned active dashboard', async () => {
  const mock = await loadBackground([
    {
      id: 61,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    },
    {
      id: 62,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [
    {
      windowId: 1,
      url: `${extensionUrl}?focusFilter=1`,
      active: true
    }
  ])
  assert.deepEqual(mock.calls.remove, [])
  assert.equal(mock.state.tabsById[61].url, extensionUrl)
  assert.equal(mock.state.tabsById[61].active, false)
  assert.equal(mock.state.tabsById[61].pinned, true)
  assert.equal(mock.state.tabsById[62].active, false)
  assert.equal(mock.state.tabsById[63].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[63].active, true)
  assert.equal(mock.state.tabsById[63].pinned, false)
})

test('filter shortcut opens in a normal browser window when a standalone app window is focused', async () => {
  const mock = await loadBackground([
    {
      id: 71,
      windowId: 10,
      windowType: 'popup',
      url: 'https://mail.google.com/mail/u/0/',
      title: 'Inbox',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 72,
      windowId: 2,
      windowType: 'normal',
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [
    {
      windowId: 2,
      url: `${extensionUrl}?focusFilter=1`,
      active: true
    }
  ])
  assert.deepEqual(mock.calls.windowUpdate.at(-1), {
    windowId: 2,
    updateInfo: { focused: true }
  })
  assert.equal(mock.state.tabsById[73].windowId, 2)
  assert.equal(mock.state.tabsById[73].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[73].active, true)
})

test('global new-tab shortcut opens a native new tab in the last focused normal window', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  mock.blurAllWindows()
  onCommand('open-new-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create.at(-1), {
    windowId: 1,
    active: true
  })
  assert.deepEqual(mock.calls.windowUpdate.at(-1), {
    windowId: 1,
    updateInfo: { focused: true }
  })

  const createdTab = Object.values(mock.state.tabsById as Record<string, any>).find((tab) => tab.url === 'chrome://newtab/')
  assert.ok(createdTab)
  assert.equal(createdTab.active, true)
  assert.equal(createdTab.pinned, false)
})

test('global new-tab shortcut opens a normal browser window when no normal window exists', async () => {
  const mock = await loadBackground([
    {
      id: 91,
      windowId: 10,
      windowType: 'popup',
      url: 'https://mail.example.com/',
      title: 'Inbox',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-new-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [])
  assert.deepEqual(mock.calls.windowCreate, [
    {
      type: 'normal',
      focused: true
    }
  ])
})

test('background command listener settles every rejected async command', async () => {
  const mock = await loadBackground([
    {
      id: 101,
      windowId: 1,
      url: 'https://example.test/',
      title: 'Example',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  mock.chrome.tabs.query = async () => {
    throw new Error('Tab query failed')
  }
  mock.chrome.tabs.create = async () => {
    throw new Error('Tab creation failed')
  }
  mock.chrome.windows.getLastFocused = async () => {
    throw new Error('Window lookup failed')
  }
  mock.chrome.windows.getAll = async () => []
  mock.chrome.windows.create = async () => {
    throw new Error('Window creation failed')
  }

  for (const command of ['switch-to-last-tab', 'switch-to-next-tab', 'open-filter-tab', 'open-new-tab']) {
    const commandTask = onCommand(command)
    assert.ok(commandTask instanceof Promise)
    await assert.doesNotReject(() => commandTask)
  }
})

test('browser startup clears persisted tab-id history before refreshing the startup snapshot', async () => {
  const mock = await loadBackground(
    [
      {
        id: 111,
        windowId: 1,
        url: 'https://current.example.test/',
        title: 'Current',
        active: true,
        pinned: false,
        groupId: -1,
        index: 0
      }
    ],
    {
      storageValues: {
        local: {
          globalTabHistory: {
            stack: [
              { windowId: 1, tabId: 111 },
              { windowId: 1, tabId: 222 }
            ],
            index: 1,
            pending: [{ windowId: 1, tabId: 333 }]
          }
        }
      }
    }
  )

  const onStartup = mock.listeners.runtimeOnStartup[0]
  assert.equal(typeof onStartup, 'function')
  await onStartup()
  await flushBackgroundWork()

  assert.deepEqual(mock.storageValues.local.globalTabHistory, {
    version: 2,
    stack: [{ windowId: 1, tabId: 111, url: 'https://current.example.test/' }],
    index: 0,
    pending: []
  })
})

test('tab replacement rebases history, Working Set, and the warm startup snapshot', async () => {
  const mock = await loadBackground([
    {
      id: 201,
      windowId: 1,
      url: 'https://one.example.test/',
      title: 'One',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 202,
      windowId: 1,
      url: 'https://two.example.test/',
      title: 'Two',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 203,
      windowId: 1,
      url: 'https://three.example.test/',
      title: 'Three',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onInstalled = mock.listeners.runtimeOnInstalled[0]
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onInstalled, 'function')

  for (const tabId of [202, 203, 201]) {
    mock.activateTab(tabId)
    onActivated({ tabId, windowId: 1 })
  }
  await flushBackgroundWork()
  onInstalled({ reason: 'install' })
  await flushBackgroundWork()

  const warmBefore = requireStartupSnapshot(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.ok(warmBefore.dashboard.realTabs.some((tab) => tab.id === 201))
  assert.ok(warmBefore.tabHistory.entries.some((entry) => entry.tabId === 201))
  assert.ok(warmBefore.workingSet.items.some((item) => item.tabId === 201))

  await mock.replaceTab(201, 211)
  await flushBackgroundWork()
  await backgroundClock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
  await flushBackgroundWork()

  const warmAfter = requireStartupSnapshot(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.equal(warmAfter.dashboard.realTabs.some((tab) => tab.id === 201), false)
  assert.equal(warmAfter.tabHistory.entries.some((entry) => entry.tabId === 201), false)
  assert.equal(warmAfter.workingSet.items.some((item) => item.tabId === 201), false)
  assert.ok(warmAfter.dashboard.realTabs.some((tab) => tab.id === 211))
  assert.ok(warmAfter.tabHistory.entries.some((entry) => entry.tabId === 211))
  assert.ok(warmAfter.workingSet.items.some((item) => item.tabId === 211))
})

test('active tab is primed to close back to the previous same-window tab without fallback flash', async () => {
  const mock = await loadBackground([
    {
      id: 71,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 72,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 73,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  onActivated({ tabId: 72, windowId: 1 })
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.update.at(-1), {
    tabId: 72,
    updateProperties: { openerTabId: 71 }
  })
  assert.equal(mock.state.tabsById[72].openerTabId, 71)

  await mock.chrome.tabs.remove(72)
  await flushBackgroundWork()

  assert.equal(mock.state.tabsById[71].active, true)
  assert.equal(mock.state.tabsById[73].active, false)
  assert.equal(
    mock.calls.update.some((call) => call.updateProperties.active === true && call.tabId === 71),
    false
  )
})

test('tab history snapshot exposes previous and next command targets', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 82,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 83,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(82, { active: true })
  onActivated({ tabId: 82, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(83, { active: true })
  onActivated({ tabId: 83, windowId: 1 })
  await flushBackgroundWork()

  const initialResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const initialSnapshot = requireHistorySnapshot(initialResponse)
  assert.equal(initialSnapshot.maxSize, 48)
  assert.equal(initialSnapshot.currentIndex, 2)
  assert.equal(initialSnapshot.previousIndex, 1)
  assert.equal(initialSnapshot.nextIndex, -1)
  assert.equal(valueAt(initialSnapshot.entries, 1).previousTarget, true)
  assert.equal(valueAt(initialSnapshot.entries, 2).current, true)
  assert.equal(valueAt(initialSnapshot.entries, 2).active, true)

  const updateTab = mock.chrome.tabs.update.bind(mock.chrome.tabs)
  mock.chrome.tabs.update = async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    const updatedTab = await updateTab(tabId, updateProperties)
    if (updateProperties.active) onActivated({ tabId, windowId: updatedTab.windowId })
    return updatedTab
  }
  const switchedResponse = await sendRuntimeMessage(mock, { type: 'tab-out:switch-tab-history', direction: -1 })
  await flushBackgroundWork()

  const switchedSnapshot = requireHistorySnapshot(switchedResponse)
  assert.equal(mock.state.tabsById[82].active, true)
  assert.equal(switchedSnapshot.currentIndex, 1)
  assert.equal(switchedSnapshot.previousIndex, 0)
  assert.equal(switchedSnapshot.nextIndex, 2)
  assert.equal(valueAt(switchedSnapshot.entries, 0).previousTarget, true)
  assert.equal(valueAt(switchedSnapshot.entries, 1).current, true)
  assert.equal(valueAt(switchedSnapshot.entries, 2).nextTarget, true)
})

test('tab history keeps a valid target when activation succeeds but window focus fails', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 82,
      windowId: 2,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.windows.update(2, { focused: true })
  onFocusChanged(2)
  await flushBackgroundWork()

  let rejectedFocusAttempts = 0
  mock.chrome.windows.update = async () => {
    rejectedFocusAttempts += 1
    throw new Error('Window focus unavailable')
  }

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: -1
  })
  await flushBackgroundWork()

  assert.equal(response.ok, true)
  assert.equal(rejectedFocusAttempts, 1)
  assert.equal(mock.state.tabsById[81].active, true)
  assert.deepEqual(response.snapshot.entries.map((entry) => entry.tabId), [81, 82])
})

test('background-created link tabs become FIFO indexed next history targets', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })

  assert.equal(response.ok, true)
  assert.equal(response.snapshot.stackSize, 1)
  assert.equal(response.snapshot.pendingSize, 2)
  assert.equal(response.snapshot.currentIndex, 0)
  assert.equal(response.snapshot.nextIndex, 1)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      index: entry.index,
      pending: entry.pending,
      nextTarget: entry.nextTarget
    }))),
    [
      { tabId: 81, index: 0, pending: false, nextTarget: false },
      { tabId: 82, index: 1, pending: true, nextTarget: true },
      { tabId: 83, index: 2, pending: true, nextTarget: false }
    ]
  )
})

test('a background-created pending target survives a redirect before first activation', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://example.test/current',
      title: 'Current',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  onFocusChanged(1)
  await flushBackgroundWork()

  const pendingTab = await mock.chrome.tabs.create({
    windowId: 1,
    url: 'https://example.test/redirect-start',
    active: false,
    openerTabId: 81
  })
  await flushBackgroundWork()
  mock.state.tabsById[pendingTab.id].url = 'https://example.test/redirect-final'
  onUpdated(
    pendingTab.id,
    { url: 'https://example.test/redirect-final' },
    clone(mock.state.tabsById[pendingTab.id])
  )
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })

  assert.equal(response.ok, true)
  assert.equal(response.snapshot.pendingSize, 1)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      url: entry.url,
      pending: entry.pending
    }))),
    [
      { tabId: 81, url: 'https://example.test/current', pending: false },
      { tabId: pendingTab.id, url: 'https://example.test/redirect-final', pending: true }
    ]
  )
})

test('failed pending-tab activation does not promote or advance history', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()
  const updateTab = mock.chrome.tabs.update.bind(mock.chrome.tabs)
  let rejectedActivationAttempts = 0
  mock.chrome.tabs.update = async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
    if (updateProperties.active) {
      rejectedActivationAttempts += 1
      throw new Error('Tab activation unavailable')
    }
    return updateTab(tabId, updateProperties)
  }

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: 1
  })
  const snapshotResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })

  assert.equal(response.ok, false)
  assert.equal(rejectedActivationAttempts, 1)
  assert.equal(mock.state.tabsById[81].active, true)
  assert.equal(mock.state.tabsById[82].active, false)
  assert.equal(snapshotResponse.ok, true)
  assert.equal(snapshotResponse.snapshot.stackSize, 1)
  assert.equal(snapshotResponse.snapshot.pendingSize, 2)
  assert.equal(snapshotResponse.snapshot.currentIndex, 0)
  assert.deepEqual(
    clone(snapshotResponse.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      pending: entry.pending,
      current: entry.current,
      nextTarget: entry.nextTarget
    }))),
    [
      { tabId: 81, pending: false, current: true, nextTarget: false },
      { tabId: 82, pending: true, current: false, nextTarget: true },
      { tabId: 83, pending: true, current: false, nextTarget: false }
    ]
  )
})

test('forward history promotes the first pending tab and advances to the next one', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: 1
  })
  await flushBackgroundWork()

  assert.equal(response.ok, true)
  assert.equal(mock.state.tabsById[82].active, true)
  assert.equal(response.snapshot.stackSize, 2)
  assert.equal(response.snapshot.pendingSize, 1)
  assert.equal(response.snapshot.currentIndex, 1)
  assert.equal(response.snapshot.nextIndex, 2)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      index: entry.index,
      pending: entry.pending,
      current: entry.current,
      nextTarget: entry.nextTarget
    }))),
    [
      { tabId: 81, index: 0, pending: false, current: false, nextTarget: false },
      { tabId: 82, index: 1, pending: false, current: true, nextTarget: false },
      { tabId: 83, index: 2, pending: true, current: false, nextTarget: true }
    ]
  )
})

test('activated forward history stays ahead of pending background tabs', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 82,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 83,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(82, { active: true })
  onActivated({ tabId: 82, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(83, { active: true })
  onActivated({ tabId: 83, windowId: 1 })
  await flushBackgroundWork()
  await sendRuntimeMessage(mock, { type: 'tab-out:switch-tab-history', direction: -1 })
  await flushBackgroundWork()

  await mock.chrome.tabs.create({
    windowId: 1,
    url: 'https://delta.example/',
    active: false,
    openerTabId: 82
  })
  await flushBackgroundWork()

  const beforeSwitch = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const beforeSwitchSnapshot = requireHistorySnapshot(beforeSwitch)
  const beforeSwitchTarget = valueAt(beforeSwitchSnapshot.entries, 2)
  const pendingEntry = valueAt(beforeSwitchSnapshot.entries, 3)
  assert.equal(beforeSwitchSnapshot.currentIndex, 1)
  assert.equal(beforeSwitchSnapshot.nextIndex, 2)
  assert.equal(beforeSwitchTarget.tabId, 83)
  assert.equal(beforeSwitchTarget.nextTarget, true)
  assert.equal(pendingEntry.tabId, 84)
  assert.equal(pendingEntry.pending, true)

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: 1
  })
  await flushBackgroundWork()

  const switchedSnapshot = requireHistorySnapshot(response)
  const switchedPendingEntry = valueAt(switchedSnapshot.entries, 3)
  assert.equal(mock.state.tabsById[83].active, true)
  assert.equal(switchedSnapshot.currentIndex, 2)
  assert.equal(switchedSnapshot.nextIndex, 3)
  assert.equal(switchedPendingEntry.tabId, 84)
  assert.equal(switchedPendingEntry.pending, true)
  assert.equal(switchedPendingEntry.nextTarget, true)
})

test('manual activation promotes only the selected pending background tab', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()
  const onActivated = mock.listeners.tabsOnActivated[0]

  await mock.chrome.tabs.update(83, { active: true })
  onActivated({ tabId: 83, windowId: 1 })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)

  assert.equal(snapshot.stackSize, 2)
  assert.equal(snapshot.pendingSize, 1)
  assert.equal(snapshot.currentIndex, 1)
  assert.equal(snapshot.nextIndex, 2)
  assert.deepEqual(
    clone(snapshot.entries.map((entry) => ({
      tabId: entry.tabId,
      pending: entry.pending,
      current: entry.current
    }))),
    [
      { tabId: 81, pending: false, current: false },
      { tabId: 83, pending: false, current: true },
      { tabId: 82, pending: true, current: false }
    ]
  )
})

test('closing a pending background tab removes it from indexed history', async () => {
  const mock = await loadBackgroundWithPendingLinkTabs()

  await mock.chrome.tabs.remove(82)
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)
  const pendingEntry = valueAt(snapshot.entries, 1)

  assert.equal(snapshot.stackSize, 1)
  assert.equal(snapshot.pendingSize, 1)
  assert.equal(snapshot.nextIndex, 1)
  assert.deepEqual(
    clone(snapshot.entries.map((entry) => entry.tabId)),
    [81, 83]
  )
  assert.equal(pendingEntry.pending, true)
  assert.equal(pendingEntry.nextTarget, true)
})

test('inactive tabs without an opener do not enter pending history', async () => {
  const mock = await loadBackground([
    {
      id: 81,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.create({
    windowId: 1,
    url: 'https://restored.example/',
    active: false
  })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)

  assert.equal(snapshot.pendingSize, 0)
  assert.deepEqual(
    clone(snapshot.entries.map((entry) => entry.tabId)),
    [81]
  )
})

test('tab history command unsuspends the selected history target', async () => {
  const suspendedUrl = 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const mock = await loadBackground([
    {
      id: 86,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: false,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 87,
      windowId: 1,
      url: suspendedUrl,
      title: 'Suspended Docs',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 88,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: true,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(87, { active: true })
  onActivated({ tabId: 87, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(88, { active: true })
  onActivated({ tabId: 88, windowId: 1 })
  await flushBackgroundWork()

  const switchedResponse = await sendRuntimeMessage(mock, { type: 'tab-out:switch-tab-history', direction: -1 })
  await flushBackgroundWork()

  assert.equal(switchedResponse.ok, true)
  assert.deepEqual(mock.calls.runtimeMessages, [
    {
      extensionId: 'blocked',
      message: { action: 'unsuspend', tabId: 87 }
    }
  ])
  assert.deepEqual(mock.calls.update.filter((call) => call.updateProperties.active === true && call.tabId === 87).at(-1), {
    tabId: 87,
    updateProperties: { active: true, url: 'https://example.com/docs' }
  })
  assert.deepEqual(mock.calls.update.at(-1), {
    tabId: 87,
    updateProperties: { openerTabId: 88 }
  })
  assert.equal(mock.state.tabsById[87].url, 'https://example.com/docs')
  assert.equal(mock.state.tabsById[87].active, true)
})

test('tab history snapshot marks standalone app entries', async () => {
  const mock = await loadBackground([
    {
      id: 84,
      windowId: 1,
      url: 'https://example.com/',
      title: 'Normal',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 85,
      windowId: 2,
      windowType: 'popup',
      url: 'https://app.example.com/',
      title: 'Standalone App',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  mock.activateTab(85)
  onFocusChanged(2)
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.equal(response.snapshot.entries.find((entry) => entry.tabId === 84)?.isApp, false)
  assert.equal(response.snapshot.entries.find((entry) => entry.tabId === 85)?.isApp, true)
})

test('tab history snapshot exposes effective and raw URLs for suspended tabs', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const mock = await loadBackground([
    {
      id: 89,
      windowId: 1,
      url: suspendedUrl,
      title: 'chrome-extension://marvellous/suspended.html',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  onFocusChanged(1)
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const entry = valueAt(requireHistorySnapshot(response).entries, 0)

  assert.equal(entry.title, 'Docs')
  assert.equal(entry.url, 'https://example.com/docs')
  assert.equal(entry.rawUrl, suspendedUrl)
  assert.equal(entry.displayUrl, 'example.com/docs')
})

test('combined service state ranks activated and actively navigated open tabs', async () => {
  const originalDateNow = Date.now
  let now = Date.UTC(2026, 4, 17, 12)
  Date.now = () => now
  const mock = await loadBackground([
    {
      id: 401,
      windowId: 1,
      url: 'https://alpha.example/docs',
      title: 'Alpha docs',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 402,
      windowId: 1,
      url: 'https://bravo.example/home',
      title: 'Bravo home',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 403,
      windowId: 1,
      url: 'https://charlie.example/report',
      title: 'Charlie report',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    },
    {
      id: 404,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: false,
      pinned: false,
      groupId: -1,
      index: 3
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onUpdated, 'function')

  try {
    onFocusChanged(1)
    await flushBackgroundWork()
    now += 60_000
    await mock.chrome.tabs.update(402, { active: true })
    onActivated({ tabId: 402, windowId: 1 })
    await flushBackgroundWork()

    now += 60_000
    mock.state.tabsById[402].url = 'https://bravo.example/issues/123?utm_source=mail#comments'
    mock.state.tabsById[402].title = 'Bravo issue 123'
    onUpdated(402, { url: mock.state.tabsById[402].url, title: mock.state.tabsById[402].title }, clone(mock.state.tabsById[402]))
    await flushBackgroundWork()

    now += 60_000
    await mock.chrome.tabs.update(403, { active: true })
    onActivated({ tabId: 403, windowId: 1 })
    await flushBackgroundWork()

    const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
    assert.equal(response.ok, true)
    const snapshot = buildWorkingSetFromServiceState(response)
    assert.deepEqual(
      snapshot.items.map((item) => item.tabId),
      [403, 402, 401]
    )
    assert.equal(valueAt(snapshot.items, 1).displayUrl, 'bravo.example/issues/123')
    assert.equal(snapshot.items.some((item) => item.title === 'Tab Out'), false)
  } finally {
    Date.now = originalDateNow
  }
})

test('combined service state ignores a same-page refresh signal', async () => {
  const mock = await loadBackground([
    {
      id: 501,
      windowId: 1,
      url: 'https://example.test/workflows',
      title: 'Workflows',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onUpdated, 'function')

  onActivated({ tabId: 501, windowId: 1 })
  await flushBackgroundWork()
  const before = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })

  onUpdated(
    501,
    { url: mock.state.tabsById[501].url, status: 'loading' },
    clone(mock.state.tabsById[501])
  )
  await flushBackgroundWork()
  const after = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })

  assert.equal(before.ok, true)
  assert.equal(after.ok, true)
  const workflowRecord = after.workingSetActivity.records['https://example.test/workflows']
  assert.ok(workflowRecord)
  assert.deepEqual(
    workflowRecord.events.map((event) => event.kind),
    ['activation']
  )
  assert.deepEqual(
    after.tabHistory.entries.map((entry) => entry.tabId),
    before.tabHistory.entries.map((entry) => entry.tabId)
  )
  assert.equal(after.tabHistory.currentIndex, before.tabHistory.currentIndex)
})

test('combined service state ignores title-only updates so idle tabs do not reshuffle', async () => {
  const originalDateNow = Date.now
  let now = Date.UTC(2026, 4, 17, 12)
  Date.now = () => now
  const mock = await loadBackground([
    {
      id: 601,
      windowId: 1,
      url: 'https://alpha.example/docs',
      title: 'Alpha docs',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 602,
      windowId: 2,
      url: 'https://bravo.example/home',
      title: 'Bravo home',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 603,
      windowId: 1,
      url: 'https://charlie.example/report',
      title: 'Charlie report',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onUpdated = mock.listeners.tabsOnUpdated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onUpdated, 'function')

  try {
    onFocusChanged(2)
    await flushBackgroundWork()

    now += 60_000
    onFocusChanged(1)
    await flushBackgroundWork()

    now += 60_000
    await mock.chrome.tabs.update(603, { active: true })
    onActivated({ tabId: 603, windowId: 1 })
    await flushBackgroundWork()

    const before = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
    assert.equal(before.ok, true)
    const beforeSnapshot = buildWorkingSetFromServiceState(before)
    assert.deepEqual(
      beforeSnapshot.items.map((item) => item.tabId),
      [603, 601, 602]
    )

    now += 60_000
    mock.state.tabsById[602].title = 'Bravo home (1)'
    onUpdated(602, { title: mock.state.tabsById[602].title }, clone(mock.state.tabsById[602]))
    await flushBackgroundWork()

    const after = await sendRuntimeMessage(mock, { type: 'tab-out:get-dashboard-service-state' })
    assert.equal(after.ok, true)
    const afterSnapshot = buildWorkingSetFromServiceState(after)
    assert.deepEqual(
      afterSnapshot.items.map((item) => item.tabId),
      beforeSnapshot.items.map((item) => item.tabId)
    )
  } finally {
    Date.now = originalDateNow
  }
})

test('recently closed session changes refresh the warm startup snapshot without a tab event', async () => {
  const mock = await loadBackground([
    {
      id: 511,
      windowId: 1,
      url: 'https://open.example.test/',
      title: 'Open page',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])
  const onInstalled = mock.listeners.runtimeOnInstalled[0]
  const onSessionsChanged = mock.listeners.sessionsOnChanged[0]
  assert.equal(typeof onInstalled, 'function')
  assert.equal(typeof onSessionsChanged, 'function')

  onInstalled({ reason: 'install' })
  await flushBackgroundWork()
  const beforeSnapshot = requireStartupSnapshot(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.equal(
    beforeSnapshot.closedTabs.some((entry) => entry.url === 'https://closed.example.test/report'),
    false
  )

  mock.recentlyClosed.push({
    lastModified: 1_700_000_000,
    tab: {
      sessionId: 'closed-report',
      id: 512,
      windowId: 1,
      url: 'https://closed.example.test/report',
      title: 'Closed report',
      favIconUrl: ''
    }
  })
  onSessionsChanged()
  await backgroundClock.tickAsync(150 + STARTUP_SNAPSHOT_DEBOUNCE_MS)
  await flushBackgroundWork()

  const afterSnapshot = requireStartupSnapshot(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.equal(
    afterSnapshot.closedTabs.some((entry) => entry.url === 'https://closed.example.test/report'),
    true
  )
})

test('background restore messages hold an early sessions change until the restore settles', async () => {
  const mock = await loadBackground([
    {
      id: 521,
      windowId: 1,
      url: 'https://open.example.test/',
      title: 'Open page',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ], {
    recentlyClosed: [{
      lastModified: 1_700_000_000,
      tab: {
        sessionId: 'closed-slow',
        id: 522,
        windowId: 1,
        url: 'https://closed.example.test/slow',
        title: 'Slow restore',
        favIconUrl: ''
      }
    }]
  })
  const onSessionsChanged = mock.listeners.sessionsOnChanged[0]
  assert.equal(typeof onSessionsChanged, 'function')

  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
    restoreId: 'restore-slow',
    phase: 'started'
  }), { ok: true })
  onSessionsChanged()
  await backgroundClock.tickAsync(151)
  await flushBackgroundWork()
  assert.equal(mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)

  assert.deepEqual(await sendRuntimeMessage(mock, {
    type: CLOSED_TAB_RESTORE_STATE_MESSAGE,
    restoreId: 'restore-slow',
    phase: 'settled'
  }), { ok: true })
  await backgroundClock.tickAsync(149)
  assert.equal(mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)

  await backgroundClock.tickAsync(1)
  assert.equal(mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)

  await backgroundClock.tickAsync(STARTUP_SNAPSHOT_DEBOUNCE_MS)
  for (
    let turn = 0;
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] === undefined && turn < 20;
    turn += 1
  ) {
    await flushBackgroundWork()
  }
  assert.ok(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY],
    `expected trailing cache write after ${mock.calls.tabQuery.length} tab queries and ${mock.calls.windowsGetAll.length} window reads`
  )
  const trailingSnapshot = requireStartupSnapshot(
    mock.storageValues.session[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  )
  assert.equal(
    trailingSnapshot.closedTabs.some((entry) => entry.url === 'https://closed.example.test/slow'),
    true
  )
})

test('tab history survives extension reload through persistent storage', async () => {
  const mock = await loadBackground([
    {
      id: 301,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 302,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 303,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(302, { active: true })
  onActivated({ tabId: 302, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(303, { active: true })
  onActivated({ tabId: 303, windowId: 1 })
  await flushBackgroundWork()

  assert.deepEqual(
    clone(mock.storageValues.local.globalTabHistory.stack.map((entry: { tabId: number }) => entry.tabId)),
    [301, 302, 303]
  )

  const reloadedTabs = Object.values(mock.state.tabsById).map((tab) => clone(tab))
  const reloadedMock = await loadBackground(reloadedTabs, { storageValues: mock.storageValues })

  const response = await sendRuntimeMessage(reloadedMock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [301, 302, 303]
  )
  assert.equal(response.snapshot.currentIndex, 2)
  assert.equal(response.snapshot.previousIndex, 1)
  assert.equal(valueAt(response.snapshot.entries, 2).active, true)
})

test('tab history keeps only the latest entry for a repeated tab id', async () => {
  const mock = await loadBackground([
    {
      id: 101,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 102,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 103,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(102, { active: true })
  onActivated({ tabId: 102, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(103, { active: true })
  onActivated({ tabId: 103, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(101, { active: true })
  onActivated({ tabId: 101, windowId: 1 })
  await flushBackgroundWork()

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [102, 103, 101]
  )
  assert.equal(response.snapshot.stackSize, 3)
  assert.equal(response.snapshot.currentIndex, 2)
  assert.equal(response.snapshot.previousIndex, 1)

  const secondResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const secondSnapshot = requireHistorySnapshot(secondResponse)
  assert.deepEqual(
    clone(secondSnapshot.entries.map((entry) => entry.tabId)),
    [102, 103, 101]
  )
})

test('tab history serializes rapid activation events in order', async () => {
  const mock = await loadBackground([
    {
      id: 131,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 132,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 133,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')

  mock.activateTab(131)
  onActivated({ tabId: 131, windowId: 1 })
  mock.activateTab(132)
  onActivated({ tabId: 132, windowId: 1 })
  mock.activateTab(133)
  onActivated({ tabId: 133, windowId: 1 })

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [131, 132, 133]
  )
  assert.equal(response.snapshot.currentIndex, 2)
  assert.equal(response.snapshot.previousIndex, 1)
})

test('history shortcut focuses the current Chrome tab first when Chrome is not focused', async () => {
  const mock = await loadBackground([
    {
      id: 111,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 112,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 113,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onCommand, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(112, { active: true })
  onActivated({ tabId: 112, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(113, { active: true })
  onActivated({ tabId: 113, windowId: 1 })
  await flushBackgroundWork()

  mock.blurAllWindows()
  const updateCount = mock.calls.update.length
  const windowUpdateCount = mock.calls.windowUpdate.length

  onCommand('switch-to-last-tab')
  await flushBackgroundWork()

  const commandUpdates = mock.calls.update.slice(updateCount)
  assert.equal(mock.state.tabsById[113].active, true)
  assert.equal(mock.state.tabsById[112].active, false)
  assert.deepEqual(
    commandUpdates.filter((call) => call.updateProperties.active === true).map((call) => call.tabId),
    [113]
  )
  assert.deepEqual(mock.calls.windowUpdate.slice(windowUpdateCount), [
    {
      windowId: 1,
      updateInfo: { focused: true }
    }
  ])

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const snapshot = requireHistorySnapshot(response)
  assert.equal(snapshot.currentIndex, 2)
  assert.equal(snapshot.previousIndex, 1)
})

test('history shortcut does not move or rewrite the cursor when focused-window state is unknown', async () => {
  const mock = await loadBackground([
    {
      id: 116,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 117,
      windowId: 2,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  assert.equal(typeof onFocusChanged, 'function')
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.windows.update(2, { focused: true })
  onFocusChanged(2)
  await flushBackgroundWork()

  const getAll = mock.chrome.windows.getAll.bind(mock.chrome.windows)
  let getAllCalls = 0
  mock.chrome.windows.getAll = async (queryOptions: Record<string, unknown> = {}) => {
    getAllCalls += 1
    if (getAllCalls === 1) throw new Error('Focused-window state unavailable')
    return getAll(queryOptions)
  }
  const updateCount = mock.calls.update.length
  const windowUpdateCount = mock.calls.windowUpdate.length

  const response = await sendRuntimeMessage(mock, {
    type: 'tab-out:switch-tab-history',
    direction: -1
  })

  assert.equal(response.ok, false)
  assert.equal(mock.state.tabsById[116].active, true)
  assert.equal(mock.state.tabsById[117].active, true)
  assert.deepEqual(mock.calls.update.slice(updateCount), [])
  assert.deepEqual(mock.calls.windowUpdate.slice(windowUpdateCount), [])
})

test('history shortcut prefers current history tab over stale last-focused window', async () => {
  const mock = await loadBackground([
    {
      id: 121,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 122,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 123,
      windowId: 2,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 0
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onFocusChanged, 'function')
  assert.equal(typeof onActivated, 'function')
  assert.equal(typeof onCommand, 'function')

  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(122, { active: true })
  onActivated({ tabId: 122, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.windows.update(2, { focused: true })
  await mock.chrome.tabs.update(123, { active: true })
  onActivated({ tabId: 123, windowId: 2 })
  await flushBackgroundWork()

  mock.blurAllWindows(1)
  const updateCount = mock.calls.update.length
  const windowUpdateCount = mock.calls.windowUpdate.length

  onCommand('switch-to-last-tab')
  await flushBackgroundWork()

  const commandUpdates = mock.calls.update.slice(updateCount)
  assert.equal(mock.state.tabsById[123].active, true)
  assert.equal(mock.state.windowsById[2].focused, true)
  assert.equal(mock.state.windowsById[1].focused, false)
  assert.deepEqual(
    commandUpdates.filter((call) => call.updateProperties.active === true).map((call) => call.tabId),
    [123]
  )
  assert.deepEqual(mock.calls.windowUpdate.slice(windowUpdateCount), [
    {
      windowId: 2,
      updateInfo: { focused: true }
    }
  ])
})

test('window-closing tabs are removed before they consume history slots', async () => {
  const tabs = Array.from({ length: 25 }, (_, index) => {
    const id = 201 + index
    return {
      id,
      windowId: 1,
      url: `https://tab-${id}.example/`,
      title: `Tab ${id}`,
      active: index === 0,
      pinned: false,
      groupId: -1,
      index
    }
  })
  const mock = await loadBackground(tabs)

  const onActivated = mock.listeners.tabsOnActivated[0]
  assert.equal(typeof onActivated, 'function')

  for (const tab of tabs.slice(0, 24)) {
    mock.activateTab(tab.id)
    onActivated({ tabId: tab.id, windowId: tab.windowId })
    await flushBackgroundWork()
  }

  mock.closeTabForWindow(212)
  mock.activateTab(225)
  onActivated({ tabId: 225, windowId: 1 })

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  const historyIds = clone(response.snapshot.entries.map((entry) => entry.tabId))
  assert.equal(response.snapshot.stackSize, 24)
  assert.equal(historyIds.includes(201), true)
  assert.equal(historyIds.includes(212), false)
  assert.equal(historyIds.at(-1), 225)
})

test('tab history snapshot prunes missing tabs before returning entries', async () => {
  const mock = await loadBackground([
    {
      id: 91,
      windowId: 1,
      url: 'https://alpha.example/',
      title: 'Alpha',
      active: true,
      pinned: false,
      groupId: -1,
      index: 0
    },
    {
      id: 92,
      windowId: 1,
      url: 'https://bravo.example/',
      title: 'Bravo',
      active: false,
      pinned: false,
      groupId: -1,
      index: 1
    },
    {
      id: 93,
      windowId: 1,
      url: 'https://charlie.example/',
      title: 'Charlie',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
    }
  ])

  const onFocusChanged = mock.listeners.windowsOnFocusChanged[0]
  const onActivated = mock.listeners.tabsOnActivated[0]
  onFocusChanged(1)
  await flushBackgroundWork()
  await mock.chrome.tabs.update(92, { active: true })
  onActivated({ tabId: 92, windowId: 1 })
  await flushBackgroundWork()
  await mock.chrome.tabs.update(93, { active: true })
  onActivated({ tabId: 93, windowId: 1 })
  await flushBackgroundWork()

  delete mock.state.tabsById[92]

  const response = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  assert.equal(response.ok, true)
  assert.deepEqual(
    clone(response.snapshot.entries.map((entry) => entry.tabId)),
    [91, 93]
  )
  assert.equal(response.snapshot.stackSize, 2)
  assert.equal(response.snapshot.currentIndex, 1)
  assert.equal(response.snapshot.previousIndex, 0)
  assert.equal(response.snapshot.entries.every((entry) => entry.exists), true)

  const secondResponse = await sendRuntimeMessage(mock, { type: 'tab-out:get-tab-history' })
  const secondSnapshot = requireHistorySnapshot(secondResponse)
  assert.deepEqual(
    clone(secondSnapshot.entries.map((entry) => entry.tabId)),
    [91, 93]
  )
})
