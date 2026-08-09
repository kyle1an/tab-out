import assert from 'node:assert/strict'
import test from 'node:test'

import { createInactiveWindow } from '../src/extension/background/native-window-placement.js'
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
    dpiY: 144,
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
    dpiY: 110,
  },
] as chrome.system.display.DisplayUnitInfo[]

const targetBounds = displays[1]!.bounds
const nativePlacementRequestId = 'hs:1800000000000:1'
const encodedNativePlacementRequestId = 'hs%3A1800000000000%3A1'
const nativePlacementToken = `tabOutPlacement=${encodedNativePlacementRequestId}`

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
  height: 700,
} as chrome.windows.Window

function createChromeApi(options: {
  createError?: Error
  createWithoutIdentity?: boolean
  displays?: chrome.system.display.DisplayUnitInfo[]
  windows?: chrome.windows.Window[]
} = {}) {
  const calls = {
    create: [] as chrome.windows.CreateData[],
    getAll: [] as chrome.windows.QueryOptions[],
  }
  const chromeApi = {
    runtime: { id: 'tab-out' },
    system: {
      display: {
        async getInfo() {
          return options.displays ?? displays
        },
      },
    },
    windows: {
      async getAll(queryOptions: chrome.windows.QueryOptions) {
        calls.getAll.push(queryOptions)
        return options.windows ?? [remoteWindow]
      },
      async create(createData: chrome.windows.CreateData) {
        calls.create.push(createData)
        if (options.createError) throw options.createError
        if (options.createWithoutIdentity) return undefined
        return { id: 52, type: 'normal', focused: false } as chrome.windows.Window
      },
    },
  } as unknown as ChromeApi

  return { calls, chromeApi }
}

test('filter bridge supplies target geometry at creation so Chrome cannot expose source-display bounds', async () => {
  const { calls, chromeApi } = createChromeApi()

  const browserWindowId = await createInactiveWindow(
    'filter',
    targetBounds,
    nativePlacementRequestId,
    chromeApi,
  )

  assert.equal(browserWindowId, 52)
  assert.deepEqual(calls.getAll, [{ windowTypes: ['normal'] }])
  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: `chrome-extension://tab-out/index.html?focusFilter=1&${nativePlacementToken}`,
      focused: false,
      left: -1820,
      top: 75,
      width: 1200,
      height: 700,
    },
  ])
})

test('new-page bridge creates an inactive tokenized Tab Out window at the target bounds', async () => {
  const { calls, chromeApi } = createChromeApi()

  const browserWindowId = await createInactiveWindow(
    'newPage',
    targetBounds,
    nativePlacementRequestId,
    chromeApi,
  )

  assert.equal(browserWindowId, 52)
  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: `chrome-extension://tab-out/index.html?${nativePlacementToken}`,
      focused: false,
      left: -1820,
      top: 75,
      width: 1200,
      height: 700,
    },
  ])
})

test('bridge ignores a target-display Chrome window that Hammerspoon found on an inactive macOS Space', async () => {
  const inactiveSpaceWindow = {
    ...remoteWindow,
    id: 42,
    left: -1800,
    top: 80,
  } as chrome.windows.Window
  const { calls, chromeApi } = createChromeApi({ windows: [remoteWindow, inactiveSpaceWindow] })

  await createInactiveWindow('filter', targetBounds, nativePlacementRequestId, chromeApi)

  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0]?.state, undefined)
  assert.equal(calls.create[0]?.left, -1820)
})

test('filter bridge creates on the addressed display when both displays have no Chrome window', async () => {
  const { calls, chromeApi } = createChromeApi({ windows: [] })

  await createInactiveWindow('filter', targetBounds, nativePlacementRequestId, chromeApi)

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: `chrome-extension://tab-out/index.html?focusFilter=1&${nativePlacementToken}`,
      focused: false,
      left: -1920,
      top: 0,
      width: 1920,
      height: 1080,
    },
  ])
})

test('new-page bridge creates on one display when it has no Chrome window', async () => {
  const { calls, chromeApi } = createChromeApi({ displays: [displays[0]!], windows: [] })

  await createInactiveWindow(
    'newPage',
    displays[0]!.bounds,
    nativePlacementRequestId,
    chromeApi,
  )

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: `chrome-extension://tab-out/index.html?${nativePlacementToken}`,
      focused: false,
      left: 0,
      top: 25,
      width: 1440,
      height: 875,
    },
  ])
})

test('bridge addresses a third display without adding another extension command', async () => {
  const thirdDisplay = {
    ...displays[0]!,
    id: 'third-display',
    bounds: { left: 1440, top: 0, width: 1280, height: 800 },
    workArea: { left: 1440, top: 25, width: 1280, height: 775 },
  }
  const { calls, chromeApi } = createChromeApi({ displays: [...displays, thirdDisplay] })

  await createInactiveWindow('filter', thirdDisplay.bounds, nativePlacementRequestId, chromeApi)

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: `chrome-extension://tab-out/index.html?focusFilter=1&${nativePlacementToken}`,
      focused: false,
      left: 1520,
      top: 100,
      width: 1200,
      height: 700,
    },
  ])
})

test('bridge aborts before mutation when target bounds do not identify a display', async () => {
  const { calls, chromeApi } = createChromeApi()

  await assert.rejects(
    () => createInactiveWindow(
      'filter',
      { left: 9000, top: 9000, width: 100, height: 100 },
      nativePlacementRequestId,
      chromeApi,
    ),
    /do not identify one enabled display/,
  )

  assert.deepEqual(calls.create, [])
})

test('bridge aborts before mutation when target bounds only partially match a display', async () => {
  const { calls, chromeApi } = createChromeApi()

  await assert.rejects(
    () => createInactiveWindow(
      'filter',
      { left: 100, top: 100, width: 100, height: 100 },
      nativePlacementRequestId,
      chromeApi,
    ),
    /do not identify one enabled display/,
  )

  assert.deepEqual(calls.getAll, [])
  assert.deepEqual(calls.create, [])
})

test('bridge rejects a placed window without an identity', async () => {
  const { calls, chromeApi } = createChromeApi({ createWithoutIdentity: true })

  await assert.rejects(
    () => createInactiveWindow('filter', targetBounds, nativePlacementRequestId, chromeApi),
    /placed window identity/,
  )

  assert.equal(calls.create.length, 1)
})

test('bridge propagates a target-bounded Chrome creation failure', async () => {
  const { calls, chromeApi } = createChromeApi({ createError: new Error('creation failed') })

  await assert.rejects(
    () => createInactiveWindow('filter', targetBounds, nativePlacementRequestId, chromeApi),
    /creation failed/,
  )

  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0]?.left, -1820)
})
