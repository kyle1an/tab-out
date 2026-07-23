import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkingSetService, WORKING_SET_ACTIVITY_KEY } from '../src/extension/background/working-set-service.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStore } from '../src/extension/types'
import { emptyWorkingSetActivity, recordWorkingSetActivity } from '../src/extension/working-set.js'

function chromeTab(id: number, path: string, audio: { audible?: boolean; muted?: boolean } = {}): chrome.tabs.Tab {
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
    url: `https://example.test/${path}`,
    title: path,
    audible: audio.audible,
    mutedInfo: { muted: !!audio.muted }
  } as chrome.tabs.Tab
}

test('Working Set activity reads wait for mutations that started first', async () => {
  const now = Date.now()
  const tabs = [chromeTab(1, 'one'), chromeTab(2, 'two'), chromeTab(3, 'three')]
  let storedActivity: WorkingSetActivityStore = {
    version: 1,
    records: Object.fromEntries(tabs.slice(0, 2).map((tab, index) => {
      const url = tab.url as string
      const at = now - index * 1_000
      return [url, {
        key: url,
        url,
        title: tab.title || '',
        domain: 'example.test',
        lastSeenAt: at,
        lastActivatedAt: at,
        events: [{ kind: 'activation' as const, at }]
      }]
    }))
  }
  let releaseActivationQuery!: () => void
  let markActivationQueryStarted!: () => void
  const activationQueryBlocked = new Promise<void>((resolve) => {
    releaseActivationQuery = resolve
  })
  const activationQueryStarted = new Promise<void>((resolve) => {
    markActivationQueryStarted = resolve
  })
  let activationQuerySeen = false
  const chromeApi = {
    tabs: {
      query: async (queryInfo: chrome.tabs.QueryInfo) => {
        if (queryInfo.windowId === 1 && !activationQuerySeen) {
          activationQuerySeen = true
          markActivationQueryStarted()
          await activationQueryBlocked
        }
        return tabs
      }
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  const activation = service.recordTabActivation(1, 3)
  await activationQueryStarted
  const activity = service.getWorkingSetActivity()
  const firstTurn = await Promise.race([
    activity.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending')))
  ])

  assert.equal(firstTurn, 'pending')
  releaseActivationQuery()
  await activation
  assert.deepEqual(Object.keys((await activity).records).sort(), [
    'https://example.test/one',
    'https://example.test/three',
    'https://example.test/two'
  ])
})

test('Working Set window-focus activity preserves event order when captured tab lookups resolve out of order', async () => {
  const tabs = [chromeTab(1, 'one'), { ...chromeTab(2, 'two'), windowId: 2, active: true, selected: true }]
  let resolveWindowOne!: (tabs: chrome.tabs.Tab[]) => void
  let resolveWindowTwo!: (tabs: chrome.tabs.Tab[]) => void
  const windowOneLookup = new Promise<chrome.tabs.Tab[]>((resolve) => {
    resolveWindowOne = resolve
  })
  const windowTwoLookup = new Promise<chrome.tabs.Tab[]>((resolve) => {
    resolveWindowTwo = resolve
  })
  let storedActivity = emptyWorkingSetActivity()
  const chromeApi = {
    tabs: {
      query: async () => { throw new Error('captured focus events must not repeat the active-tab lookup') }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [
        { id: 1, focused: false, type: 'normal' },
        { id: 2, focused: true, type: 'normal' }
      ]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  const firstFocus = service.recordFocusedWindowActiveTab(
    1,
    windowOneLookup.then((resolvedTabs) => resolvedTabs[0] ?? null)
  )
  const secondFocus = service.recordFocusedWindowActiveTab(
    2,
    windowTwoLookup.then((resolvedTabs) => resolvedTabs[0] ?? null)
  )
  resolveWindowTwo([tabs[1]])
  await new Promise<void>((resolve) => setImmediate(resolve))
  resolveWindowOne([tabs[0]])
  await Promise.all([firstFocus, secondFocus])

  const activity = await service.getWorkingSetActivity()
  const firstRecord = activity.records['https://example.test/one']
  const secondRecord = activity.records['https://example.test/two']
  assert.ok(firstRecord)
  assert.ok(secondRecord)
  assert.ok((secondRecord.lastActivatedAt ?? 0) > (firstRecord.lastActivatedAt ?? 0))
})

test('Working Set counts paired tab-activation and window-focus signals once', async () => {
  const tab = chromeTab(1, 'paired')
  let storedActivity = emptyWorkingSetActivity()
  let writeCount = 0
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeCount += 1
          storedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  await Promise.all([
    service.recordTabActivation(1, 1),
    service.recordFocusedWindowActiveTab(1)
  ])

  const record = (await service.getWorkingSetActivity()).records['https://example.test/paired']
  assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 1)
  assert.equal(writeCount, 1, 'the deduped paired signal must not rewrite the activity store')
})

test('Working Set does not treat same-page reloads as navigation activity', async () => {
  const tab = chromeTab(1, 'workflows')
  let storedActivity = emptyWorkingSetActivity()
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  await service.recordTabActivation(1, 1)
  await service.recordTabNavigation(1, { url: tab.url }, tab)

  const record = (await service.getWorkingSetActivity()).records['https://example.test/workflows']
  assert.deepEqual(record?.events.map((event) => event.kind), ['activation'])
})

test('Working Set tab lookup failures do not rewrite unchanged activity', async () => {
  let writeCount = 0
  const chromeApi = {
    tabs: { query: async () => { throw new Error('tab lookup unavailable') } },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => []
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: emptyWorkingSetActivity() }),
        set: async () => { writeCount += 1 }
      }
    }
  } as unknown as ChromeApi

  await createWorkingSetService(chromeApi).recordTabActivation(1, 1)

  assert.equal(writeCount, 0)
})

