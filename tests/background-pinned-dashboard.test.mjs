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

function createChromeMock(initialTabs, opts = {}) {
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
    remove: [],
    update: [],
    move: [],
    runtimeMessage: [],
    badgeText: [],
    badgeColor: []
  }

  const chrome = {
    runtime: {
      id: 'tab-out',
      onInstalled: runtimeOnInstalled.api,
      onStartup: runtimeOnStartup.api,
      async sendMessage(message) {
        calls.runtimeMessage.push(clone(message))
        if (opts.runtimeMessageError) throw new Error('runtime message failed')
        if (opts.runtimeMessageResponses?.length) return clone(opts.runtimeMessageResponses.shift())
        return clone(opts.runtimeMessageResponse ?? { focused: true })
      }
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
      async remove(tabIds) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        calls.remove.push(...ids)
        const removedTabs = []
        for (const tabId of ids) {
          if (state.tabsById[tabId]) removedTabs.push(clone(state.tabsById[tabId]))
          delete state.tabsById[tabId]
        }
        normalizeAllTabs(state)
        for (const tab of removedTabs) {
          for (const listener of tabsOnRemoved.listeners) {
            listener(tab.id, { windowId: tab.windowId, isWindowClosing: false })
          }
        }
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

async function loadBackground(initialTabs, opts = {}) {
  const mock = createChromeMock(initialTabs, opts)
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
  return url === 'chrome://newtab/' || url === extensionUrl || url === `${extensionUrl}?focusFilter=1`
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

test('filter shortcut opens a new Tab Out tab with the focus marker', async () => {
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
    url: `${extensionUrl}?focusFilter=1`,
    active: true
  })

  const createdTab = Object.values(mock.state.tabsById).find((tab) => tab.url === `${extensionUrl}?focusFilter=1`)
  assert.ok(createdTab)
  assert.equal(createdTab.active, true)
  assert.equal(createdTab.pinned, false)
  assert.deepEqual(mock.calls.runtimeMessage, [])
})

test('filter shortcut focuses the active Tab Out page instead of opening a duplicate', async () => {
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

  assert.equal(mock.calls.create.length, 0)
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === `${extensionUrl}?focusFilter=1`), false)
  assert.deepEqual(mock.calls.runtimeMessage, [
    {
      type: 'tab-out:focus-filter',
      tabId: 41
    }
  ])
})

test('filter shortcut replaces the active Tab Out tab when Chrome keeps focus in the omnibox', async () => {
  const mock = await loadBackground(
    [
      {
        id: 51,
        windowId: 1,
        url: extensionUrl,
        title: 'Tab Out',
        active: true,
        pinned: false,
        groupId: -1,
        index: 0
      },
      {
        id: 52,
        windowId: 1,
        url: 'https://openai.com/',
        title: 'OpenAI',
        active: false,
        pinned: false,
        groupId: -1,
        index: 1
      }
    ],
    { runtimeMessageResponse: { focused: false } }
  )

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.runtimeMessage, [
    {
      type: 'tab-out:focus-filter',
      tabId: 51
    }
  ])
  assert.deepEqual(mock.calls.create, [
    {
      windowId: 1,
      url: `${extensionUrl}?focusFilter=1`,
      active: true,
      pinned: false,
      index: 0
    }
  ])
  assert.deepEqual(mock.calls.remove, [51])
  assert.equal(mock.calls.update.some((call) => call.updateProperties.url === `${extensionUrl}?focusFilter=1`), false)
  assert.equal(mock.state.tabsById[51], undefined)
  assert.equal(mock.state.tabsById[53].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[53].active, true)
  assert.equal(mock.state.tabsById[53].pinned, false)
  assert.equal(mock.state.tabsById[53].index, 0)
  assert.equal(mock.state.tabsById[52].active, false)
})

test('filter shortcut keeps a pinned dashboard pinned when replacing for filter focus', async () => {
  const mock = await loadBackground(
    [
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
    ],
    { runtimeMessageResponse: { focused: false } }
  )

  const onCommand = mock.listeners.commandsOnCommand[0]
  assert.equal(typeof onCommand, 'function')

  onCommand('open-filter-tab')
  await flushBackgroundWork()

  assert.deepEqual(mock.calls.create, [
    {
      windowId: 1,
      url: `${extensionUrl}?focusFilter=1`,
      active: true,
      pinned: true,
      index: 0
    }
  ])
  assert.deepEqual(mock.calls.remove, [61])
  assert.deepEqual(
    mock.calls.runtimeMessage,
    [
      {
        type: 'tab-out:focus-filter',
        tabId: 61
      }
    ]
  )
  assert.equal(mock.state.tabsById[61], undefined)
  assert.equal(mock.state.tabsById[63].url, `${extensionUrl}?focusFilter=1`)
  assert.equal(mock.state.tabsById[63].active, true)
  assert.equal(mock.state.tabsById[63].pinned, true)
  assert.equal(mock.state.tabsById[63].index, 0)
  assert.equal(mock.state.tabsById[62].active, false)
  assert.deepEqual(mock.state.sessionStorage.pinnedDashboardTabs, { 63: { windowId: 1 } })
})
