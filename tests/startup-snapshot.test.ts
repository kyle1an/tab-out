import assert from 'node:assert/strict'
import test from 'node:test'

import { DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS, fetchDashboardSnapshot, fetchDashboardStartupSnapshot, loadCachedDashboardStartup, loadCachedDashboardStartupSnapshot } from '../src/hooks/useDashboardRefresh.js'
import { loadDashboardLocalState } from '../src/hooks/useDashboardLocalState.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import { DEFAULT_HISTORY_RANGE } from '../src/extension/history-source.js'
import { PAGE_CHIP_PIN_STORAGE_KEY } from '../src/extension/page-chip-pins.js'
import { SAVED_PAGES_STORAGE_KEY } from '../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY } from '../src/extension/section-pins.js'

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

function workingSetSnapshotItem(url: string, title: string, score: number) {
  return {
    key: url,
    tabId: 1,
    windowId: 1,
    tabUrl: url,
    rawUrl: url,
    title,
    displayUrl: url,
    faviconUrl: '',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    score,
    lastActivatedAt: now
  }
}

test('startup snapshot cache paints any structurally valid session snapshot', async () => {
  const snapshot = {
    dashboard: {
      realTabs: [],
      domainGroups: []
    },
    tabHistory: {
      entries: []
    },
    workingSet: {
      items: []
    },
    closedTabs: []
  } as any
  let cached: unknown = {
    savedAt: now,
    snapshot,
    localState: {
      loaded: true,
      pinnedDomains: ['example.test'],
      pinnedSectionIds: ['section-alpha'],
      pinnedPageChipIds: ['chip-alpha']
    }
  }

  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: cached })
      }
    }
  }

  const fresh = await loadCachedDashboardStartup()
  assert.equal(fresh?.snapshot.dashboard, snapshot.dashboard)
  assert.deepEqual(fresh?.snapshot.tabHistory.entries, [])
  assert.deepEqual(fresh?.snapshot.workingSet.items, [])
  assert.deepEqual(fresh?.localState?.pinnedDomains, ['example.test'])
  assert.deepEqual(fresh?.localState?.pinnedSectionIds, ['section-alpha'])
  assert.deepEqual(fresh?.localState?.pinnedPageChipIds, ['chip-alpha'])
  assert.equal((await loadCachedDashboardStartupSnapshot())?.dashboard, snapshot.dashboard)

  // An aged snapshot still belongs to this browser session (chrome.storage.session is
  // cleared on restart), so it is painted immediately instead of dropped; otherwise reopens
  // slower than the old display TTL flash an empty dashboard before live hydration.
  cached = {
    savedAt: now - 60_001,
    snapshot
  }
  assert.equal((await loadCachedDashboardStartup())?.snapshot.dashboard, snapshot.dashboard)

  cached = {
    savedAt: now,
    snapshot: { dashboard: {} }
  }
  assert.equal(await loadCachedDashboardStartup(), null)
})