test('Working Set does not dedupe a paired focus event after the activation write fails', async () => {
  const tab = chromeTab(1, 'paired-write-retry')
  let storedActivity = emptyWorkingSetActivity()
  let writeAttempts = 0
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeAttempts += 1
          if (writeAttempts === 1) throw new Error('activity write failed')
          storedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  await assert.rejects(service.recordTabActivation(1, 1), /activity write failed/)
  await service.recordFocusedWindowActiveTab(1)

  const record = (await service.getWorkingSetActivity()).records['https://example.test/paired-write-retry']
  assert.equal(writeAttempts, 2)
  assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 1)
})

test('Working Set still records repeated activation signals from the same event source', async () => {
  const tab = chromeTab(1, 'repeated')
  let storedActivity = emptyWorkingSetActivity()
  const chromeApi = {
    tabs: { query: async () => [tab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          storedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  await service.recordTabActivation(1, 1)
  await service.recordTabActivation(1, 1)

  const record = (await service.getWorkingSetActivity()).records['https://example.test/repeated']
  assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 2)
})

test('Working Set rebases its activation signal when Chrome replaces a tab id', async () => {
  const removedTab = chromeTab(1, 'replacement')
  let tabs = [removedTab]
  let storedActivity = emptyWorkingSetActivity()
  let writeCount = 0
  let markActivationLookupStarted!: () => void
  let releaseActivationLookup!: (tabs: chrome.tabs.Tab[]) => void
  const activationLookupStarted = new Promise<void>((resolve) => {
    markActivationLookupStarted = resolve
  })
  const activationLookup = new Promise<chrome.tabs.Tab[]>((resolve) => {
    releaseActivationLookup = resolve
  })
  let firstLookup = true
  const chromeApi = {
    tabs: {
      query: async () => {
        if (firstLookup) {
          firstLookup = false
          markActivationLookupStarted()
          return activationLookup
        }
        return tabs
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: storedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeCount += 1
          storedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  const activation = service.recordTabActivation(1, 1)
  await activationLookupStarted
  tabs = [{ ...chromeTab(4, 'replacement'), active: true, index: 0 }]
  const replacement = service.replaceTabId(4, 1)
  releaseActivationLookup([removedTab])
  await Promise.all([activation, replacement])
  await service.recordFocusedWindowActiveTab(1)
  await service.recordTabNavigation(4, { url: tabs[0].url }, tabs[0])

  const record = (await service.getWorkingSetActivity()).records['https://example.test/replacement']
  assert.equal(record?.events.filter((event) => event.kind === 'activation').length, 1)
  assert.equal(writeCount, 1, 'tab-id rebasing, paired focus, and same-page refresh are in-memory only')
})

test('Working Set mutation retries persisted activity after a transient initial storage read failure', async () => {
  const existingTab = chromeTab(1, 'existing')
  const activatedTab = chromeTab(2, 'activated')
  let persistedActivity = recordWorkingSetActivity(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: Date.now() - 1000,
    tab: { url: existingTab.url || '', rawUrl: existingTab.url || '', title: existingTab.title || '' }
  })
  let readAttempts = 0
  let writeAttempts = 0
  const chromeApi = {
    tabs: { query: async () => [existingTab, activatedTab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => {
          readAttempts += 1
          if (readAttempts === 1) throw new Error('activity read failed')
          return { [WORKING_SET_ACTIVITY_KEY]: persistedActivity }
        },
        set: async (value: Record<string, unknown>) => {
          writeAttempts += 1
          persistedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  await assert.rejects(service.recordTabActivation(1, 2), /activity read failed/)
  assert.equal(writeAttempts, 0)
  assert.ok(persistedActivity.records['https://example.test/existing'])
  assert.equal(persistedActivity.records['https://example.test/activated'], undefined)

  await service.recordTabActivation(1, 2)
  assert.equal(writeAttempts, 1)
  assert.ok(persistedActivity.records['https://example.test/existing'])
  assert.ok(persistedActivity.records['https://example.test/activated'])
})

test('Working Set mutation does not advance its cache until the storage write succeeds', async () => {
  const existingTab = chromeTab(1, 'existing-write')
  const activatedTab = chromeTab(2, 'activated-write')
  let persistedActivity = recordWorkingSetActivity(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: Date.now() - 1000,
    tab: { url: existingTab.url || '', rawUrl: existingTab.url || '', title: existingTab.title || '' }
  })
  let writeAttempts = 0
  const chromeApi = {
    tabs: { query: async () => [existingTab, activatedTab] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: persistedActivity }),
        set: async (value: Record<string, unknown>) => {
          writeAttempts += 1
          if (writeAttempts === 1) throw new Error('activity write failed')
          persistedActivity = value[WORKING_SET_ACTIVITY_KEY] as WorkingSetActivityStore
        }
      }
    }
  } as unknown as ChromeApi
  const service = createWorkingSetService(chromeApi)

  await assert.rejects(service.recordTabActivation(1, 2), /activity write failed/)
  assert.equal(persistedActivity.records['https://example.test/activated-write'], undefined)

  await service.recordTabActivation(1, 2)
  assert.equal(writeAttempts, 2)
  assert.ok(persistedActivity.records['https://example.test/existing-write'])
  assert.ok(persistedActivity.records['https://example.test/activated-write'])
})

test('Working Set treats an absent first-run storage key as known empty state', async () => {
  const chromeApi = {
    tabs: { query: async () => [] },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: { get: async () => ({}) }
    }
  } as unknown as ChromeApi

  const activity = await createWorkingSetService(chromeApi).getWorkingSetActivity()

  assert.deepEqual(activity.records, {})
})
