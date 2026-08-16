import assert from 'node:assert/strict'
import { afterEach, it, vi } from '@effect/vitest'
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from 'effect'
import { TestClock } from 'effect/testing'

import {
  NATIVE_CONTROL_BRIDGE_VERSION,
  NATIVE_MERGE_DESKTOP_CAPABILITY,
  NATIVE_PLACEMENT_BRIDGE_VERSION,
  NativePlacementBridge,
  handleNativePlacementBridgeMessageEffect,
  makeNativePlacementBridgeLayer,
} from '../../src/extension/background/native-placement-bridge.js'
import type { ChromeApi } from '../../src/extension/background/chrome-api.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const nowMs = 1_800_000_000_000

function valueAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  assert.ok(value !== undefined, `expected value at index ${index}`)
  return value
}

function handleNativePlacementBridgeMessage(
  message: unknown,
  chromeApi: ChromeApi,
  at: number,
) {
  return handleNativePlacementBridgeMessageEffect(message, chromeApi, at)
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
  dpiY: 110,
} as chrome.system.display.DisplayUnitInfo

function createChromeApi(windows: chrome.windows.Window[] = []) {
  const createCalls: chrome.windows.CreateData[] = []
  const chromeApi = {
    runtime: { id: 'tab-out' },
    system: {
      display: {
        async getInfo() {
          return [targetDisplay]
        },
      },
    },
    windows: {
      async getAll() {
        return windows
      },
      async create(createData: chrome.windows.CreateData) {
        createCalls.push(createData)
        return { id: 91, type: 'normal', focused: false, state: 'normal' } as chrome.windows.Window
      },
    },
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
    ...overrides,
  }
}

it.effect('native placement bridge preserves the v3 token echo for staggered reloads', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  const creationToken = 'hs:1800000000000:filter'

  const result = yield* handleNativePlacementBridgeMessage(createRequest({
    requestId: creationToken,
  }), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: creationToken,
    status: 'accepted',
    browserWindowId: 91,
    creationToken,
  })
  assert.deepEqual(createCalls, [{
    type: 'normal',
    url: 'chrome-extension://tab-out/index.html?focusFilter=1&tabOutPlacement=hs%3A1800000000000%3Afilter',
    focused: false,
    left: 1440,
    top: 25,
    width: 1920,
    height: 1055,
  }])
}))

it.effect('native placement bridge creates new-page requests through a uniquely tokenized Tab Out document', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  const creationToken = 'hs:1800000000000:newPage'

  const result = yield* handleNativePlacementBridgeMessage(createRequest({
    operation: 'newPage',
    requestId: creationToken,
  }), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: creationToken,
    status: 'accepted',
    browserWindowId: 91,
    creationToken,
  })
  assert.deepEqual(createCalls, [{
    type: 'normal',
    url: 'chrome-extension://tab-out/index.html?tabOutPlacement=hs%3A1800000000000%3AnewPage',
    focused: false,
    left: 1440,
    top: 25,
    width: 1920,
    height: 1055,
  }])
}))

it.effect('native placement bridge status handshake does not create a window', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()

  const result = yield* handleNativePlacementBridgeMessage(createRequest({ type: 'status' }), chromeApi, nowMs)

  assert.equal(result.status, 'accepted')
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge reports profile-owned normal window identities without focusing them', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi([
    { id: 71, type: 'normal', focused: false, state: 'normal' },
    { id: 72, type: 'popup', focused: false, state: 'normal' },
    { id: 73, type: 'normal', focused: false, state: 'minimized' },
    { type: 'normal', focused: false, state: 'normal' },
  ] as chrome.windows.Window[])

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ type: 'list-profile-windows' }),
    chromeApi,
    nowMs,
  )

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'accepted',
    windowIds: [71],
  })
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge turns a rejected profile-window read into a response', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  Object.assign(chromeApi.windows, {
    async getAll() {
      throw new Error('Profile window inventory unavailable')
    },
  })

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ type: 'list-profile-windows' }),
    chromeApi,
    nowMs,
  )

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'rejected',
    reason: 'Profile window inventory unavailable',
  })
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge turns a rejected placement read into a response', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  Object.assign(chromeApi.system.display, {
    async getInfo() {
      throw new Error('Display inventory unavailable')
    },
  })

  const result = yield* handleNativePlacementBridgeMessage(createRequest(), chromeApi, nowMs)

  assert.deepEqual(result, {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: 'hs-1800000000000-1',
    status: 'rejected',
    reason: 'Display inventory unavailable',
  })
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge rejects an expired request before mutation', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ expiresAtMs: nowMs - 1 }),
    chromeApi,
    nowMs,
  )

  assert.equal(result.status, 'rejected')
  assert.match(result.reason ?? '', /expired/)
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge rejects malformed target bounds before mutation', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()

  const result = yield* handleNativePlacementBridgeMessage(
    createRequest({ targetBounds: { left: 0, top: 0, width: 0, height: 900 } }),
    chromeApi,
    nowMs,
  )

  assert.equal(result.status, 'rejected')
  assert.match(result.reason ?? '', /target bounds/)
  assert.deepEqual(createCalls, [])
}))

