/* ================================================================
   createFakeChromeApi — the one fake browser.

   A chrome-shaped object over caller-owned state, used three ways:
   • node tests: setChromeTabsApi(createFakeChromeApi(...)) or
     globalThis.chrome = createFakeChromeApi(...)
   • the resize fixture: window.chrome = createFakeChromeApi(...)
     (this file is a browser-native ES module — no build step)
   • live-state clones for debugging

   State semantics: `tabs` (and `windows`) are LIVE references — the
   fake mutates them in place (splice/merge) so fixture closures that
   also push into the same arrays observe every change. Every on*
   event exposes { addListener, removeListener, dispatch }. Pass a
   caller-owned `tabCommandLog` to inspect reload/duplicate targets.

   Types: see fake-chrome.d.mts (repo has allowJs: false).
   ================================================================ */

function createFakeChromeEvent() {
  const handlers = []
  return {
    addListener(handler) {
      handlers.push(handler)
    },
    removeListener(handler) {
      const index = handlers.indexOf(handler)
      if (index >= 0) handlers.splice(index, 1)
    },
    dispatch(...args) {
      for (const handler of handlers.slice()) handler(...args)
    }
  }
}

function normalizeStorageKeys(keys) {
  if (typeof keys === 'string') return [keys]
  if (Array.isArray(keys)) return keys
  return Object.keys(keys)
}

