import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatestRefreshRunner, DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS, DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS, fetchDashboardSnapshot, fetchDashboardStartupSnapshot, loadCachedDashboardStartup, loadCachedDashboardStartupSnapshot } from '../src/hooks/useDashboardRefresh.js'
import { loadDashboardLocalState, loadDashboardLocalStateResult } from '../src/hooks/useDashboardLocalState.js'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import { DEFAULT_HISTORY_RANGE } from '../src/extension/history-source.js'
import { PAGE_CHIP_PIN_STORAGE_KEY, pageChipPinId, pageChipPinKeyForUrl, pageChipPinScopeId } from '../src/extension/page-chip-pins.js'
import { SAVED_PAGES_STORAGE_KEY } from '../src/extension/saved-pages.js'
import { SECTION_PIN_STORAGE_KEY, subdomainPinId } from '../src/extension/section-pins.js'
import { saveCachedDashboardStartupSnapshot } from '../src/extension/startup-snapshot.js'
import { addCurrentTabOutPageToStartupSnapshot } from '../src/extension/startup-view-model.js'
import { makeChromeTab } from './helpers/chrome-tab.js'

const now = Date.now()

test('dashboard local state distinguishes a storage read failure from an empty store', async () => {
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: async () => { throw new Error('storage unavailable') }
      }
    }
  }

  const result = await loadDashboardLocalStateResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.state, {
    loaded: true,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  })
})

test('dashboard local state rejects malformed pin storage instead of clearing warm state', async () => {
  ;(globalThis as any).chrome = {
    storage: {
      local: {
        get: async () => ({ [DOMAIN_PIN_STORAGE_KEY]: {} })
      }
    }
  }

  const result = await loadDashboardLocalStateResult()

  assert.equal(result.ok, false)
  assert.deepEqual(result.state.pinnedDomains, [])
})

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

function workingSetSnapshotItem(url: string, title: string, score: number, tabId = 1) {
  return {
    key: url,
    tabId,
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

function startupCacheSnapshot(domain: string) {
  return {
    dashboard: { realTabs: [], domainGroups: [{ domain, tabs: [] }] },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
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
    snapshot: {
      ...snapshot,
      startupViewModel: {
        pinnedPageChipIds: [],
        pinnedSectionIds: [],
        viewModel: { matchedCards: [], unmatchedCards: [] }
      }
    }
  }
  assert.equal((await loadCachedDashboardStartup())?.snapshot.startupViewModel, undefined)

  cached = {
    savedAt: now,
    snapshot: { dashboard: {} }
  }
  assert.equal(await loadCachedDashboardStartup(), null)
})

test('startup snapshot cache drops working set rows not backed by its cached open tabs', async () => {
  const openUrl = 'https://example.com/docs'
  const closedUrl = 'https://closed.example.com/old'
  const closedSavedUrl = 'https://saved.example.com/kept'
  const cached = {
    savedAt: now,
    snapshot: {
      dashboard: {
        realTabs: [
          {
            id: 1,
            url: openUrl,
            rawUrl: openUrl,
            suspended: false,
            title: 'Live Docs',
            favIconUrl: '',
            windowId: 1,
            active: true,
            pinned: false,
            groupId: -1,
            isTabOut: false,
            isApp: false
          },
          {
            url: closedSavedUrl,
            rawUrl: closedSavedUrl,
            suspended: false,
            title: 'Kept Saved Page',
            favIconUrl: '',
            windowId: -1,
            active: false,
            pinned: false,
            groupId: -1,
            isTabOut: false,
            isApp: false,
            sourceType: 'saved-page',
            closedSaved: true
          }
        ],
        domainGroups: []
      },
      tabHistory: {
        entries: []
      },
      workingSet: {
        defaultLimit: 3,
        expandedLimit: 7,
        items: [
          workingSetSnapshotItem(openUrl, 'Cached Docs', 999, 99),
          workingSetSnapshotItem(closedUrl, 'Closed Example', 500, 98),
          workingSetSnapshotItem(closedSavedUrl, 'Kept Saved Page', 400, 97)
        ]
      },
      closedTabs: []
    }
  }

  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: cached })
      },
      local: {
        get: async () => ({})
      }
    }
  }

  const restored = await loadCachedDashboardStartup()
  assert.deepEqual(restored?.snapshot.workingSet.items.map((item) => item.tabUrl), [openUrl])
})

