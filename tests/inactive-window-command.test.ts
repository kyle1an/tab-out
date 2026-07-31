import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createInactiveWindow,
  inactiveWindowCommandTarget
} from '../src/extension/background/inactive-window-command.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'

const displays = [
  {
    id: 'remote-display',
    isPrimary: true,
    isInternal: true,
    isEnabled: true,
    bounds: { left: 0, top: 0, width: 1440, height: 900 },
    workArea: { left: 0, top: 25, width: 1440, height: 875 },
    rotation: 0,
    dpiX: 144,
    dpiY: 144
  },
  {
    id: 'target-display',
    isPrimary: false,
    isInternal: false,
    isEnabled: true,
    bounds: { left: -1920, top: 0, width: 1920, height: 1080 },
    workArea: { left: -1920, top: 0, width: 1920, height: 1080 },
    rotation: 0,
    dpiX: 110,
    dpiY: 110
  }
] as chrome.system.display.DisplayUnitInfo[]

const remoteWindow = {
  id: 41,
  type: 'normal',
  state: 'normal',
  focused: false,
  alwaysOnTop: false,
  incognito: false,
  left: 100,
  top: 100,
  width: 1200,
  height: 700
} as chrome.windows.Window

function createChromeApi(options: {
  displays?: chrome.system.display.DisplayUnitInfo[]
  windows?: chrome.windows.Window[]
} = {}) {
  const calls = {
    create: [] as chrome.windows.CreateData[],
    getAll: [] as chrome.windows.QueryOptions[],
    update: [] as Array<{ windowId: number; updateInfo: chrome.windows.UpdateInfo }>
  }
  const chromeApi = {
    runtime: { id: 'tab-out' },
    system: {
      display: {
        async getInfo() {
          return options.displays ?? displays
        }
      }
    },
    windows: {
      async getAll(queryOptions: chrome.windows.QueryOptions) {
        calls.getAll.push(queryOptions)
        return options.windows ?? [remoteWindow]
      },
      async create(createData: chrome.windows.CreateData) {
        calls.create.push(createData)
        return { id: 52, type: 'normal', focused: false } as chrome.windows.Window
      },
      async update(windowId: number, updateInfo: chrome.windows.UpdateInfo) {
        calls.update.push({ windowId, updateInfo })
        return { id: windowId, type: 'normal', focused: true } as chrome.windows.Window
      }
    }
  } as unknown as ChromeApi

  return { calls, chromeApi }
}

test('filter bridge creates an inactive window at the addressed display without activating Chrome', async () => {
  const { calls, chromeApi } = createChromeApi()

  await createInactiveWindow('filter', 1, chromeApi)

  assert.deepEqual(calls.getAll, [{ windowTypes: ['normal'] }])
  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      focused: false,
      left: -1820,
      top: 75,
      width: 1200,
      height: 700
    }
  ])
  assert.deepEqual(calls.update, [])
})

test('new-page bridge creates an inactive native new-tab window at the target bounds', async () => {
  const { calls, chromeApi } = createChromeApi()

  await createInactiveWindow('newPage', 1, chromeApi)

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      focused: false,
      left: -1820,
      top: 75,
      width: 1200,
      height: 700
    }
  ])
  assert.deepEqual(calls.update, [])
})

test('bridge ignores a target-display Chrome window that Hammerspoon found on an inactive macOS Space', async () => {
  const inactiveSpaceWindow = {
    ...remoteWindow,
    id: 42,
    left: -1800,
    top: 80
  } as chrome.windows.Window
  const { calls, chromeApi } = createChromeApi({ windows: [remoteWindow, inactiveSpaceWindow] })

  await createInactiveWindow('filter', 1, chromeApi)

  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0]?.left, -1820)
  assert.deepEqual(calls.update, [])
})

test('bridge aborts before mutation when the display-addressed contract is not exactly two displays', async () => {
  const { calls, chromeApi } = createChromeApi({ displays: [displays[0]!] })

  await assert.rejects(
    () => createInactiveWindow('filter', 1, chromeApi),
    /exactly two enabled displays/
  )

  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.update, [])
})

test('display-addressed command names map both routes to both desktop positions', () => {
  assert.deepEqual(inactiveWindowCommandTarget('create-inactive-filter-window-display-1'), {
    kind: 'filter',
    displayPosition: 1
  })
  assert.deepEqual(inactiveWindowCommandTarget('create-inactive-new-page-window-display-2'), {
    kind: 'newPage',
    displayPosition: 2
  })
  assert.equal(inactiveWindowCommandTarget('open-filter-tab'), null)
})