it.effect('native placement bridge schema preserves envelope rejection reasons', () => Effect.gen(function* () {
  const { chromeApi, createCalls } = createChromeApi()
  const cases: ReadonlyArray<{ message: unknown, reason: RegExp, requestId: string }> = [
    { message: null, reason: /not an object/, requestId: 'invalid' },
    {
      message: createRequest({ version: NATIVE_PLACEMENT_BRIDGE_VERSION + 1 }),
      reason: /version is unsupported/,
      requestId: 'hs-1800000000000-1',
    },
    {
      message: createRequest({ requestId: 'contains spaces' }),
      reason: /request ID is invalid/,
      requestId: 'invalid',
    },
    {
      message: createRequest({ type: 'unknown' }),
      reason: /request type is unsupported/,
      requestId: 'hs-1800000000000-1',
    },
    {
      message: createRequest({ operation: 'unknown' }),
      reason: /operation is invalid/,
      requestId: 'hs-1800000000000-1',
    },
    {
      message: createRequest({
        targetBounds: { left: 100_001, top: 0, width: 900, height: 700 },
      }),
      reason: /target bounds are invalid/,
      requestId: 'hs-1800000000000-1',
    },
  ]

  for (const entry of cases) {
    const result = yield* handleNativePlacementBridgeMessage(entry.message, chromeApi, nowMs)
    assert.equal(result.status, 'rejected')
    assert.equal(result.requestId, entry.requestId)
    assert.match(result.reason ?? '', entry.reason)
  }
  assert.deepEqual(createCalls, [])
}))

it.effect('native bridge negotiates the desktop controller and correlates selections', () => Effect.gen(function* () {
  const messageListeners: Array<(message: unknown) => void> = []
  const postedMessages: unknown[] = []
  const runtimeMessages: unknown[] = []
  const postedMessage = Deferred.makeUnsafe<unknown>()
  const noOp = () => {}
  const chromeApi = {
    runtime: {
      async sendMessage(message: unknown) {
        runtimeMessages.push(message)
      },
      connectNative() {
        return {
          disconnect() {},
          onMessage: {
            addListener(listener: (message: unknown) => void) {
              messageListeners.push(listener)
            },
            removeListener: noOp,
          },
          onDisconnect: { addListener: noOp, removeListener: noOp },
          postMessage(message: unknown) {
            postedMessages.push(message)
            Deferred.doneUnsafe(postedMessage, Effect.succeed(message))
          },
        }
      },
    },
    windows: {
      async getAll() {
        return [
          { id: 71, type: 'normal', state: 'normal' },
          { id: 72, type: 'normal', state: 'maximized' },
          { id: 73, type: 'normal', state: 'minimized' },
          { id: 74, type: 'popup', state: 'normal' },
        ]
      },
    },
  } as unknown as ChromeApi

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  valueAt(messageListeners, 0)({
    version: NATIVE_CONTROL_BRIDGE_VERSION,
    type: 'controller-status',
    connected: true,
    capabilities: [NATIVE_MERGE_DESKTOP_CAPABILITY],
  })
  yield* Effect.yieldNow

  assert.deepEqual(yield* bridge.getStatus(), {
    capabilities: [NATIVE_MERGE_DESKTOP_CAPABILITY],
    controllerConnected: true,
    hostConnected: true,
  })
  assert.deepEqual(runtimeMessages, [
    { type: 'tab-out:desktop-window-merge-status-changed' },
    { type: 'tab-out:desktop-window-merge-status-changed' },
  ])

  const selectionFiber = yield* Effect.forkChild(bridge.resolveDesktopWindows(71))
  const request = (yield* Deferred.await(postedMessage)) as Record<string, unknown>
  assert.equal(postedMessages.length, 1)
  assert.equal(request.version, NATIVE_CONTROL_BRIDGE_VERSION)
  assert.equal(request.type, 'resolve-desktop-windows')
  assert.equal(request.destinationWindowId, 71)
  assert.deepEqual(request.profileWindowIds, [71, 72])

  valueAt(messageListeners, 0)({
    version: NATIVE_CONTROL_BRIDGE_VERSION,
    type: 'response',
    requestId: request.requestId,
    status: 'accepted',
    selectionToken: 'selection-1',
    windowIds: [72, 71],
  })
  assert.deepEqual(yield* Fiber.join(selectionFiber), {
    selectionToken: 'selection-1',
    windowIds: [72, 71],
  })
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native bridge rejects an oversized profile window inventory before transport', () => Effect.gen(function* () {
  const messageListeners: Array<(message: unknown) => void> = []
  const postedMessages: unknown[] = []
  const noOp = () => {}
  const chromeApi = {
    runtime: {
      async sendMessage() {},
      connectNative() {
        return {
          disconnect() {},
          onMessage: {
            addListener(listener: (message: unknown) => void) {
              messageListeners.push(listener)
            },
            removeListener: noOp,
          },
          onDisconnect: { addListener: noOp, removeListener: noOp },
          postMessage(message: unknown) {
            postedMessages.push(message)
          },
        }
      },
    },
    windows: {
      async getAll() {
        return Array.from({ length: 513 }, (_, index) => ({
          id: index + 1,
          type: 'normal',
          state: 'normal',
        }))
      },
    },
  } as unknown as ChromeApi

  const scope = yield* Scope.make()
  const context = yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  const bridge = Context.get(context, NativePlacementBridge)
  valueAt(messageListeners, 0)({
    version: NATIVE_CONTROL_BRIDGE_VERSION,
    type: 'controller-status',
    connected: true,
    capabilities: [NATIVE_MERGE_DESKTOP_CAPABILITY],
  })
  yield* Effect.yieldNow

  const result = yield* Effect.exit(bridge.resolveDesktopWindows(71))
  assert.equal(Exit.isFailure(result), true)
  assert.deepEqual(postedMessages, [])
  yield* Scope.close(scope, Exit.void)
}))

