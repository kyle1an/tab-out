import { Data, Effect, Result, Schema } from 'effect'

import type { ChromeApi } from './chrome-api.js'
import {
  createInactiveWindow,
  type TargetDisplayBounds
} from './native-window-placement.js'

export const NATIVE_PLACEMENT_BRIDGE_VERSION = 1
const NATIVE_PLACEMENT_RECONNECT_DELAYS_MS = [250, 1_000, 5_000, 15_000] as const
const NATIVE_PLACEMENT_HOST_NAME = 'com.tabout.native_bridge'

export type NativePlacementBridgeResponse = {
  reason?: string
  requestId: string
  status: 'accepted' | 'rejected'
  type: 'response'
  version: typeof NATIVE_PLACEMENT_BRIDGE_VERSION
  windowIds?: number[]
}

class NativePlacementOperationError extends Data.TaggedError('NativePlacementOperationError')<{
  readonly cause: unknown
}> {}

const nativePlacementRequestRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const nativePlacementRequestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/)
)
const nativePlacementCoordinateSchema = Schema.Finite.check(
  Schema.isBetween({ minimum: -100_000, maximum: 100_000 })
)
const nativePlacementDimensionSchema = nativePlacementCoordinateSchema.check(
  Schema.isGreaterThan(0)
)
const nativePlacementTargetBoundsSchema = Schema.Struct({
  left: nativePlacementCoordinateSchema,
  top: nativePlacementCoordinateSchema,
  width: nativePlacementDimensionSchema,
  height: nativePlacementDimensionSchema
}) satisfies Schema.Schema<TargetDisplayBounds>

const isNativePlacementRequestRecord = Schema.is(nativePlacementRequestRecordSchema)
const isNativePlacementRequestId = Schema.is(nativePlacementRequestIdSchema)
const isNativePlacementRequestTime = Schema.is(Schema.Finite)
const isNativePlacementTargetBounds = Schema.is(nativePlacementTargetBoundsSchema)

function response(
  requestId: string,
  status: NativePlacementBridgeResponse['status'],
  reason?: string,
  windowIds?: number[]
): NativePlacementBridgeResponse {
  return {
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId,
    status,
    ...(reason ? { reason } : {}),
    ...(windowIds ? { windowIds } : {})
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The native placement request failed'
}

const runNativePlacementBridgeMessage = Effect.fn('nativePlacementBridge.handleMessage')(function*(
  message: unknown,
  chromeApi: ChromeApi,
  nowMs: number
) {
  if (!isNativePlacementRequestRecord(message)) {
    return response('invalid', 'rejected', 'The native placement request is not an object')
  }

  const candidate = message
  const requestId = isNativePlacementRequestId(candidate.requestId) ? candidate.requestId : 'invalid'
  if (candidate.version !== NATIVE_PLACEMENT_BRIDGE_VERSION) {
    return response(requestId, 'rejected', 'The native placement protocol version is unsupported')
  }
  if (!isNativePlacementRequestId(candidate.requestId)) {
    return response(requestId, 'rejected', 'The native placement request ID is invalid')
  }
  if (!isNativePlacementRequestTime(candidate.expiresAtMs) || candidate.expiresAtMs < nowMs) {
    return response(requestId, 'rejected', 'The native placement request expired')
  }

  if (candidate.type === 'status') {
    return response(requestId, 'accepted')
  }
  if (candidate.type === 'list-profile-windows') {
    const windowsResult = yield* Effect.result(Effect.tryPromise({
      try: () => chromeApi.windows.getAll({ windowTypes: ['normal'] }),
      catch: (cause) => new NativePlacementOperationError({ cause })
    }))
    if (Result.isFailure(windowsResult)) {
      return response(requestId, 'rejected', errorMessage(windowsResult.failure.cause))
    }
    const windowIds = windowsResult.success
      .filter((window) => window.type === 'normal' && window.state !== 'minimized')
      .map((window) => window.id)
      .filter((windowId): windowId is number => (
        Number.isInteger(windowId) && (windowId ?? 0) > 0
      ))
    return response(requestId, 'accepted', undefined, windowIds)
  }
  if (candidate.type !== 'create-window') {
    return response(requestId, 'rejected', 'The native placement request type is unsupported')
  }
  if (candidate.operation !== 'filter' && candidate.operation !== 'newPage') {
    return response(requestId, 'rejected', 'The native placement operation is invalid')
  }
  if (!isNativePlacementTargetBounds(candidate.targetBounds)) {
    return response(requestId, 'rejected', 'The native placement target bounds are invalid')
  }
  const operation = candidate.operation
  const targetBounds = candidate.targetBounds

  const placementResult = yield* Effect.result(Effect.tryPromise({
    try: () => createInactiveWindow(operation, targetBounds, chromeApi),
    catch: (cause) => new NativePlacementOperationError({ cause })
  }))
  if (Result.isFailure(placementResult)) {
    return response(requestId, 'rejected', errorMessage(placementResult.failure.cause))
  }
  return response(requestId, 'accepted')
})

export function handleNativePlacementBridgeMessage(
  message: unknown,
  chromeApi: ChromeApi = chrome,
  nowMs = Date.now()
): Promise<NativePlacementBridgeResponse> {
  return Effect.runPromise(runNativePlacementBridgeMessage(message, chromeApi, nowMs))
}

export function connectNativePlacementBridge(chromeApi: ChromeApi = chrome): void {
  let activePort: chrome.runtime.Port | null = null
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return
    const delayIndex = Math.min(reconnectAttempt, NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.length - 1)
    const delay = NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.at(delayIndex) ?? 15_000
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  async function replyToNativeMessage(
    port: chrome.runtime.Port,
    message: unknown
  ): Promise<void> {
    try {
      const result = await handleNativePlacementBridgeMessage(message, chromeApi)
      port.postMessage(result)
    } catch (error) {
      console.warn('Tab Out native placement bridge could not reply:', errorMessage(error))
    }
  }

  function connect(): void {
    let port: chrome.runtime.Port
    try {
      port = chromeApi.runtime.connectNative(NATIVE_PLACEMENT_HOST_NAME)
    } catch (error) {
      console.warn('Tab Out native placement bridge could not connect:', errorMessage(error))
      scheduleReconnect()
      return
    }
    activePort = port

    port.onMessage.addListener((message: unknown) => {
      reconnectAttempt = 0
      void replyToNativeMessage(port, message)
    })

    port.onDisconnect.addListener(() => {
      if (activePort !== port) return
      activePort = null
      const disconnectError = chromeApi.runtime.lastError
      if (disconnectError?.message) {
        console.info('Tab Out native placement bridge disconnected:', disconnectError.message)
      }
      scheduleReconnect()
    })
  }

  connect()
}
