import assert from 'node:assert/strict'
import { layer } from '@effect/vitest'
import { Effect } from 'effect'

import {
  moveActiveTabToNewWindowEffect,
  moveCurrentTabToNewWindowEffect,
} from '../../src/extension/move-current-tab-action.js'
import { BrowserTabs } from '../../src/extension/browser-tabs-service.js'
import {
  setChromeTabsApi,
  type ChromeTabsApi,
} from '../../src/extension/browser-tabs-gateway.js'

type CreateWindow = (
  createData: chrome.windows.CreateData,
) => Promise<chrome.windows.Window | undefined>

function chromeApiWithWindowCreation(create: CreateWindow): ChromeTabsApi {
  return {
    tabs: {
      async query() {
        return []
      },
    },
    windows: { create },
  }
}

function normalWindow(id: number): chrome.windows.Window {
  return {
    id,
    alwaysOnTop: false,
    focused: true,
    incognito: false,
    state: 'normal',
    type: 'normal',
  }
}

layer(BrowserTabs.layer())('move current tab action', (it) => {
  it.effect('moves the exact target tab into one focused normal window', () => Effect.gen(function* () {
    const requests: chrome.windows.CreateData[] = []
    yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
    yield* Effect.sync(() => setChromeTabsApi(chromeApiWithWindowCreation(
      async (createData) => {
        requests.push(createData)
        return normalWindow(2)
      },
    )))
    const moved = yield* moveCurrentTabToNewWindowEffect({ id: 7 })

    assert.equal(moved, true)
    assert.deepEqual(requests, [{
      tabId: 7,
      focused: true,
      type: 'normal',
    }])
  }))

  it.effect('does nothing without an exact tab id', () => Effect.gen(function* () {
    const requests: chrome.windows.CreateData[] = []
    yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
    yield* Effect.sync(() => setChromeTabsApi(chromeApiWithWindowCreation(
      async (createData) => {
        requests.push(createData)
        return normalWindow(2)
      },
    )))
    const moved = yield* moveCurrentTabToNewWindowEffect({})

    assert.equal(moved, false)
    assert.deepEqual(requests, [])
  }))

  it.effect('returns false without opening a replacement URL when Chrome refuses the move', () => Effect.gen(function* () {
    const requests: chrome.windows.CreateData[] = []
    yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
    yield* Effect.sync(() => setChromeTabsApi(chromeApiWithWindowCreation(
      async (createData) => {
        requests.push(createData)
        throw new Error('Window creation refused')
      },
    )))
    const moved = yield* moveCurrentTabToNewWindowEffect({ id: 7 })

    assert.equal(moved, false)
    assert.deepEqual(requests, [{
      tabId: 7,
      focused: true,
      type: 'normal',
    }])
  }))

  it.effect('the menu action resolves the invoking window\'s active tab and moves exactly it', () => Effect.gen(function* () {
    const requests: chrome.windows.CreateData[] = []
    const queriedWindowIds: number[] = []
    yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
    yield* Effect.sync(() => setChromeTabsApi({
      tabs: {
        async query({ windowId }: chrome.tabs.QueryInfo = {}) {
          if (typeof windowId === 'number') queriedWindowIds.push(windowId)
          return [
            { id: 11, windowId: 5, active: false } as chrome.tabs.Tab,
            { id: 12, windowId: 5, active: true } as chrome.tabs.Tab,
          ]
        },
      },
      windows: {
        getCurrent: async () => normalWindow(5),
        create: async (createData: chrome.windows.CreateData) => {
          requests.push(createData)
          return normalWindow(6)
        },
      },
    } as unknown as ChromeTabsApi))
    const moved = yield* moveActiveTabToNewWindowEffect()

    assert.equal(moved, true)
    assert.deepEqual(queriedWindowIds, [5])
    assert.deepEqual(requests, [{
      tabId: 12,
      focused: true,
      type: 'normal',
    }])
  }))

  it.effect('the menu action stops without a window mutation when the invoking window is unknown', () => Effect.gen(function* () {
    const requests: chrome.windows.CreateData[] = []
    yield* Effect.addFinalizer(() => Effect.sync(() => setChromeTabsApi(null)))
    yield* Effect.sync(() => setChromeTabsApi({
      tabs: {
        async query() {
          return []
        },
      },
      windows: {
        getCurrent: async () => {
          throw new Error('No current window')
        },
        create: async (createData: chrome.windows.CreateData) => {
          requests.push(createData)
          return normalWindow(6)
        },
      },
    } as unknown as ChromeTabsApi))
    const moved = yield* moveActiveTabToNewWindowEffect()

    assert.equal(moved, false)
    assert.deepEqual(requests, [])
  }))
})
