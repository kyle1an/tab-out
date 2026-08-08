import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { Effect, ManagedRuntime } from 'effect'

import {
  NativePlacementBridge,
  NATIVE_PLACEMENT_BRIDGE_VERSION,
  handleNativePlacementBridgeMessageEffect
} from '../src/extension/background/native-placement-bridge.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'

const nowMs = 1_800_000_000_000

function handleNativePlacementBridgeMessage(
  message: unknown,
  chromeApi: ChromeApi,
  at: number
) {
  return Effect.runPromise(handleNativePlacementBridgeMessageEffect(message, chromeApi, at))
}

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

function createChromeApi(windows: chrome.windows.Window[] = []) {
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
        return windows
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
  const creationToken = 'hs:1800000000000:filter'

  const result = await handleNativePlacementBridgeMessage(createRequest({
    requestId: creationToken
  }), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: creationToken,
    status: 'accepted',
    browserWindowId: 91
  })
  assert.deepEqual(createCalls, [{
    type: 'normal',
    url: 'chrome-extension://tab-out/index.html?focusFilter=1&tabOutPlacement=hs%3A1800000000000%3Afilter',
    focused: false,
    left: 1440,
    top: 25,
    width: 1920,
    height: 1055
  }])
})

test('native placement bridge creates new-page requests through a uniquely tokenized Tab Out document', async () => {
  const { chromeApi, createCalls } = createChromeApi()
  const creationToken = 'hs:1800000000000:newPage'

  const result = await handleNativePlacementBridgeMessage(createRequest({
    operation: 'newPage',
    requestId: creationToken
  }), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: creationToken,
    status: 'accepted',
    browserWindowId: 91
  })
  assert.deepEqual(createCalls, [{
    type: 'normal',
    url: 'chrome-extension://tab-out/index.html?tabOutPlacement=hs%3A1800000000000%3AnewPage',
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

test('native placement bridge reports profile-owned normal window identities without focusing them', async () => {
  const { chromeApi, createCalls } = createChromeApi([
    { id: 71, type: 'normal', focused: false, state: 'normal' },
    { id: 72, type: 'popup', focused: false, state: 'normal' },
    { id: 73, type: 'normal', focused: false, state: 'minimized' },
    { type: 'normal', focused: false, state: 'normal' }
  ] as chrome.windows.Window[])

  const result = await handleNativePlacementBridgeMessage(
    createRequest({ type: 'list-profile-windows' }),
    chromeApi,
    nowMs
  )

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'accepted',
    windowIds: [71]
  })
  assert.deepEqual(createCalls, [])
})

test('native placement bridge turns a rejected profile-window read into a response', async () => {
  const { chromeApi, createCalls } = createChromeApi()
  Object.assign(chromeApi.windows, {
    async getAll() {
      throw new Error('Profile window inventory unavailable')
    }
  })

  const result = await handleNativePlacementBridgeMessage(
    createRequest({ type: 'list-profile-windows' }),
    chromeApi,
    nowMs
  )

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'rejected',
    reason: 'Profile window inventory unavailable'
  })
  assert.deepEqual(createCalls, [])
})

test('native placement bridge turns a rejected placement read into a response', async () => {
  const { chromeApi, createCalls } = createChromeApi()
  Object.assign(chromeApi.system.display, {
    async getInfo() {
      throw new Error('Display inventory unavailable')
    }
  })

  const result = await handleNativePlacementBridgeMessage(createRequest(), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'rejected',
    reason: 'Display inventory unavailable'
  })
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

test('native placement bridge schema preserves envelope rejection reasons', async () => {
  const { chromeApi, createCalls } = createChromeApi()
  const cases: ReadonlyArray<{ message: unknown; reason: RegExp; requestId: string }> = [
    { message: null, reason: /not an object/, requestId: 'invalid' },
    {
      message: createRequest({ version: NATIVE_PLACEMENT_BRIDGE_VERSION + 1 }),
      reason: /version is unsupported/,
      requestId: 'hs-1800000000000-1'
    },
    {
      message: createRequest({ requestId: 'contains spaces' }),
      reason: /request ID is invalid/,
      requestId: 'invalid'
    },
    {
      message: createRequest({ type: 'unknown' }),
      reason: /request type is unsupported/,
      requestId: 'hs-1800000000000-1'
    },
    {
      message: createRequest({ operation: 'unknown' }),
      reason: /operation is invalid/,
      requestId: 'hs-1800000000000-1'
    },
    {
      message: createRequest({
        targetBounds: { left: 100_001, top: 0, width: 900, height: 700 }
      }),
      reason: /target bounds are invalid/,
      requestId: 'hs-1800000000000-1'
    }
  ]

  for (const entry of cases) {
    const result = await handleNativePlacementBridgeMessage(entry.message, chromeApi, nowMs)
    assert.equal(result.status, 'rejected')
    assert.equal(result.requestId, entry.requestId)
    assert.match(result.reason ?? '', entry.reason)
  }
  assert.deepEqual(createCalls, [])
})

test('native placement bridge reconnects after the host port disconnects', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
  const noOp = () => {}
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        return {
          disconnect() {},
          onMessage: {
            addListener() {},
            removeListener() {}
          },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener: noOp
          },
          postMessage() {}
        }
      }
    }
  } as unknown as ChromeApi

  try {
    const runtime = ManagedRuntime.make(NativePlacementBridge.layer(chromeApi))
    runtime.runSync(Effect.void)
    assert.equal(connectionCount, 1)

    disconnectListeners[0]!()
    await clock.tickAsync(250)

    assert.equal(connectionCount, 2)
    await runtime.dispose()
  } finally {
    clock.uninstall()
  }
})