test('startup snapshot cache falls back to the durable local snapshot when the session copy is gone', async () => {
  const localGetKeys: unknown[] = []
  let livePinStorage: Record<string, unknown> = {
    [DOMAIN_PIN_STORAGE_KEY]: ['example.test'],
    [SECTION_PIN_STORAGE_KEY]: ['section-alpha'],
    [PAGE_CHIP_PIN_STORAGE_KEY]: ['chip-alpha']
  }
  const durableCached: Record<string, unknown> = {
    savedAt: now,
    snapshot: {
      dashboard: {
        realTabs: [],
        domainGroups: [
          { domain: 'stale.example', pinned: true, tabs: [] },
          { domain: 'example.test', pinned: false, tabs: [] }
        ]
      },
      tabHistory: { entries: [] },
      workingSet: { items: [] },
      closedTabs: [],
      startupViewModel: {
        pinnedDomains: ['stale.example'],
        pinnedSectionIds: ['section-stale'],
        pinnedPageChipIds: ['chip-stale'],
        viewModel: {
          source: 'tabs',
          stats: {},
          matchedCards: [],
          unmatchedCards: [],
          showOtherTabs: false,
          globalDedupeUrls: [],
          filteredCloseUrls: [],
          filteredCloseTargets: []
        }
      }
    },
    localState: {
      loaded: true,
      pinnedDomains: ['stale.example'],
      pinnedSectionIds: ['section-stale'],
      pinnedPageChipIds: ['chip-stale']
    }
  }

  ;(globalThis as any).chrome = {
    storage: {
      session: { get: async () => ({}) },
      local: {
        get: async (keys: unknown) => {
          localGetKeys.push(keys)
          return {
            [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: durableCached,
            ...livePinStorage
          }
        }
      }
    }
  }

  // Session cleared by a browser restart, durable copy still fresh → first open paints warm
  // while the separately stored live pin keys remain the ordering source of truth.
  const restored = await loadCachedDashboardStartup(now)
  assert.deepEqual(restored?.localState?.pinnedDomains, ['example.test'])
  assert.deepEqual(
    restored?.snapshot.dashboard.domainGroups.map((group) => [group.domain, group.pinned]),
    [['example.test', true], ['stale.example', false]]
  )
  assert.equal(restored?.snapshot.startupViewModel, undefined)
  assert.deepEqual(localGetKeys, [[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY, DOMAIN_PIN_STORAGE_KEY, SECTION_PIN_STORAGE_KEY, PAGE_CHIP_PIN_STORAGE_KEY]])

  livePinStorage = {
    ...livePinStorage,
    [DOMAIN_PIN_STORAGE_KEY]: { corrupted: true }
  }
  const restoredWithMalformedPins = await loadCachedDashboardStartup(now)
  assert.deepEqual(restoredWithMalformedPins?.localState?.pinnedDomains, ['stale.example'])
  assert.deepEqual(
    restoredWithMalformedPins?.snapshot.dashboard.domainGroups.map((group) => [group.domain, group.pinned]),
    [['stale.example', true], ['example.test', false]]
  )

  // A durable copy older than the cap is ignored rather than shown very stale.
  durableCached.savedAt = now - (DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS + 1)
  assert.equal(await loadCachedDashboardStartup(now), null)
})

test('startup snapshot cache overlays live pins after choosing an equal-generation session mirror', async () => {
  const liveSectionPin = subdomainPinId('live.example', 'www')
  const livePagePin = pageChipPinId(
    'tabs',
    pageChipPinScopeId('live.example', 'www', '', ''),
    pageChipPinKeyForUrl('https://live.example/')
  )
  const cached = {
    savedAt: now,
    captureStartedAt: now,
    snapshot: {
      dashboard: {
        realTabs: [],
        domainGroups: [
          { domain: 'stale.example', pinned: true, tabs: [] },
          { domain: 'live.example', pinned: false, tabs: [] }
        ]
      },
      tabHistory: { entries: [] },
      workingSet: { items: [] },
      closedTabs: [],
      startupViewModel: {
        pinnedDomains: ['stale.example'],
        pinnedSectionIds: ['section-stale'],
        pinnedPageChipIds: ['chip-stale'],
        viewModel: {
          source: 'tabs',
          stats: {},
          matchedCards: [],
          unmatchedCards: [],
          showOtherTabs: false,
          globalDedupeUrls: [],
          filteredCloseUrls: [],
          filteredCloseTargets: []
        }
      }
    },
    localState: {
      loaded: true,
      pinnedDomains: ['stale.example'],
      pinnedSectionIds: ['section-stale'],
      pinnedPageChipIds: ['chip-stale']
    }
  }
  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: cached })
      },
      local: {
        get: async () => ({
          [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: structuredClone(cached),
          [DOMAIN_PIN_STORAGE_KEY]: ['live.example'],
          [SECTION_PIN_STORAGE_KEY]: [liveSectionPin],
          [PAGE_CHIP_PIN_STORAGE_KEY]: [livePagePin]
        })
      }
    }
  }

  const restored = await loadCachedDashboardStartup(now)

  assert.deepEqual(restored?.localState, {
    loaded: true,
    pinnedDomains: ['live.example'],
    pinnedSectionIds: [liveSectionPin],
    pinnedPageChipIds: [livePagePin]
  })
  assert.deepEqual(
    restored?.snapshot.dashboard.domainGroups.map((group) => [group.domain, group.pinned]),
    [['live.example', true], ['stale.example', false]]
  )
  assert.equal(restored?.snapshot.startupViewModel, undefined)
})

test('startup snapshot cache applies live local pins to a session-only mirror', async () => {
  const cached = {
    savedAt: now,
    snapshot: {
      dashboard: {
        realTabs: [],
        domainGroups: [
          { domain: 'stale.example', pinned: true, tabs: [] },
          { domain: 'live.example', pinned: false, tabs: [] }
        ]
      },
      tabHistory: { entries: [] },
      workingSet: { items: [] },
      closedTabs: []
    },
    localState: {
      loaded: true,
      pinnedDomains: ['stale.example'],
      pinnedSectionIds: [],
      pinnedPageChipIds: []
    }
  }
  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: cached })
      },
      local: {
        get: async () => ({
          [DOMAIN_PIN_STORAGE_KEY]: ['live.example'],
          [SECTION_PIN_STORAGE_KEY]: [],
          [PAGE_CHIP_PIN_STORAGE_KEY]: []
        })
      }
    }
  }

  const restored = await loadCachedDashboardStartup(now)

  assert.deepEqual(restored?.localState?.pinnedDomains, ['live.example'])
  assert.deepEqual(
    restored?.snapshot.dashboard.domainGroups.map((group) => [group.domain, group.pinned]),
    [['live.example', true], ['stale.example', false]]
  )
})

test('startup snapshot cache rejects malformed nested dashboard groups before first-paint repair', async () => {
  const malformedCached = {
    savedAt: now,
    snapshot: {
      dashboard: { realTabs: [], domainGroups: [{}] },
      tabHistory: { entries: [] },
      workingSet: { items: [] },
      closedTabs: []
    }
  }
  ;(globalThis as any).chrome = {
    storage: {
      session: { get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: malformedCached }) },
      local: { get: async () => ({}) }
    }
  }

  assert.equal(await loadCachedDashboardStartup(now), null)
})

