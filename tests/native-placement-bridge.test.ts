import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'

import {
  connectNativePlacementBridge,
  NATIVE_PLACEMENT_BRIDGE_VERSION,
  handleNativePlacementBridgeMessage
} from '../src/extension/background/native-placement-bridge.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'

const nowMs = 1_800_000_000_000
const targetDisplay = {
  id: 'target-display',
  isPrimary: false,
  isInternal: false,
  isEnabled: true,
  bounds: { left: 1440, top: 0, width: 1920, height: 1080 },
  workArea: { left: 1440, top: 25, width: 1920, height: 1055 },
  rotation: 0,
  dpiX: 110,
  dpiY: 110
} as chrome.system.display.DisplayUnitInfo

function createChromeApi() {
  const createCalls: chrome.windows.CreateData[] = []
  const chromeApi = {
    runtime: { id: 'tab-out' },
    system: {
      display: {
        async getInfo() {
          return [targetDisplay]
        }
      }
    },
    windows: {
      async getAll() {
        return []
      },
      async create(createData: chrome.windows.CreateData) {
        createCalls.push(createData)
        return { id: 91, type: 'normal', focused: false, state: 'normal' } as chrome.windows.Window
      }
    }
  } as unknown as ChromeApi

  return { chromeApi, createCalls }
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'create-window',
    requestId: 'hs-1800000000000-1',
    expiresAtMs: nowMs + 12_000,
    operation: 'filter',
    targetBounds: targetDisplay.bounds,
    ...overrides
  }
}

test('native placement bridge creates the requested inactive window at target bounds', async () => {
  const { chromeApi, createCalls } = createChromeApi()

  const result = await handleNativePlacementBridgeMessage(createRequest(), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'accepted'
  })
  assert.deepEqual(createCalls, [{
    type: 'normal',
    url: 'chrome-extension://tab-out/index.html?focusFilter=1',
    focused: false,
    left: 1440,
    top: 25,
    width: 1920,
    height: 1055
  }])
})

test('native placement bridge status handshake does not create a window', async () => {
  const { chromeApi, createCalls } = createChromeApi()

  const result = await handleNativePlacementBridgeMessage(createRequest({ type: 'status' }), chromeApi, nowMs)

  assert.equal(result.status, 'accepted')
  assert.deepEqual(createCalls, [])
})

test('native placement bridge rejects an expired request before mutation', async () => {
  const { chromeApi, createCalls } = createChromeApi()

  const result = await handleNativePlacementBridgeMessage(
    createRequest({ expiresAtMs: nowMs - 1 }),
    chromeApi,
    nowMs
  )

  assert.equal(result.status, 'rejected')
  assert.match(result.reason ?? '', /expired/)
  assert.deepEqual(createCalls, [])
})

test('native placement bridge rejects malformed target bounds before mutation', async () => {
  const { chromeApi, createCalls } = createChromeApi()

  const result = await handleNativePlacementBridgeMessage(
    createRequest({ targetBounds: { left: 0, top: 0, width: 0, height: 900 } }),
    chromeApi,
    nowMs
  )

  assert.equal(result.status, 'rejected')
  assert.match(result.reason ?? '', /target bounds/)
  assert.deepEqual(createCalls, [])
})

test('native placement bridge reconnects after the host port disconnects', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        return {
          onMessage: { addListener() {} },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            }
          },
          postMessage() {}
        }
      }
    }
  } as unknown as ChromeApi

  try {
    connectNativePlacementBridge(chromeApi)
    assert.equal(connectionCount, 1)

    disconnectListeners[0]!()
    await clock.tickAsync(250)

    assert.equal(connectionCount, 2)
  } finally {
    clock.uninstall()
  }
})
