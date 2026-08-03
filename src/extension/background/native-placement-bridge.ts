import {
  Context,
  Effect,
  Layer,
  Result,
  Schema
} from 'effect'

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

class NativePlacementOperationError extends Schema.TaggedErrorClass<NativePlacementOperationError>()(
  'NativePlacementOperationError',
  { cause: Schema.Defect() }
) {}

class NativePlacementConnectionError extends Schema.TaggedErrorClass<NativePlacementConnectionError>()(
  'NativePlacementConnectionError',
  { cause: Schema.Defect() }
) {}

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

export class NativePlacementBridge extends Context.Service<NativePlacementBridge, {
  readonly version: typeof NATIVE_PLACEMENT_BRIDGE_VERSION
}>()('@tab-out/background/NativePlacementBridge') {
  static layer(chromeApi: ChromeApi): Layer.Layer<NativePlacementBridge> {
    return makeNativePlacementBridgeLayer(chromeApi)
  }
}

function makeNativePlacementBridgeLayer(
  chromeApi: ChromeApi
): Layer.Layer<NativePlacementBridge> {
  return Layer.effect(NativePlacementBridge, Effect.gen(function*() {
    const scope = yield* Effect.scope
    const runtimeApi = chromeApi.runtime
    const service = NativePlacementBridge.of({ version: NATIVE_PLACEMENT_BRIDGE_VERSION })
    if (!runtimeApi || typeof runtimeApi.connectNative !== 'function') return service
    let reconnectAttempt = 0

    function runInLayer(effect: Effect.Effect<void>): void {
      Effect.runSync(effect.pipe(
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid
      ))
    }

    const replyToNativeMessage = Effect.fn('NativePlacementBridge.reply')(function*(
      port: chrome.runtime.Port,
      message: unknown
    ) {
      const result = yield* runNativePlacementBridgeMessage(message, chromeApi, Date.now())
      yield* Effect.try({
        try: () => port.postMessage(result),
        catch: (cause) => NativePlacementOperationError.make({ cause })
      }).pipe(
        Effect.catchTag('NativePlacementOperationError', (error) => Effect.sync(() => {
          console.warn(
            'Tab Out native placement bridge could not reply:',
            errorMessage(error.cause)
          )
        }))
      )
    })

    const connectUntilDisconnected = Effect.fn('NativePlacementBridge.connect')(function*() {
      const port = yield* Effect.try({
        try: () => runtimeApi.connectNative(NATIVE_PLACEMENT_HOST_NAME),
        catch: (cause) => NativePlacementConnectionError.make({ cause })
      })

      yield* Effect.callback<void>((resume) => {
        let disconnected = false

        const onMessage = (message: unknown) => {
          reconnectAttempt = 0
          runInLayer(replyToNativeMessage(port, message))
        }
        const removeListeners = () => {
          port.onMessage.removeListener(onMessage)
          port.onDisconnect.removeListener(onDisconnect)
        }
        const onDisconnect = () => {
          if (disconnected) return
          disconnected = true
          removeListeners()
          const disconnectError = runtimeApi.lastError
          if (disconnectError?.message) {
            console.info(
              'Tab Out native placement bridge disconnected:',
              disconnectError.message
            )
          }
          resume(Effect.void)
        }

        port.onMessage.addListener(onMessage)
        port.onDisconnect.addListener(onDisconnect)

        return Effect.sync(() => {
          if (disconnected) return
          disconnected = true
          removeListeners()
          try {
            port.disconnect()
          } catch {}
        })
      })
    })

    const reconnect = Effect.fn('NativePlacementBridge.reconnect')(function*() {
      const connection = yield* Effect.result(connectUntilDisconnected())
      if (Result.isFailure(connection)) {
        yield* Effect.sync(() => {
          console.warn(
            'Tab Out native placement bridge could not connect:',
            errorMessage(connection.failure.cause)
          )
        })
      }

      const delayIndex = Math.min(
        reconnectAttempt,
        NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.length - 1
      )
      const delay = NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.at(delayIndex) ?? 15_000
      reconnectAttempt += 1
      yield* Effect.sleep(delay)
    })

    yield* reconnect().pipe(
      Effect.forever,
      Effect.forkIn(scope, { startImmediately: true })
    )

    return service
  }))
}