test('startup snapshot cache rejects malformed cached dashboard tabs before first-paint repair', async () => {
  const url = 'https://example.test/docs'
  const malformedTab = {
    id: 1,
    url,
    rawUrl: url,
    suspended: false,
    title: { unexpected: true },
    favIconUrl: '',
    windowId: 1,
    active: true,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false
  }
  const malformedCached = {
    savedAt: now,
    snapshot: {
      dashboard: {
        realTabs: [malformedTab],
        domainGroups: [{ domain: 'example.test', tabs: [malformedTab] }]
      },
      tabHistory: { entries: [] },
      workingSet: { items: [] },
      closedTabs: []
    }
  }
  ;(globalThis as any).chrome = {
    storage: {
      session: { get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: malformedCached }) },
      local: { get: async () => ({}) }
    }
  }

  assert.equal(await loadCachedDashboardStartup(now), null)
})

test('startup snapshot cache drops malformed nested startup view-model sections', async () => {
  const cached = {
    savedAt: now,
    snapshot: {
      dashboard: {
        realTabs: [],
        domainGroups: [{ domain: 'example.test', tabs: [] }]
      },
      tabHistory: { entries: [] },
      workingSet: { items: [] },
      closedTabs: [],
      startupViewModel: {
        pinnedDomains: [],
        pinnedSectionIds: [],
        pinnedPageChipIds: [],
        viewModel: {
          source: 'tabs',
          stats: {
            totalTabs: 0,
            activeTabs: 0,
            visibleTabs: 0,
            totalWindows: 0,
            visibleWindows: 0,
            totalDomains: 1,
            visibleDomains: 1,
            dedupCount: 0,
            filteredCloseCount: 0,
            hasCards: true,
            filtering: false
          },
          matchedCards: [{
            group: { domain: 'example.test', tabs: [] },
            vm: {
              stableId: 'domain-example-test',
              isHidden: false,
              displayMode: 'normal',
              filtering: false,
              sections: [null]
            }
          }],
          unmatchedCards: [],
          showOtherTabs: false,
          globalDedupeUrls: [],
          filteredCloseUrls: [],
          filteredCloseTargets: []
        }
      }
    }
  }
  ;(globalThis as any).chrome = {
    storage: {
      session: { get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: cached }) },
      local: { get: async () => ({}) }
    }
  }

  const restored = await loadCachedDashboardStartup(now)

  assert.deepEqual(restored?.snapshot.dashboard.domainGroups.map((group) => group.domain), ['example.test'])
  assert.equal(restored?.snapshot.startupViewModel, undefined)
})

test('startup snapshot cache repairs legacy colliding domain card ids', async () => {
  const group = { domain: 'foo_bar.test', tabs: [] }
  const cached = {
    savedAt: now,
    snapshot: {
      dashboard: { realTabs: [], domainGroups: [group] },
      tabHistory: { entries: [] },
      workingSet: { items: [] },
      closedTabs: [],
      startupViewModel: {
        pinnedDomains: [],
        pinnedSectionIds: [],
        pinnedPageChipIds: [],
        viewModel: {
          source: 'tabs',
          stats: {
            totalTabs: 0,
            activeTabs: 0,
            visibleTabs: 0,
            totalWindows: 0,
            visibleWindows: 0,
            totalDomains: 1,
            visibleDomains: 1,
            dedupCount: 0,
            filteredCloseCount: 0,
            hasCards: true,
            filtering: false
          },
          matchedCards: [{
            group,
            vm: {
              stableId: 'domain-foo-bar-test',
              isHidden: false,
              displayMode: 'normal',
              filtering: false,
              sections: [{
                key: 'root',
                sectionCount: 0,
                sectionClosableUrls: [],
                showHeader: false,
                isShared: false,
                hasFlat: false,
                flatVisibleChips: [],
                flatHiddenChips: [],
                flatHiddenCount: 0,
                clusters: [],
                websitePathSections: []
              }]
            }
          }],
          unmatchedCards: [],
          showOtherTabs: false,
          globalDedupeUrls: [],
          filteredCloseUrls: [],
          filteredCloseTargets: []
        }
      }
    }
  }
  ;(globalThis as any).chrome = {
    storage: {
      session: { get: async () => ({ [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: cached }) },
      local: { get: async () => ({}) }
    }
  }

  const restored = await loadCachedDashboardStartup(now)

  assert.equal(restored?.snapshot.startupViewModel?.viewModel.matchedCards[0]?.vm.stableId, 'domain-foo_bar.test')
})

test('startup snapshot cache compares both copies and performs its dual write inside the shared lock', async () => {
  const snapshot = {
    dashboard: { realTabs: [], domainGroups: [] },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
  const sessionStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: {
      savedAt: 50,
      captureStartedAt: 50,
      snapshot
    }
  }
  const durableStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: {
      savedAt: 200,
      captureStartedAt: 200,
      snapshot
    }
  }
  let lockHeld = false
  const requestedLocks: string[] = []
  let cacheWrites = 0
  const previousLocksDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: {
      request: async (name: string, mutation: () => Promise<unknown>) => {
        requestedLocks.push(name)
        assert.equal(lockHeld, false)
        lockHeld = true
        try {
          return await mutation()
        } finally {
          lockHeld = false
        }
      }
    }
  })

  const storageArea = (store: Record<string, unknown>) => ({
    get: async () => {
      assert.equal(lockHeld, true)
      return store
    },
    set: async (value: Record<string, unknown>) => {
      assert.equal(lockHeld, true)
      cacheWrites += 1
      Object.assign(store, value)
    }
  })
  ;(globalThis as any).chrome = {
    storage: {
      session: storageArea(sessionStore),
      local: storageArea(durableStore)
    }
  }

  try {
    await saveCachedDashboardStartupSnapshot(snapshot, null, {
      captureStartedAt: 100,
      now: 300
    })
    assert.equal(cacheWrites, 0, 'a newer durable capture blocks both cache writes')

    await saveCachedDashboardStartupSnapshot(snapshot, null, {
      captureStartedAt: 300,
      now: 400
    })
    assert.equal(cacheWrites, 2)
    assert.equal((sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 300)
    assert.equal((durableStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 300)
    assert.deepEqual(requestedLocks, [
      'tab-out:startup-snapshot-cache-write',
      'tab-out:startup-snapshot-cache-write'
    ])
  } finally {
    if (previousLocksDescriptor) {
      Object.defineProperty(globalThis.navigator, 'locks', previousLocksDescriptor)
    } else {
      delete (globalThis.navigator as { locks?: unknown }).locks
    }
  }
})