test('native placement bridge escalates delays across connection failures', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousWarn = console.warn
  let connectionCount = 0
  let disposeRuntime = async () => {}
  console.warn = () => {}
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        if (connectionCount < 3) throw new Error('Native host unavailable')
        return {
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener() {}, removeListener() {} },
          postMessage() {}
        }
      }
    }
  } as unknown as ChromeApi

  try {
    const runtime = ManagedRuntime.make(NativePlacementBridge.layer(chromeApi))
    disposeRuntime = () => runtime.dispose()
    runtime.runSync(Effect.void)
    assert.equal(connectionCount, 1)

    await clock.tickAsync(249)
    assert.equal(connectionCount, 1)
    await clock.tickAsync(1)
    assert.equal(connectionCount, 2)

    await clock.tickAsync(999)
    assert.equal(connectionCount, 2)
    await clock.tickAsync(1)
    assert.equal(connectionCount, 3)
  } finally {
    await disposeRuntime()
    console.warn = previousWarn
    clock.uninstall()
  }
})

test('native placement bridge backs off beyond the MV3 idle window when the host stays unavailable', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const previousWarn = console.warn
  let connectionCount = 0
  let disposeRuntime = async () => {}
  console.warn = () => {}
  const { chromeApi } = createChromeApi()
  chromeApi.runtime.connectNative = () => {
    connectionCount += 1
    throw new Error('Native host unavailable')
  }

  try {
    const runtime = ManagedRuntime.make(NativePlacementBridge.layer(chromeApi))
    disposeRuntime = () => runtime.dispose()
    runtime.runSync(Effect.void)
    assert.equal(connectionCount, 1)

    await clock.tickAsync(250)
    assert.equal(connectionCount, 2)
    await clock.tickAsync(1_000)
    assert.equal(connectionCount, 3)
    await clock.tickAsync(5_000)
    assert.equal(connectionCount, 4)

    await clock.tickAsync(30_000)
    assert.equal(connectionCount, 4)
  } finally {
    await disposeRuntime()
    console.warn = previousWarn
    clock.uninstall()
  }
})

test('native placement bridge resets backoff after a native message', async () => {
  const clock = FakeTimers.install({
    now: nowMs,
    toFake: ['Date', 'setTimeout', 'clearTimeout']
  })
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
  let disposeRuntime = async () => {}
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        return {
          disconnect() {},
          onMessage: {
            addListener(listener: (message: unknown) => void) {
              messageListeners.push(listener)
            },
            removeListener() {}
          },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener() {}
          },
          postMessage() {}
        }
      }
    }
  } as unknown as ChromeApi

  try {
    const runtime = ManagedRuntime.make(NativePlacementBridge.layer(chromeApi))
    disposeRuntime = () => runtime.dispose()
    runtime.runSync(Effect.void)
    disconnectListeners[0]!()
    await clock.tickAsync(250)
    assert.equal(connectionCount, 2)

    messageListeners[1]!(createRequest({ type: 'status' }))
    disconnectListeners[1]!()
    await clock.tickAsync(249)
    assert.equal(connectionCount, 2)
    await clock.tickAsync(1)
    assert.equal(connectionCount, 3)
  } finally {
    await disposeRuntime()
    clock.uninstall()
  }
})

test('disposing the native placement bridge cancels reconnect sleep', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        return {
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener() {}
          },
          postMessage() {}
        }
      }
    }
  } as unknown as ChromeApi

  try {
    const runtime = ManagedRuntime.make(NativePlacementBridge.layer(chromeApi))
    runtime.runSync(Effect.void)
    disconnectListeners[0]!()
    await runtime.dispose()

    await clock.tickAsync(15_000)
    assert.equal(connectionCount, 1)
  } finally {
    clock.uninstall()
  }
})
