import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')
const extensionUrl = 'chrome-extension://tab-out/index.html'

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function createEventSlot() {
  const listeners = []
  return {
    listeners,
    api: {
      addListener(fn) {
        listeners.push(fn)
      }
    }
  }
}

function normalizeWindowTabs(state, windowId) {
  const tabs = Object.values(state.tabsById).filter((tab) => tab.windowId === windowId)
  const pinned = tabs.filter((tab) => tab.pinned).sort((a, b) => a.index - b.index || a.id - b.id)
  const unpinned = tabs.filter((tab) => !tab.pinned).sort((a, b) => a.index - b.index || a.id - b.id)

  ;[...pinned, ...unpinned].forEach((tab, index) => {
    tab.index = index
  })
}

function normalizeAllTabs(state) {
  const windowIds = new Set(Object.values(state.tabsById).map((tab) => tab.windowId))
  for (const windowId of windowIds) {
    normalizeWindowTabs(state, windowId)
  }
}

function createChromeMock(initialTabs) {
  const runtimeOnInstalled = createEventSlot()
  const runtimeOnStartup = createEventSlot()
  const tabsOnCreated = createEventSlot()
  const tabsOnActivated = createEventSlot()
  const tabsOnRemoved = createEventSlot()
  const tabsOnUpdated = createEventSlot()
  const windowsOnFocusChanged = createEventSlot()
  const windowsOnCreated = createEventSlot()
  const commandsOnCommand = createEventSlot()

  const state = {
    tabsById: Object.fromEntries(initialTabs.map((tab) => [tab.id, { ...tab }])),
    nextTabId: Math.max(...initialTabs.map((tab) => tab.id)) + 1,
    sessionStorage: {},
    lastFocusedWindowId: initialTabs[0]?.windowId || 1
  }
  normalizeAllTabs(state)

  const calls = {
    create: [],
    update: [],
    move: [],
    badgeText: [],
    badgeColor: []
  }

  const chrome = {
    runtime: {
      id: 'tab-out',
      onInstalled: runtimeOnInstalled.api,
      onStartup: runtimeOnStartup.api
    },
    action: {
      async setBadgeText(payload) {
        calls.badgeText.push(clone(payload))
      },
      async setBadgeBackgroundColor(payload) {
        calls.badgeColor.push(clone(payload))
      }
    },
    storage: {
      session: {
        async get(key) {
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((entry) => [entry, clone(state.sessionStorage[entry])]))
          }
          return { [key]: clone(state.sessionStorage[key]) }
        },
        async set(values) {
          Object.assign(state.sessionStorage, clone(values))
        }
      }
    },
    tabs: {
      async query(queryInfo = {}) {
        let tabs = Object.values(state.tabsById)
        if (queryInfo.windowId != null) tabs = tabs.filter((tab) => tab.windowId === queryInfo.windowId)
        if (queryInfo.active != null) tabs = tabs.filter((tab) => tab.active === queryInfo.active)
        if (queryInfo.lastFocusedWindow) tabs = tabs.filter((tab) => tab.windowId === state.lastFocusedWindowId)
        return tabs.sort((a, b) => a.index - b.index || a.id - b.id).map((tab) => clone(tab))
      },
      async update(tabId, updateProperties) {
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
        if (updateProperties.active) {
          Object.values(state.tabsById)
            .filter((candidate) => candidate.windowId === tab.windowId)
            .forEach((candidate) => {
              candidate.active = candidate.id === tabId
            })
          state.lastFocusedWindowId = tab.windowId
        }

        normalizeAllTabs(state)
        return clone(tab)
      },
      async create(createProperties) {
        const windowId = createProperties.windowId ?? state.lastFocusedWindowId
        const existingTabs = Object.values(state.tabsById).filter((tab) => tab.windowId === windowId)
        const nextIndex =
          typeof createProperties.index === 'number'
            ? createProperties.index
            : existingTabs.reduce((max, tab) => Math.max(max, tab.index), -1) + 1

        const tab = {
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

        if (tab.active) {
          existingTabs.forEach((candidate) => {
            candidate.active = false
          })
          state.lastFocusedWindowId = windowId
        }

        state.tabsById[tab.id] = tab
        calls.create.push(clone(createProperties))
        normalizeAllTabs(state)
        return clone(tab)
      },
      async move(tabId, moveProperties) {
        const tab = state.tabsById[tabId]
        if (!tab) throw new Error(`Missing tab ${tabId}`)

        calls.move.push({ tabId, moveProperties: clone(moveProperties) })
        const orderedTabs = Object.values(state.tabsById)
          .filter((candidate) => candidate.windowId === tab.windowId)
          .sort((a, b) => a.index - b.index || a.id - b.id)
        const remainingTabs = orderedTabs.filter((candidate) => candidate.id !== tabId)
        const targetIndex = Math.max(0, Math.min(moveProperties.index, remainingTabs.length))

        remainingTabs.splice(targetIndex, 0, tab)
        remainingTabs.forEach((candidate, index) => {
          candidate.index = index
        })

        return clone(tab)
      },
      onCreated: tabsOnCreated.api,
      onActivated: tabsOnActivated.api,
      onRemoved: tabsOnRemoved.api,
      onUpdated: tabsOnUpdated.api
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: windowsOnFocusChanged.api,
      onCreated: windowsOnCreated.api,
      async update() {}
    },
    commands: {
      onCommand: commandsOnCommand.api
    }
  }

  return {
    chrome,
    calls,
    state,
    listeners: {
      runtimeOnInstalled: runtimeOnInstalled.listeners,
      runtimeOnStartup: runtimeOnStartup.listeners,
      tabsOnCreated: tabsOnCreated.listeners,
      tabsOnActivated: tabsOnActivated.listeners,
      tabsOnRemoved: tabsOnRemoved.listeners,
      tabsOnUpdated: tabsOnUpdated.listeners,
      windowsOnFocusChanged: windowsOnFocusChanged.listeners,
      windowsOnCreated: windowsOnCreated.listeners,
      commandsOnCommand: commandsOnCommand.listeners
    },
    getWindowTabs(windowId) {
      return Object.values(state.tabsById)
        .filter((tab) => tab.windowId === windowId)
        .sort((a, b) => a.index - b.index || a.id - b.id)
        .map((tab) => clone(tab))
    }
  }
}