test('startup snapshot cache skips timestamp and score-only generations', async () => {
  const sessionStore: Record<string, unknown> = {}
  const durableStore: Record<string, unknown> = {}
  let cacheWrites = 0
  const storageArea = (store: Record<string, unknown>) => ({
    get: async () => store,
    set: async (value: Record<string, unknown>) => {
      cacheWrites += 1
      Object.assign(store, value)
    }
  })
  ;(globalThis as any).chrome = {
    storage: {
      session: storageArea(sessionStore),
      local: storageArea(durableStore)
    }
  }
  const firstSnapshot = startupCacheSnapshot('example.com')
  firstSnapshot.workingSet = {
    defaultLimit: 3,
    expandedLimit: 7,
    items: [workingSetSnapshotItem('https://example.com/docs', 'Example Docs', 100)]
  }

  await saveCachedDashboardStartupSnapshot(firstSnapshot, null, {
    captureStartedAt: 100,
    now: 150
  })
  assert.equal(cacheWrites, 2)

  const scoreOnlySnapshot = structuredClone(firstSnapshot)
  scoreOnlySnapshot.workingSet.items[0].score = 50
  await saveCachedDashboardStartupSnapshot(scoreOnlySnapshot, null, {
    captureStartedAt: 200,
    now: 250
  })
  assert.equal(cacheWrites, 2, 'volatile timestamps and score decay do not write a new generation')

  const changedSnapshot = structuredClone(scoreOnlySnapshot)
  changedSnapshot.workingSet.items[0].title = 'Renamed Docs'
  await saveCachedDashboardStartupSnapshot(changedSnapshot, null, {
    captureStartedAt: 300,
    now: 350
  })
  assert.equal(cacheWrites, 4, 'visible row changes still update both cache mirrors')
})

test('startup snapshot cache keeps session warm while rate-limiting durable generations', async () => {
  const sessionStore: Record<string, unknown> = {}
  const durableStore: Record<string, unknown> = {}
  let sessionWrites = 0
  let durableWrites = 0
  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => sessionStore,
        set: async (value: Record<string, unknown>) => {
          sessionWrites += 1
          Object.assign(sessionStore, value)
        }
      },
      local: {
        get: async () => durableStore,
        set: async (value: Record<string, unknown>) => {
          durableWrites += 1
          Object.assign(durableStore, value)
        }
      }
    }
  }
  const durableWriteIntervalMs = 5 * 60_000

  await saveCachedDashboardStartupSnapshot(startupCacheSnapshot('first.example'), null, {
    captureStartedAt: 100,
    durableWriteIntervalMs,
    now: 100
  })
  assert.equal(sessionWrites, 1)
  assert.equal(durableWrites, 1, 'a missing durable mirror is initialized immediately')

  await saveCachedDashboardStartupSnapshot(startupCacheSnapshot('latest.example'), null, {
    captureStartedAt: 1000,
    durableWriteIntervalMs,
    now: 1000
  })
  assert.equal(sessionWrites, 2)
  assert.equal(durableWrites, 1)
  assert.equal(
    ((sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).snapshot.dashboard.domainGroups[0] as any).domain,
    'latest.example'
  )
  assert.equal(
    ((durableStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).snapshot.dashboard.domainGroups[0] as any).domain,
    'first.example'
  )

  await saveCachedDashboardStartupSnapshot(startupCacheSnapshot('latest.example'), null, {
    captureStartedAt: 300_100,
    durableWriteIntervalMs,
    now: 300_100
  })
  assert.equal(sessionWrites, 2, 'promotion does not rewrite an already-current session mirror')
  assert.equal(durableWrites, 2)
  assert.equal(
    ((durableStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).snapshot.dashboard.domainGroups[0] as any).domain,
    'latest.example'
  )
})

test('startup snapshot cache uses a newer durable generation when the session write fails', async () => {
  const oldSnapshot = startupCacheSnapshot('old.example')
  const newSnapshot = startupCacheSnapshot('new.example')
  const oldPayload = {
    savedAt: 100,
    captureStartedAt: 100,
    snapshot: oldSnapshot
  }
  const sessionStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: oldPayload
  }
  const durableStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: oldPayload
  }

  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => sessionStore,
        set: async () => { throw new Error('session write unavailable') },
        remove: async () => { throw new Error('session cleanup unavailable') }
      },
      local: {
        get: async () => durableStore,
        set: async (value: Record<string, unknown>) => { Object.assign(durableStore, value) }
      }
    }
  }

  await saveCachedDashboardStartupSnapshot(newSnapshot, null, {
    captureStartedAt: 300,
    now: 400
  })

  assert.equal((sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 100)
  assert.equal((durableStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 300)
  assert.equal((await loadCachedDashboardStartup(400))?.snapshot.dashboard.domainGroups[0]?.domain, 'new.example')

  // A restart clears session storage; the same newest durable generation remains warm.
  delete sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  assert.equal((await loadCachedDashboardStartup(400))?.snapshot.dashboard.domainGroups[0]?.domain, 'new.example')
})

