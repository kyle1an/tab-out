import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchDashboardSnapshot, fetchDashboardStartupSnapshot } from '../src/hooks/useDashboardRefresh.js'
import { DEFAULT_HISTORY_RANGE } from '../src/extension/history-source.js'

const now = Date.now()

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

function activityRecord(url: string, title: string, at: number) {
  return {
    key: url,
    url,
    title,
    domain: new URL(url).hostname,
    lastSeenAt: at,
    lastActivatedAt: at,
    events: [{ kind: 'activation' as const, at }]
  }
}

test('startup snapshot commits dashboard, history, working set, and closed tabs from one startup path', async () => {
  let tabsQueryCount = 0
  let windowsGetAllCount = 0
  let windowsGetCurrentCount = 0
  let tabGroupsQueryCount = 0
  let sessionsGetRecentlyClosedCount = 0
  const runtimeMessages: string[] = []
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.com/app', 'Example App'),
    makeChromeTab(3, 'https://example.test/report', 'Example Report'),
    makeChromeTab(4, 'chrome://extensions/', 'Extensions')
  ]
  const workingSetTabs = openTabs.filter((tab) => tab.url?.startsWith('https://'))

  ;(globalThis as any).window = {
    LOCAL_CUSTOM_GROUPS: [],
    LOCAL_PATH_GROUPERS: []
  }
  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async (message: { type?: string }) => {
        runtimeMessages.push(String(message.type || ''))
        if (message.type === 'tab-out:get-dashboard-service-state') {
          return {
            ok: true,
            tabHistory: {
              stackSize: 0,
              maxSize: 24,
              cursorIndex: -1,
              currentIndex: -1,
              previousIndex: -1,
              nextIndex: -1,
              activeTabId: null,
              activeWindowId: null,
              activeWasInserted: false,
              entries: []
            },
            workingSetActivity: {
              version: 1,
              records: Object.fromEntries(workingSetTabs.map((tab, index) => [
                tab.url,
                activityRecord(String(tab.url), String(tab.title), now - index)
              ]))
            }
          }
        }
        return { ok: false }
      }
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        return openTabs
      }
    },
    windows: {
      getAll: async () => {
        windowsGetAllCount += 1
        return [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[]
      },
      getCurrent: async () => {
        windowsGetCurrentCount += 1
        return { id: 1, focused: true, type: 'normal' } as chrome.windows.Window
      }
    },
    tabGroups: {
      query: async () => {
        tabGroupsQueryCount += 1
        return []
      }
    },
    sessions: {
      getRecentlyClosed: async () => {
        sessionsGetRecentlyClosedCount += 1
        return [
          {
            lastModified: now,
            tab: {
              sessionId: 'closed-tab',
              id: 9,
              index: 0,
              windowId: 1,
              highlighted: false,
              active: false,
              pinned: false,
              incognito: false,
              selected: false,
              discarded: false,
              autoDiscardable: true,
              groupId: -1,
              url: 'https://example.com/closed',
              title: 'Closed Example'
            } as chrome.tabs.Tab & { sessionId: string }
          }
        ] as chrome.sessions.Session[]
      }
    },
    storage: {
      local: {
        get: async () => ({})
      }
    }
  }

  const snapshot = await fetchDashboardStartupSnapshot({
    source: 'tabs',
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.deepEqual(snapshot.dashboard.realTabs.map((tab) => tab.url), workingSetTabs.map((tab) => tab.url))
  assert.deepEqual(snapshot.dashboard.domainGroups.map((group) => group.domain), ['example.com', 'example.test'])
  assert.equal(snapshot.tabHistory.stackSize, 0)
  assert.equal(snapshot.workingSet.items.length, 3)
  assert.equal(snapshot.closedTabs.length, 1)
  assert.equal(snapshot.closedTabs[0]?.url, 'https://example.com/closed')
  assert.equal(tabsQueryCount, 1)
  assert.equal(windowsGetAllCount, 1)
  assert.equal(windowsGetCurrentCount, 1)
  assert.equal(tabGroupsQueryCount, 1)
  assert.equal(sessionsGetRecentlyClosedCount, 1)
  assert.deepEqual(runtimeMessages, ['tab-out:get-dashboard-service-state'])
})

test('tabs refresh snapshot derives dashboard and working set from the same open-tab read', async () => {
  let tabsQueryCount = 0
  let windowsGetAllCount = 0
  let windowsGetCurrentCount = 0
  const runtimeMessages: string[] = []
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report'),
    makeChromeTab(3, 'chrome://extensions/', 'Extensions')
  ]

  ;(globalThis as any).window = {
    LOCAL_CUSTOM_GROUPS: [],
    LOCAL_PATH_GROUPERS: []
  }
  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async (message: { type?: string }) => {
        runtimeMessages.push(String(message.type || ''))
        return {
          ok: true,
          tabHistory: {
            stackSize: 1,
            maxSize: 24,
            cursorIndex: 0,
            currentIndex: 0,
            previousIndex: -1,
            nextIndex: -1,
            activeTabId: 1,
            activeWindowId: 1,
            activeWasInserted: false,
            entries: []
          },
          workingSetActivity: {
            version: 1,
            records: {
              'https://example.com/docs': activityRecord('https://example.com/docs', 'Example Docs', now)
            }
          }
        }
      }
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        return openTabs
      }
    },
    windows: {
      getAll: async () => {
        windowsGetAllCount += 1
        return [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[]
      },
      getCurrent: async () => {
        windowsGetCurrentCount += 1
        return { id: 1, focused: true, type: 'normal' } as chrome.windows.Window
      }
    },
    tabGroups: {
      query: async () => []
    },
    storage: {
      local: {
        get: async () => ({})
      }
    }
  }

  const snapshot = await fetchDashboardSnapshot({
    source: 'tabs',
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.deepEqual(snapshot.dashboard.realTabs.map((tab) => tab.url), ['https://example.com/docs', 'https://example.test/report'])
  assert.equal(snapshot.workingSet.items.length, 0)
  assert.equal(snapshot.tabHistory.stackSize, 1)
  assert.equal(tabsQueryCount, 1)
  assert.equal(windowsGetAllCount, 1)
  assert.equal(windowsGetCurrentCount, 1)
  assert.deepEqual(runtimeMessages, ['tab-out:get-dashboard-service-state'])
})