export function createFakeChromeApi({
  tabs = [],
  windows = [{ id: 1, type: 'normal', focused: true }],
  tabGroups = [],
  recentlyClosed = [],
  storageSeed = {},
  getBookmarkTree = () => [],
  historySearch = () => [],
  sendMessage = null,
  getURL = (path) => path,
  runtimeId = 'tab-out-fake-extension',
  tabCommandLog = { duplicate: [], reload: [] }
} = {}) {
  let nextId = tabs.reduce((max, tab) => Math.max(max, tab.id ?? 0), 1000) + 1
  const nextWindowId = () => windows.reduce((max, w) => Math.max(max, w.id ?? 0), 1) + 1

  const findTab = (tabId) => tabs.find((tab) => tab.id === tabId)

  const removeTabIds = (tabIds) => {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
    for (const id of ids) {
      const index = tabs.findIndex((tab) => tab.id === id)
      if (index >= 0) tabs.splice(index, 1)
    }
  }

  const api = {
    tabs: {
      query: async () => tabs.slice(),
      get: async (tabId) => {
        const tab = findTab(tabId)
        if (!tab) throw new Error(`No tab with id: ${tabId}.`)
        return tab
      },
      getCurrent: async () => undefined,
      remove: async (tabIds) => {
        removeTabIds(tabIds)
      },
      update: async (tabId, updateProperties) => {
        const tab = findTab(tabId)
        if (!tab) throw new Error(`No tab with id: ${tabId}.`)
        if (updateProperties.url !== undefined) tab.url = updateProperties.url
        if (updateProperties.pinned !== undefined) tab.pinned = updateProperties.pinned
        if (updateProperties.muted !== undefined) tab.mutedInfo = { muted: updateProperties.muted }
        if (updateProperties.active) {
          for (const other of tabs) {
            if (other.windowId === tab.windowId) other.active = other.id === tab.id
          }
        }
        return tab
      },
      create: async (createProperties) => {
        const tab = {
          id: nextId++,
          url: createProperties.url ?? 'chrome://newtab/',
          title: '',
          favIconUrl: '',
          windowId: createProperties.windowId ?? windows[0]?.id ?? 1,
          active: createProperties.active ?? true,
          pinned: createProperties.pinned ?? false,
          groupId: -1,
          index: typeof createProperties.index === 'number' ? createProperties.index : tabs.length
        }
        tabs.push(tab)
        return tab
      },
      reload: async (tabId) => {
        if (!findTab(tabId)) throw new Error(`No tab with id: ${tabId}.`)
        tabCommandLog.reload.push(tabId)
      },
      duplicate: async (tabId) => {
        const source = findTab(tabId)
        if (!source) throw new Error(`No tab with id: ${tabId}.`)
        tabCommandLog.duplicate.push(tabId)
        const duplicate = {
          ...source,
          id: nextId++,
          index: source.index + 1
        }
        tabs.push(duplicate)
        return duplicate
      },
      move: async (tabId, moveProperties) => {
        const tab = findTab(tabId)
        if (!tab) throw new Error(`No tab with id: ${tabId}.`)
        if (typeof moveProperties.index === 'number') tab.index = moveProperties.index
        if (typeof moveProperties.windowId === 'number') tab.windowId = moveProperties.windowId
        return tab
      },
      group: async ({ tabIds, groupId }) => {
        const resolvedGroupId = typeof groupId === 'number' ? groupId : nextId++
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        for (const id of ids) {
          const tab = findTab(id)
          if (tab) tab.groupId = resolvedGroupId
        }
        return resolvedGroupId
      },
      onCreated: createFakeChromeEvent(),
      onActivated: createFakeChromeEvent(),
      onRemoved: createFakeChromeEvent(),
      onMoved: createFakeChromeEvent(),
      onAttached: createFakeChromeEvent(),
      onDetached: createFakeChromeEvent(),
      onReplaced: createFakeChromeEvent(),
      onUpdated: createFakeChromeEvent()
    },
    windows: {
      getAll: async () => windows.slice(),
      getCurrent: async () => windows.find((w) => w.focused) ?? windows[0],
      update: async (windowId, updateInfo) => {
        const target = windows.find((w) => w.id === windowId)
        if (!target) throw new Error(`No window with id: ${windowId}.`)
        if (updateInfo.focused) {
          for (const w of windows) w.focused = w.id === windowId
        }
        return target
      },
      create: async (createData = {}) => {
        const created = { id: nextWindowId(), type: createData.type ?? 'normal', focused: createData.focused ?? true }
        if (created.focused) {
          for (const w of windows) w.focused = false
        }
        windows.push(created)
        if (createData.url) {
          await api.tabs.create({ url: Array.isArray(createData.url) ? createData.url[0] : createData.url, windowId: created.id, active: true })
        }
        return created
      },
      onFocusChanged: createFakeChromeEvent()
    },
    tabGroups: {
      query: async () => tabGroups.slice(),
      onCreated: createFakeChromeEvent(),
      onUpdated: createFakeChromeEvent(),
      onRemoved: createFakeChromeEvent(),
      onMoved: createFakeChromeEvent()
    },
    sessions: {
      getRecentlyClosed: async () => recentlyClosed.slice(),
      restore: async (sessionId) => {
        const index = recentlyClosed.findIndex((session) => session.tab?.sessionId === sessionId || session.window?.sessionId === sessionId)
        if (index < 0) throw new Error(`No session with id: ${sessionId}.`)
        const [session] = recentlyClosed.splice(index, 1)
        if (session.tab) tabs.push({ ...session.tab, id: nextId++ })
        return session
      }
    },
    runtime: {
      id: runtimeId,
      getURL,
      sendMessage: async (...args) => {
        if (sendMessage) return sendMessage(...args)
        return undefined
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...storageSeed }
          const result = {}
          for (const name of normalizeStorageKeys(keys)) {
            if (Object.hasOwn(storageSeed, name)) result[name] = storageSeed[name]
          }
          return result
        },
        set: async (items) => {
          Object.assign(storageSeed, items)
        },
        remove: async (keys) => {
          for (const name of normalizeStorageKeys(keys)) delete storageSeed[name]
        }
      },
      onChanged: createFakeChromeEvent()
    },
    bookmarks: {
      getTree: async () => getBookmarkTree(),
      onCreated: createFakeChromeEvent(),
      onRemoved: createFakeChromeEvent(),
      onChanged: createFakeChromeEvent(),
      onMoved: createFakeChromeEvent(),
      onChildrenReordered: createFakeChromeEvent(),
      onImportEnded: createFakeChromeEvent()
    },
    history: {
      search: async () => historySearch(),
      deleteUrl: async () => {},
      onVisited: createFakeChromeEvent(),
      onVisitRemoved: createFakeChromeEvent()
    }
  }

  return api
}