test('startup snapshot cache compares legacy mirrors by saved time', async () => {
  const sessionStore = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: {
      savedAt: 100,
      snapshot: startupCacheSnapshot('old.example')
    }
  }
  const durableStore = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: {
      savedAt: 200,
      snapshot: startupCacheSnapshot('new.example')
    }
  }

  ;(globalThis as any).chrome = {
    storage: {
      session: { get: async () => sessionStore },
      local: { get: async () => durableStore }
    }
  }

  assert.equal((await loadCachedDashboardStartup(300))?.snapshot.dashboard.domainGroups[0]?.domain, 'new.example')
})

test('startup snapshot cache removes a stale durable mirror before advancing session', async () => {
  const oldSnapshot = startupCacheSnapshot('old.example')
  const newSnapshot = startupCacheSnapshot('new.example')
  const oldPayload = {
    savedAt: 100,
    captureStartedAt: 100,
    snapshot: oldSnapshot
  }
  const sessionStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: oldPayload
  }
  const durableStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: oldPayload
  }
  let durableSetAttempts = 0

  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => sessionStore,
        set: async (value: Record<string, unknown>) => { Object.assign(sessionStore, value) }
      },
      local: {
        get: async () => durableStore,
        set: async () => {
          durableSetAttempts += 1
          throw new Error('durable write unavailable')
        },
        remove: async (key: string) => { delete durableStore[key] }
      }
    }
  }

  await saveCachedDashboardStartupSnapshot(newSnapshot, null, {
    captureStartedAt: 300,
    now: 400
  })

  assert.equal(durableSetAttempts, 2, 'the durable mirror gets one compact retry')
  assert.equal((sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 300)
  assert.equal(durableStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY], undefined)
  assert.equal((await loadCachedDashboardStartup(400))?.snapshot.dashboard.domainGroups[0]?.domain, 'new.example')

  // After restart, an absent durable mirror yields no warm cache instead of reviving old data.
  delete sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]
  assert.equal(await loadCachedDashboardStartup(400), null)
})

test('startup snapshot cache keeps both old mirrors when a failed durable write cannot be cleaned up', async () => {
  const snapshot = {
    dashboard: { realTabs: [], domainGroups: [] },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
  const oldPayload = {
    savedAt: 100,
    captureStartedAt: 100,
    snapshot
  }
  const sessionStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: oldPayload
  }
  const durableStore: Record<string, unknown> = {
    [DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY]: oldPayload
  }
  let sessionWrites = 0

  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => sessionStore,
        set: async () => { sessionWrites += 1 }
      },
      local: {
        get: async () => durableStore,
        set: async () => { throw new Error('durable write unavailable') },
        remove: async () => { throw new Error('durable cleanup unavailable') }
      }
    }
  }

  await saveCachedDashboardStartupSnapshot(snapshot, null, {
    captureStartedAt: 300,
    now: 400
  })

  assert.equal(sessionWrites, 0)
  assert.equal((sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 100)
  assert.equal((durableStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 100)
})

