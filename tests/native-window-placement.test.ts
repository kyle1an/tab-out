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

const targetBounds = displays[1]!.bounds

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
  createWithoutIdentity?: boolean
  displays?: chrome.system.display.DisplayUnitInfo[]
  updateError?: Error
  windows?: chrome.windows.Window[]
} = {}) {
  const calls = {
    create: [] as chrome.windows.CreateData[],
    getAll: [] as chrome.windows.QueryOptions[],
    remove: [] as number[],
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
        if (options.createWithoutIdentity) return undefined
        return { id: 52, type: 'normal', focused: false } as chrome.windows.Window
      },
      async remove(windowId: number) {
        calls.remove.push(windowId)
      },
      async update(windowId: number, updateInfo: chrome.windows.UpdateInfo) {
        calls.update.push({ windowId, updateInfo })
        if (options.updateError) throw options.updateError
        return { id: windowId, type: 'normal', focused: true } as chrome.windows.Window
      }
    }
  } as unknown as ChromeApi

  return { calls, chromeApi }
}

test('filter bridge keeps the inactive window concealed until it is placed on the addressed display', async () => {
  const { calls, chromeApi } = createChromeApi()

  await createInactiveWindow('filter', targetBounds, chromeApi)

  assert.deepEqual(calls.getAll, [{ windowTypes: ['normal'] }])
  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      focused: false,
      state: 'minimized'
    }
  ])
  assert.deepEqual(calls.update, [{
    windowId: 52,
    updateInfo: {
      left: -1820,
      top: 75,
      width: 1200,
      height: 700
    }
  }])
})

test('new-page bridge creates an inactive native new-tab window at the target bounds', async () => {
  const { calls, chromeApi } = createChromeApi()

  await createInactiveWindow('newPage', targetBounds, chromeApi)

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      focused: false,
      state: 'minimized'
    }
  ])
  assert.deepEqual(calls.update, [{
    windowId: 52,
    updateInfo: {
      left: -1820,
      top: 75,
      width: 1200,
      height: 700
    }
  }])
})

test('bridge ignores a target-display Chrome window that Hammerspoon found on an inactive macOS Space', async () => {
  const inactiveSpaceWindow = {
    ...remoteWindow,
    id: 42,
    left: -1800,
    top: 80
  } as chrome.windows.Window
  const { calls, chromeApi } = createChromeApi({ windows: [remoteWindow, inactiveSpaceWindow] })

  await createInactiveWindow('filter', targetBounds, chromeApi)

  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0]?.state, 'minimized')
  assert.equal(calls.update[0]?.updateInfo.left, -1820)
})

test('filter bridge creates on the addressed display when both displays have no Chrome window', async () => {
  const { calls, chromeApi } = createChromeApi({ windows: [] })

  await createInactiveWindow('filter', targetBounds, chromeApi)

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      focused: false,
      state: 'minimized'
    }
  ])
  assert.deepEqual(calls.update, [{
    windowId: 52,
    updateInfo: {
      left: -1920,
      top: 0,
      width: 1920,
      height: 1080
    }
  }])
})

test('new-page bridge creates on one display when it has no Chrome window', async () => {
  const { calls, chromeApi } = createChromeApi({ displays: [displays[0]!], windows: [] })

  await createInactiveWindow('newPage', displays[0]!.bounds, chromeApi)

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      focused: false,
      state: 'minimized'
    }
  ])
  assert.deepEqual(calls.update, [{
    windowId: 52,
    updateInfo: {
      left: 0,
      top: 25,
      width: 1440,
      height: 875
    }
  }])
})

test('bridge addresses a third display without adding another extension command', async () => {
  const thirdDisplay = {
    ...displays[0]!,
    id: 'third-display',
    bounds: { left: 1440, top: 0, width: 1280, height: 800 },
    workArea: { left: 1440, top: 25, width: 1280, height: 775 }
  }
  const { calls, chromeApi } = createChromeApi({ displays: [...displays, thirdDisplay] })

  await createInactiveWindow('filter', thirdDisplay.bounds, chromeApi)

  assert.deepEqual(calls.create, [
    {
      type: 'normal',
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      focused: false,
      state: 'minimized'
    }
  ])
  assert.deepEqual(calls.update, [{
    windowId: 52,
    updateInfo: {
      left: 1520,
      top: 100,
      width: 1200,
      height: 700
    }
  }])
})

test('bridge aborts before mutation when target bounds do not identify a display', async () => {
  const { calls, chromeApi } = createChromeApi()

  await assert.rejects(
    () => createInactiveWindow('filter', { left: 9000, top: 9000, width: 100, height: 100 }, chromeApi),
    /do not identify one enabled display/
  )

  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.update, [])
})

test('bridge aborts before mutation when target bounds only partially match a display', async () => {
  const { calls, chromeApi } = createChromeApi()

  await assert.rejects(
    () => createInactiveWindow('filter', { left: 100, top: 100, width: 100, height: 100 }, chromeApi),
    /do not identify one enabled display/
  )

  assert.deepEqual(calls.getAll, [])
  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.update, [])
})

test('bridge rejects a concealed window without an identity before placement', async () => {
  const { calls, chromeApi } = createChromeApi({ createWithoutIdentity: true })

  await assert.rejects(
    () => createInactiveWindow('filter', targetBounds, chromeApi),
    /concealed window identity/
  )

  assert.equal(calls.create.length, 1)
  assert.deepEqual(calls.update, [])
  assert.deepEqual(calls.remove, [])
})

test('bridge removes the concealed window when placement fails', async () => {
  const { calls, chromeApi } = createChromeApi({ updateError: new Error('placement failed') })

  await assert.rejects(
    () => createInactiveWindow('filter', targetBounds, chromeApi),
    /placement failed/
  )

  assert.equal(calls.update.length, 1)
  assert.deepEqual(calls.remove, [52])
})