test('startup snapshot commits dashboard, history, working set, and closed tabs from one startup path', async () => {
  let tabsQueryCount = 0
  let windowsGetAllCount = 0
  let windowsGetCurrentCount = 0
  let tabGroupsQueryCount = 0
  let sessionsGetRecentlyClosedCount = 0
  let cachedStartupSnapshot: Record<string, unknown> | null = null
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
      session: {
        set: async (value: Record<string, unknown>) => {
          cachedStartupSnapshot = value
        }
      },
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
    localState: {
      loaded: true,
      pinnedDomains: ['example.test'],
      pinnedSectionIds: ['section-alpha'],
      pinnedPageChipIds: ['chip-alpha']
    },
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
  const cachedSnapshot = cachedStartupSnapshot?.[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any
  assert.equal(cachedSnapshot?.snapshot, snapshot)
  assert.deepEqual(cachedSnapshot?.localState?.pinnedDomains, ['example.test'])
  assert.deepEqual(cachedSnapshot?.localState?.pinnedSectionIds, ['section-alpha'])
  assert.deepEqual(cachedSnapshot?.localState?.pinnedPageChipIds, ['chip-alpha'])
  assert.deepEqual(runtimeMessages, ['tab-out:get-dashboard-service-state'])
})

test('startup snapshot cache preserves fresh cached working set priority when saving live startup data', async () => {
  let cachedStartupSnapshot: Record<string, unknown> | null = null
  const cachedWorkingSet = {
    defaultLimit: 3,
    expandedLimit: 7,
    items: [workingSetSnapshotItem('https://example.com/docs', 'Cached Docs', 999)]
  }
  const liveTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Live Docs'),
    makeChromeTab(2, 'https://example.com/app', 'Live App'),
    makeChromeTab(3, 'https://example.com/report', 'Live Report')
  ]
  const existingCache = {
    savedAt: now,
    workingSetSavedAt: now,
    snapshot: {
      dashboard: {
        realTabs: [],
        domainGroups: []
      },
      tabHistory: {
        entries: []
      },
      workingSet: cachedWorkingSet,
      closedTabs: []
    }
  }

  ;(globalThis as any).window = {
    LOCAL_CUSTOM_GROUPS: [],
    LOCAL_PATH_GROUPERS: []
  }
  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
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
          records: {
            'https://example.com/app': activityRecord('https://example.com/app', 'Live App', now),
            'https://example.com/docs': activityRecord('https://example.com/docs', 'Live Docs', now - 1),
            'https://example.com/report': activityRecord('https://example.com/report', 'Live Report', now - 2)
          }
        }
      })
    },
    tabs: {
      query: async () => liveTabs
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: {
      query: async () => []
    },
    sessions: {
      getRecentlyClosed: async () => []
    },
    storage: {
      session: {
        get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: existingCache }),
        set: async (value: Record<string, unknown>) => {
          cachedStartupSnapshot = value
        }
      },
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

  assert.deepEqual(snapshot.dashboard.realTabs.map((tab) => tab.url), liveTabs.map((tab) => tab.url))
  assert.equal(snapshot.workingSet.items[0]?.tabUrl, 'https://example.com/app')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const cachedSnapshot = cachedStartupSnapshot?.[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any
  assert.deepEqual(cachedSnapshot?.snapshot.dashboard.realTabs.map((tab: any) => tab.url), liveTabs.map((tab) => tab.url))
  assert.deepEqual(cachedSnapshot?.snapshot.workingSet.items.map((item: any) => item.tabUrl), ['https://example.com/docs'])
  assert.equal(cachedSnapshot?.workingSetSavedAt, now)

  cachedStartupSnapshot = null
  existingCache.workingSetSavedAt = Date.now() - (DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS + 1)
  await fetchDashboardStartupSnapshot({
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

  await new Promise((resolve) => setTimeout(resolve, 0))
  const refreshedCache = cachedStartupSnapshot?.[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any
  assert.deepEqual(refreshedCache?.snapshot.workingSet.items.map((item: any) => item.tabUrl), [
    'https://example.com/app',
    'https://example.com/docs',
    'https://example.com/report'
  ])
  assert.ok(refreshedCache?.workingSetSavedAt > existingCache.workingSetSavedAt)
})

test('startup path reads ordering before saved pages without losing saved rows', async () => {
  const storageGetKeys: unknown[] = []
  const savedPageUrl = 'https://saved.example/report'
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.test/report', 'Example Report')
  ]

  ;(globalThis as any).window = {
    LOCAL_CUSTOM_GROUPS: [],
    LOCAL_PATH_GROUPERS: []
  }
  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
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
        workingSetActivity: { version: 1, records: {} }
      })
    },
    tabs: {
      query: async () => openTabs
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: {
      query: async () => []
    },
    sessions: {
      getRecentlyClosed: async () => []
    },
    storage: {
      local: {
        get: async (keys: unknown) => {
          storageGetKeys.push(keys)
          return {
            [DOMAIN_PIN_STORAGE_KEY]: ['example.test'],
            [SAVED_PAGES_STORAGE_KEY]: {
              version: 1,
              pages: {
                [savedPageUrl]: {
                  key: savedPageUrl,
                  url: savedPageUrl,
                  title: 'Saved Report',
                  savedAt: now,
                  updatedAt: now
                }
              }
            }
          }
        }
      }
    }
  }

  const localState = await loadDashboardLocalState()
  const snapshot = await fetchDashboardStartupSnapshot({
    source: 'tabs',
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: localState.pinnedDomains,
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  })

  assert.deepEqual(storageGetKeys, [[
    DOMAIN_PIN_STORAGE_KEY,
    SECTION_PIN_STORAGE_KEY,
    PAGE_CHIP_PIN_STORAGE_KEY
  ], SAVED_PAGES_STORAGE_KEY])
  assert.equal(snapshot.dashboard.domainGroups[0]?.domain, 'example.test')
  assert.ok(snapshot.dashboard.realTabs.some((tab) => tab.url === savedPageUrl && tab.closedSaved))
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