test('startup snapshot cache serializes writes in-context before requesting the shared lock', async () => {
  const firstSnapshot = startupCacheSnapshot('first.example')
  const latestSnapshot = startupCacheSnapshot('latest.example')
  const sessionStore: Record<string, unknown> = {}
  const durableStore: Record<string, unknown> = {}
  let releaseFirstRead!: () => void
  let markFirstReadStarted!: () => void
  const firstReadBlocked = new Promise<void>((resolve) => { releaseFirstRead = resolve })
  const firstReadStarted = new Promise<void>((resolve) => { markFirstReadStarted = resolve })
  let sessionReads = 0

  ;(globalThis as any).chrome = {
    storage: {
      session: {
        get: async () => {
          sessionReads += 1
          if (sessionReads === 1) {
            markFirstReadStarted()
            await firstReadBlocked
          }
          return sessionStore
        },
        set: async (value: Record<string, unknown>) => { Object.assign(sessionStore, value) }
      },
      local: {
        get: async () => durableStore,
        set: async (value: Record<string, unknown>) => { Object.assign(durableStore, value) }
      }
    }
  }

  const firstSave = saveCachedDashboardStartupSnapshot(firstSnapshot, null, {
    captureStartedAt: 100,
    now: 150
  })
  await firstReadStarted
  const latestSave = saveCachedDashboardStartupSnapshot(latestSnapshot, null, {
    captureStartedAt: 200,
    now: 250
  })
  await Promise.resolve()
  assert.equal(sessionReads, 1, 'the local queue keeps the second mutation outside storage')

  releaseFirstRead()
  await Promise.all([firstSave, latestSave])

  assert.equal((sessionStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 200)
  assert.equal((durableStore[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any).captureStartedAt, 200)
})

test('startup snapshot can include the current Tab Out page before live hydration', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const oldTabOutPage = {
    id: 2,
    url: tabOutUrl,
    rawUrl: tabOutUrl,
    suspended: false,
    title: 'Tab Out',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: true,
    isApp: false,
    index: 1
  }
  const snapshot = {
    dashboard: {
      realTabs: [oldTabOutPage],
      domainGroups: [{ domain: '__tab-out__', label: 'New tabs', tabs: [oldTabOutPage] }],
      currentWindowId: 1
    },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
  const currentTab = {
    ...makeChromeTab(3, tabOutUrl, 'Tab Out'),
    active: true,
    selected: true
  }
  const localState = {
    loaded: true,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  }

  const patched = addCurrentTabOutPageToStartupSnapshot(snapshot, currentTab, localState)

  assert.equal(patched.dashboard.realTabs.length, 2)
  assert.equal(patched.dashboard.domainGroups.find((group) => group.domain === '__tab-out__')?.tabs.length, 2)
  assert.equal(patched.startupViewModel?.viewModel.stats.totalTabs, 2)
  assert.equal(patched.startupViewModel?.viewModel.stats.dedupCount, 1)
})

test('startup snapshot rebases its current window when the current Tab Out page is already cached', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const currentTabOutPage = {
    id: 3,
    url: tabOutUrl,
    rawUrl: tabOutUrl,
    suspended: false,
    title: 'Tab Out',
    favIconUrl: '',
    windowId: 1,
    active: true,
    pinned: false,
    groupId: -1,
    isTabOut: true,
    isApp: false,
    index: 1
  }
  const snapshot = {
    dashboard: {
      realTabs: [currentTabOutPage],
      domainGroups: [{ domain: '__tab-out__', label: 'New tabs', tabs: [currentTabOutPage] }],
      currentWindowId: 2
    },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
  const currentTab = {
    ...makeChromeTab(3, tabOutUrl, 'Tab Out'),
    active: true,
    selected: true,
    windowId: 1
  }
  const localState = {
    loaded: true,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  }

  const patched = addCurrentTabOutPageToStartupSnapshot(snapshot, currentTab, localState)

  assert.equal(patched.dashboard.currentWindowId, 1)
  assert.ok(patched.startupViewModel)
})

test('startup snapshot refreshes stale state for an already-cached current Tab Out page', () => {
  const cachedUrl = 'chrome-extension://tab-out/index.html'
  const currentUrl = `${cachedUrl}?filter=example`
  const cachedTabOutPage = {
    id: 3,
    url: cachedUrl,
    rawUrl: cachedUrl,
    suspended: false,
    title: 'Tab Out',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: true,
    isApp: false,
    index: 1
  }
  const snapshot = {
    dashboard: {
      realTabs: [cachedTabOutPage],
      domainGroups: [{ domain: '__tab-out__', label: 'New tabs', tabs: [cachedTabOutPage] }],
      currentWindowId: 1
    },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
  const currentTab = {
    ...makeChromeTab(3, currentUrl, 'Tab Out'),
    active: true,
    selected: true,
    pinned: true,
    windowId: 1
  }
  const localState = {
    loaded: true,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  }

  const patched = addCurrentTabOutPageToStartupSnapshot(snapshot, currentTab, localState)
  const restoredTab = patched.dashboard.realTabs[0]
  assert.ok(restoredTab)

  assert.equal(restoredTab.rawUrl, currentUrl)
  assert.equal(restoredTab.active, true)
  assert.equal(restoredTab.pinned, true)
  assert.equal(patched.dashboard.domainGroups[0]?.tabs[0], restoredTab)
  assert.ok(patched.startupViewModel)
})

test('startup snapshot preserves New tabs pin when adding the current Tab Out page', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const exampleTab = {
    id: 2,
    url: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs',
    suspended: false,
    title: 'Example Docs',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    index: 1
  }
  const snapshot = {
    dashboard: {
      realTabs: [exampleTab],
      domainGroups: [{ domain: 'example.com', pinned: false, tabs: [exampleTab] }],
      currentWindowId: 1
    },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
  const currentTab = {
    ...makeChromeTab(3, tabOutUrl, 'Tab Out'),
    active: true,
    selected: true
  }
  const localState = {
    loaded: true,
    pinnedDomains: ['__tab-out__'],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  }

  const patched = addCurrentTabOutPageToStartupSnapshot(snapshot, currentTab, localState)
  const newTabsGroup = patched.dashboard.domainGroups.find((group) => group.domain === '__tab-out__')

  assert.equal(newTabsGroup?.pinned, true)
  assert.deepEqual(
    patched.dashboard.domainGroups.map((group) => group.domain),
    ['__tab-out__', 'example.com']
  )
  assert.equal(patched.startupViewModel?.viewModel.matchedCards[0]?.group.domain, '__tab-out__')
})

test('startup snapshot removes a prior-session web tab when its id is reused by the current Tab Out page', () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const staleWebTab = {
    id: 7,
    url: 'https://example.test/stale',
    rawUrl: 'https://example.test/stale',
    suspended: false,
    title: 'Stale page',
    favIconUrl: '',
    windowId: 4,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    index: 0
  }
  const snapshot = {
    dashboard: {
      realTabs: [staleWebTab],
      domainGroups: [{ domain: 'example.test', tabs: [staleWebTab] }],
      currentWindowId: 4
    },
    tabHistory: { entries: [] },
    workingSet: { items: [] },
    closedTabs: []
  } as any
  const currentTab = {
    ...makeChromeTab(7, tabOutUrl, 'Tab Out'),
    active: true,
    selected: true,
    windowId: 1
  }
  const localState = {
    loaded: true,
    pinnedDomains: [],
    pinnedSectionIds: [],
    pinnedPageChipIds: []
  }

  const patched = addCurrentTabOutPageToStartupSnapshot(snapshot, currentTab, localState)

  assert.deepEqual(patched.dashboard.realTabs.map((candidate) => candidate.url), [tabOutUrl])
  assert.deepEqual(patched.dashboard.domainGroups.map((group) => group.domain), ['__tab-out__'])
  const [tabOutGroup] = patched.dashboard.domainGroups
  assert.ok(tabOutGroup)
  assert.equal(tabOutGroup.tabs.length, 1)
  const [tabOutPage] = tabOutGroup.tabs
  assert.ok(tabOutPage)
  assert.equal(tabOutPage.id, 7)
})

test('page startup snapshot gathers one coherent view without writing the shared cache', async () => {
  let tabsQueryCount = 0
  let windowsGetAllCount = 0
  let windowsGetCurrentCount = 0
  let tabGroupsQueryCount = 0
  let sessionsGetRecentlyClosedCount = 0
  let startupCacheWrites = 0
  const runtimeMessages: string[] = []
  const openTabs = [
    makeChromeTab(1, 'https://example.com/docs', 'Example Docs'),
    makeChromeTab(2, 'https://example.com/app', 'Example App'),
    makeChromeTab(3, 'https://example.test/report', 'Example Report'),
    makeChromeTab(4, 'chrome://extensions/', 'Extensions')
  ]
  const workingSetTabs = openTabs.filter((tab) => tab.url?.startsWith('https://'))

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async (message: { type?: string }) => {
        runtimeMessages.push(String(message.type || ''))
        if (message.type === 'tab-out:get-dashboard-service-state') {
          tabsQueryCount += 1
          windowsGetAllCount += 1
          return {
            ok: true,
            openTabsSnapshot: {
              tabs: openTabs,
              windows: [{ id: 1, focused: true, type: 'normal' }]
            },
            tabHistory: {
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
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      },
      local: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
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
  assert.equal(startupCacheWrites, 0)
  assert.deepEqual(runtimeMessages, ['tab-out:get-dashboard-service-state'])
})

test('coalesced page startup fetches share browser reads without writing the shared cache', async () => {
  let releaseTabsQuery!: () => void
  let markTabsQueryStarted!: () => void
  const tabsQueryBlocked = new Promise<void>((resolve) => {
    releaseTabsQuery = resolve
  })
  const tabsQueryStarted = new Promise<void>((resolve) => {
    markTabsQueryStarted = resolve
  })
  let tabsQueryCount = 0
  let startupCacheWrites = 0

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll()
        },
        tabHistory: {
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
        },
        workingSetActivity: { version: 1, records: {} }
      })
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        markTabsQueryStarted()
        await tabsQueryBlocked
        return []
      }
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      },
      local: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      }
    }
  }

  const baseOptions = {
    source: 'tabs' as const,
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }
  const firstFetch = fetchDashboardStartupSnapshot(baseOptions)
  await tabsQueryStarted
  const latestFetch = fetchDashboardStartupSnapshot(baseOptions)
  releaseTabsQuery()
  await Promise.all([firstFetch, latestFetch])

  assert.equal(tabsQueryCount, 1)
  assert.equal(startupCacheWrites, 0)
})