async function flushBackgroundWork() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

async function loadBackground(initialTabs) {
  const mock = createChromeMock(initialTabs)
  const context = vm.createContext({
    chrome: mock.chrome,
    console,
    setTimeout,
    clearTimeout
  })

  new vm.Script(backgroundSource, { filename: 'background.js' }).runInContext(context)
  await flushBackgroundWork()
  return mock
}

test('omnibox navigation from a pinned Tab Out tab swaps on pendingUrl and creates a native new tab anchor', async () => {
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
  const pinnedDashboards = windowTabs.filter((tab) => tab.pinned && isTabOutLikeUrl(tab.url))
  const movedTab = windowTabs.at(-1)

  assert.equal(mock.calls.create.length, 1)
  assert.equal('url' in mock.calls.create[0], false)
  assert.equal(mock.calls.move.length, 1)
  assert.equal(pinnedDashboards.length, 1)
  assert.notEqual(pinnedDashboards[0].id, 11)
  assert.equal(windowTabs[0].id, pinnedDashboards[0].id)
  assert.equal(movedTab.id, 11)
  assert.equal(movedTab.url, 'https://example.com/docs')
  assert.equal(movedTab.pinned, false)
  assert.equal(movedTab.active, true)
  assert.deepEqual(mock.state.sessionStorage.pinnedDashboardTabs, { [String(pinnedDashboards[0].id)]: { windowId: 1 } })
})

test('existing pinned Tab Out anchor is reused instead of creating a duplicate', async () => {
  const mock = await loadBackground([
    {
      id: 11,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: true,
      pinned: true,
      groupId: -1,
      index: 0
    },
    {
      id: 15,
      windowId: 1,
      url: extensionUrl,
      title: 'Tab Out',
      active: false,
      pinned: true,
      groupId: -1,
      index: 1
    },
    {
      id: 12,
      windowId: 1,
      url: 'https://openai.com/',
      title: 'OpenAI',
      active: false,
      pinned: false,
      groupId: -1,
      index: 2
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
  const pinnedDashboards = windowTabs.filter((tab) => tab.pinned && isTabOutLikeUrl(tab.url))

  assert.equal(mock.calls.create.length, 0)
  assert.deepEqual(
    pinnedDashboards.map((tab) => tab.id),
    [15]
  )
  assert.equal(windowTabs.at(-1).id, 11)
  assert.equal(windowTabs.at(-1).pinned, false)
})

function isTabOutLikeUrl(url) {
  return url === extensionUrl || url === 'chrome://newtab/'
}

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
