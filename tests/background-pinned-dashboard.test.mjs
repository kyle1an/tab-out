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

function focusWindow(state, windowId) {
  Object.values(state.windowsById).forEach((win) => {
    win.focused = win.id === windowId
  })
  state.lastFocusedWindowId = windowId
}

function createChromeMock(initialTabs) {
  const runtimeOnInstalled = createEventSlot()
  const runtimeOnMessage = createEventSlot()
  const runtimeOnStartup = createEventSlot()
  const tabsOnCreated = createEventSlot()
  const tabsOnActivated = createEventSlot()
  const tabsOnRemoved = createEventSlot()
  const tabsOnUpdated = createEventSlot()
  const windowsOnFocusChanged = createEventSlot()
  const commandsOnCommand = createEventSlot()

  const initialWindowIds = [...new Set(initialTabs.map((tab) => tab.windowId))]
  const initialLastFocusedWindowId = initialTabs[0]?.windowId || 1
  const state = {
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

  const calls = {
    create: [],
    windowCreate: [],
    remove: [],
    update: [],
    windowUpdate: [],
    badgeText: [],
    badgeColor: []
  }

  const chrome = {
    runtime: {
      id: 'tab-out',
      onMessage: runtimeOnMessage.api,
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
        if (updateProperties.openerTabId !== undefined) {
          tab.openerTabId = updateProperties.openerTabId
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
        if (!state.windowsById[windowId]) {
          state.windowsById[windowId] = { id: windowId, type: 'normal', focused: false }
        }
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
          focusWindow(state, windowId)
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

        for (const tab of removedTabs) {
          if (!tab.active) continue
          const remainingTabs = Object.values(state.tabsById)
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
      onUpdated: tabsOnUpdated.api
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: windowsOnFocusChanged.api,
      async getLastFocused(queryOptions = {}) {
        let windows = Object.values(state.windowsById)
        if (queryOptions.windowTypes) windows = windows.filter((win) => queryOptions.windowTypes.includes(win.type))
        const focusedWindow = windows.find((win) => win.id === state.lastFocusedWindowId) || windows.find((win) => win.focused) || windows[0]
        if (!focusedWindow) throw new Error('No matching focused window')
        return clone(focusedWindow)
      },
      async getAll(queryOptions = {}) {
        let windows = Object.values(state.windowsById)
        if (queryOptions.windowTypes) windows = windows.filter((win) => queryOptions.windowTypes.includes(win.type))
        return windows.map((win) => clone(win))
      },
      async update(windowId, updateInfo) {
        const win = state.windowsById[windowId]
        if (!win) throw new Error(`Missing window ${windowId}`)
        calls.windowUpdate.push({ windowId, updateInfo: clone(updateInfo) })
        if (updateInfo.focused) focusWindow(state, windowId)
        return clone(win)
      },
      async create(createData = {}) {
        const windowId = state.nextWindowId++
        state.windowsById[windowId] = { id: windowId, type: createData.type || 'normal', focused: false }
        if (createData.focused !== false) focusWindow(state, windowId)
        calls.windowCreate.push(clone(createData))
        return clone(state.windowsById[windowId])
      }
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
      runtimeOnMessage: runtimeOnMessage.listeners,
      runtimeOnStartup: runtimeOnStartup.listeners,
      tabsOnCreated: tabsOnCreated.listeners,
      tabsOnActivated: tabsOnActivated.listeners,
      tabsOnRemoved: tabsOnRemoved.listeners,
      tabsOnUpdated: tabsOnUpdated.listeners,
      windowsOnFocusChanged: windowsOnFocusChanged.listeners,
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

function sendRuntimeMessage(mock, message) {
  const onMessage = mock.listeners.runtimeOnMessage[0]
  assert.equal(typeof onMessage, 'function')
  return new Promise((resolve) => {
    const keepAlive = onMessage(message, {}, resolve)
    assert.equal(keepAlive, true)
  })
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

  const createdTab = Object.values(mock.state.tabsById).find((tab) => tab.url === `${extensionUrl}?focusFilter=1`)
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
  assert.equal(initialResponse.ok, true)
  assert.equal(initialResponse.snapshot.currentIndex, 2)
  assert.equal(initialResponse.snapshot.previousIndex, 1)
  assert.equal(initialResponse.snapshot.nextIndex, -1)
  assert.equal(initialResponse.snapshot.entries[1].previousTarget, true)
  assert.equal(initialResponse.snapshot.entries[2].current, true)
  assert.equal(initialResponse.snapshot.entries[2].active, true)

  const switchedResponse = await sendRuntimeMessage(mock, { type: 'tab-out:switch-tab-history', direction: -1 })
  await flushBackgroundWork()

  assert.equal(switchedResponse.ok, true)
  assert.equal(mock.state.tabsById[82].active, true)
  assert.equal(switchedResponse.snapshot.currentIndex, 1)
  assert.equal(switchedResponse.snapshot.previousIndex, 0)
  assert.equal(switchedResponse.snapshot.nextIndex, 2)
  assert.equal(switchedResponse.snapshot.entries[0].previousTarget, true)
  assert.equal(switchedResponse.snapshot.entries[1].current, true)
  assert.equal(switchedResponse.snapshot.entries[2].nextTarget, true)
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
  assert.deepEqual(
    clone(secondResponse.snapshot.entries.map((entry) => entry.tabId)),
    [91, 93]
  )
})