test('concurrent page startup fetches remain read-only when an older read finishes last', async () => {
  let releaseFirstTabsQuery!: () => void
  let markFirstTabsQueryStarted!: () => void
  const firstTabsQueryBlocked = new Promise<void>((resolve) => {
    releaseFirstTabsQuery = resolve
  })
  const firstTabsQueryStarted = new Promise<void>((resolve) => {
    markFirstTabsQueryStarted = resolve
  })
  let tabsQueryCount = 0
  let startupCacheWrites = 0

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll()
        },
        tabHistory: {
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
        },
        workingSetActivity: { version: 1, records: {} }
      })
    },
    tabs: {
      query: async () => {
        tabsQueryCount += 1
        if (tabsQueryCount === 1) {
          markFirstTabsQueryStarted()
          await firstTabsQueryBlocked
        }
        return []
      }
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }] as chrome.windows.Window[],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' }) as chrome.windows.Window
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      },
      local: {
        get: async () => ({}),
        set: async () => { startupCacheWrites += 1 }
      }
    }
  }

  const baseOptions = {
    source: 'tabs' as const,
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    previousOrder: {
      tabs: new Map(),
      bookmarks: new Map(),
      history: new Map()
    }
  }
  const firstFetch = fetchDashboardStartupSnapshot({
    ...baseOptions,
    pinnedDomains: ['first.example']
  })
  await firstTabsQueryStarted
  const latestFetch = fetchDashboardStartupSnapshot({
    ...baseOptions,
    pinnedDomains: ['latest.example']
  })

  await latestFetch
  releaseFirstTabsQuery()
  await firstFetch

  assert.equal(tabsQueryCount, 2)
  assert.equal(startupCacheWrites, 0)
})

test('latest refresh runner discards an overtaken result and applies one trailing result', async () => {
  let releaseFirstRun!: () => void
  let markFirstRunStarted!: () => void
  const firstRunBlocked = new Promise<void>((resolve) => {
    releaseFirstRun = resolve
  })
  const firstRunStarted = new Promise<void>((resolve) => {
    markFirstRunStarted = resolve
  })
  const runs: string[] = []
  const applied: string[] = []
  const runner = createLatestRefreshRunner<string>()

  const firstRequest = runner.request(
    async () => {
      runs.push('first')
      markFirstRunStarted()
      await firstRunBlocked
      return 'stale'
    },
    (value) => applied.push(value)
  )
  await firstRunStarted
  const latestRequest = runner.request(
    async () => {
      runs.push('latest')
      return 'latest'
    },
    (value) => applied.push(value)
  )
  releaseFirstRun()
  await Promise.all([firstRequest, latestRequest])

  assert.deepEqual(runs, ['first', 'latest'])
  assert.deepEqual(applied, ['latest'])
  assert.equal(runner.active(), false)
})