it.effect('native placement bridge reconnects after the host port disconnects', () => Effect.gen(function* () {
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
            removeListener() {},
          },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener: noOp,
          },
          postMessage() {},
        }
      },
    },
  } as unknown as ChromeApi

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  assert.equal(connectionCount, 1)

  valueAt(disconnectListeners, 0)()
  yield* TestClock.adjust(250)

  assert.equal(connectionCount, 2)
}))

it.effect('native placement bridge escalates delays across connection failures', () => Effect.gen(function* () {
  let connectionCount = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const chromeApi = {
    runtime: {
      connectNative() {
        connectionCount += 1
        if (connectionCount < 3) throw new Error('Native host unavailable')
        return {
          disconnect() {},
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener() {}, removeListener() {} },
          postMessage() {},
        }
      },
    },
  } as unknown as ChromeApi

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  assert.equal(connectionCount, 1)

  yield* TestClock.adjust(249)
  assert.equal(connectionCount, 1)
  yield* TestClock.adjust(1)
  assert.equal(connectionCount, 2)

  yield* TestClock.adjust(999)
  assert.equal(connectionCount, 2)
  yield* TestClock.adjust(1)
  assert.equal(connectionCount, 3)
}))

it.effect('native placement bridge backs off beyond the MV3 idle window when the host stays unavailable', () => Effect.gen(function* () {
  let connectionCount = 0
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { chromeApi } = createChromeApi()
  chromeApi.runtime.connectNative = () => {
    connectionCount += 1
    throw new Error('Native host unavailable')
  }

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  assert.equal(connectionCount, 1)

  yield* TestClock.adjust(250)
  assert.equal(connectionCount, 2)
  yield* TestClock.adjust(1_000)
  assert.equal(connectionCount, 3)
  yield* TestClock.adjust(5_000)
  assert.equal(connectionCount, 4)

  yield* TestClock.adjust(30_000)
  assert.equal(connectionCount, 4)
}))

it.effect('native placement bridge resets backoff after a native message', () => Effect.gen(function* () {
  vi.useFakeTimers({ now: nowMs, toFake: ['Date'] })
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  let connectionCount = 0
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
            removeListener() {},
          },
          onDisconnect: {
            addListener(listener: () => void) {
              disconnectListeners.push(listener)
            },
            removeListener() {},
          },
          postMessage() {},
        }
      },
    },
  } as unknown as ChromeApi

  yield* Layer.build(makeNativePlacementBridgeLayer(chromeApi))
  valueAt(disconnectListeners, 0)()
  yield* TestClock.adjust(250)
  assert.equal(connectionCount, 2)

  valueAt(messageListeners, 1)(createRequest({ type: 'status' }))
  yield* Effect.yieldNow
  valueAt(disconnectListeners, 1)()
  yield* TestClock.adjust(249)
  assert.equal(connectionCount, 2)
  yield* TestClock.adjust(1)
  assert.equal(connectionCount, 3)
}))

it.effect('disposing the native placement bridge cancels reconnect sleep', () => Effect.gen(function* () {
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
            removeListener() {},
          },
          postMessage() {},
        }
      },
    },
  } as unknown as ChromeApi

  const scope = yield* Scope.make()
  yield* Layer.buildWithScope(makeNativePlacementBridgeLayer(chromeApi), scope)
  valueAt(disconnectListeners, 0)()
  yield* Scope.close(scope, Exit.void)

  yield* TestClock.adjust(15_000)
  assert.equal(connectionCount, 1)
}))
