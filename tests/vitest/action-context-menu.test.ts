import assert from 'node:assert/strict'
import { it, layer } from '@effect/vitest'
import { Effect } from 'effect'

import {
  MOVE_CURRENT_TAB_TO_NEW_WINDOW_MENU_ID,
  moveCurrentTabToNewWindowEffect,
  registerActionContextMenu,
} from '../../src/extension/background/action-context-menu.js'
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

it('registers the move action only in the toolbar-icon context menu', () => {
  const registrations: chrome.contextMenus.CreateProperties[] = []

  registerActionContextMenu({
    contextMenus: {
      create(createProperties) {
        registrations.push(createProperties)
        return createProperties.id || registrations.length
      },
    },
  })

  assert.deepEqual(registrations, [{
    id: MOVE_CURRENT_TAB_TO_NEW_WINDOW_MENU_ID,
    title: 'Move current tab to new window',
    contexts: ['action'],
  }])
})

layer(BrowserTabs.layer())('move current tab action', (it) => {
  it.effect('moves the exact clicked tab into one focused normal window', () => Effect.gen(function* () {
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

  it.effect('does nothing when Chrome supplies no exact tab id', () => Effect.gen(function* () {
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
})