test('startup snapshot cache preserves fresh cached working set priority when saving live startup data', async () => {
  let cachedStartupSnapshot: Record<string, unknown> | null = null
  const cachedWorkingSet = {
    defaultLimit: 3,
    expandedLimit: 7,
    items: [
      workingSetSnapshotItem('https://example.com/docs', 'Cached Docs', 999, 99),
      workingSetSnapshotItem('https://closed.example.com/old', 'Closed Example', 500, 98)
    ]
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

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll()
        },
        tabHistory: {
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
        get: async () => ({}),
        set: async () => {}
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
  await saveCachedDashboardStartupSnapshot(snapshot, null, { now, captureStartedAt: now })
  const cachedSnapshot = cachedStartupSnapshot?.[DASHBOARD_STARTUP_SNAPSHOT_CACHE_KEY] as any
  assert.deepEqual(cachedSnapshot?.snapshot.dashboard.realTabs.map((tab: any) => tab.url), liveTabs.map((tab) => tab.url))
  assert.deepEqual(cachedSnapshot?.snapshot.workingSet.items.map((item: any) => item.tabUrl), ['https://example.com/docs'])
  assert.equal(cachedSnapshot?.snapshot.workingSet.items[0]?.tabId, 1)
  assert.equal(cachedSnapshot?.snapshot.workingSet.items[0]?.title, 'Live Docs')
  assert.equal(cachedSnapshot?.snapshot.workingSet.items[0]?.score, 999)
  assert.equal(cachedSnapshot?.workingSetSavedAt, now)

  cachedStartupSnapshot = null
  existingCache.workingSetSavedAt = Date.now() - (DASHBOARD_STARTUP_WORKING_SET_FREEZE_TTL_MS + 1)
  const refreshedSnapshot = await fetchDashboardStartupSnapshot({
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

  await saveCachedDashboardStartupSnapshot(refreshedSnapshot, null)
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

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: await chrome.tabs.query({}),
          windows: await chrome.windows.getAll()
        },
        tabHistory: {
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

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async (message: { type?: string }) => {
        runtimeMessages.push(String(message.type || ''))
        tabsQueryCount += 1
        windowsGetAllCount += 1
        return {
          ok: true,
          openTabsSnapshot: {
            tabs: openTabs,
            windows: [{ id: 1, focused: true, type: 'normal' }]
          },
          tabHistory: {
            stackSize: 1,
            maxSize: 48,
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
  assert.ok(snapshot.workingSet)
  assert.ok(snapshot.tabHistory)
  assert.equal(snapshot.workingSet.items.length, 0)
  assert.equal(snapshot.tabHistory.stackSize, 1)
  assert.equal(tabsQueryCount, 1)
  assert.equal(windowsGetAllCount, 1)
  assert.equal(windowsGetCurrentCount, 1)
  assert.deepEqual(runtimeMessages, ['tab-out:get-dashboard-service-state'])
})

test('tabs refresh rejects unknown required state instead of committing an empty replacement', async () => {
  const options = {
    source: 'tabs' as const,
    filter: '',
    historyRange: DEFAULT_HISTORY_RANGE,
    historyFilterEnabled: false,
    pinnedDomains: [],
    previousOrder: {
      tabs: new Map<string, number>(),
      bookmarks: new Map<string, number>(),
      history: new Map<string, number>()
    }
  }
  const openTabs = [makeChromeTab(1, 'https://example.test/keep', 'Keep')]
  const baseChrome = {
    runtime: {
      id: 'tab-out',
      getURL: (path: string) => `chrome-extension://tab-out${path}`,
      sendMessage: async () => ({
        ok: true,
        openTabsSnapshot: {
          tabs: openTabs,
          windows: [{ id: 1, focused: true, type: 'normal' }]
        },
        tabHistory: { entries: [], maxSize: 48 },
        workingSetActivity: { version: 1, records: {} }
      })
    },
    tabs: { query: async () => openTabs },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }],
      getCurrent: async () => ({ id: 1, focused: true, type: 'normal' })
    },
    tabGroups: { query: async () => [] },
    sessions: { getRecentlyClosed: async () => [] },
    storage: { local: { get: async () => ({}) } }
  }

  ;(globalThis as any).chrome = {
    ...baseChrome,
    runtime: {
      ...baseChrome.runtime,
      sendMessage: async () => { throw new Error('Service worker unavailable') }
    }
  }
  await assert.rejects(fetchDashboardSnapshot(options), /dashboard service state/)

  ;(globalThis as any).chrome = {
    ...baseChrome,
    storage: {
      local: {
        get: async () => { throw new Error('Saved Pages unavailable') }
      }
    }
  }
  await assert.rejects(fetchDashboardSnapshot(options), /Saved Pages/)

  ;(globalThis as any).chrome = {
    ...baseChrome,
    windows: {
      ...baseChrome.windows,
      getCurrent: async () => ({ focused: true, type: 'normal' })
    }
  }
  await assert.rejects(fetchDashboardSnapshot(options), /current browser window/)
  await assert.rejects(fetchDashboardStartupSnapshot(options), /current browser window/)
})

test('bookmarks refresh does not wait on hidden Activation History or Working Set state', async () => {
  let runtimeMessageCount = 0
  ;(globalThis as any).chrome = {
    runtime: {
      sendMessage: async () => {
        runtimeMessageCount += 1
        throw new Error('worker state unavailable')
      }
    },
    bookmarks: {
      getTree: async () => [{
        id: 'root',
        title: '',
        children: [{ id: 'bookmark-1', title: 'Example', url: 'https://example.test/' }]
      }]
    },
    storage: {
      local: { get: async () => ({}) }
    }
  }

  const snapshot = await fetchDashboardSnapshot({
    source: 'bookmarks',
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

  assert.equal(runtimeMessageCount, 0)
  assert.deepEqual(snapshot.dashboard.realTabs.map((tab) => tab.url), ['https://example.test/'])
  assert.equal(snapshot.tabHistory, undefined)
  assert.equal(snapshot.workingSet, undefined)
})
