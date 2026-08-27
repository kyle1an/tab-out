import {
  Context,
  Deferred,
  Effect,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
} from 'effect'

import { omitUndefined } from '../../lib/omit-undefined.js'
import { DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE } from '../desktop-window-merge-contract.js'
import type { ChromeApi } from './chrome-api.js'
import {
  createInactiveWindow,
  type TargetDisplayBounds,
} from './native-window-placement.js'

export const NATIVE_PLACEMENT_BRIDGE_VERSION = 5
export const NATIVE_CONTROL_BRIDGE_VERSION = 6
export const NATIVE_MERGE_DESKTOP_CAPABILITY = 'merge-desktop'
const NATIVE_CONTROL_MAXIMUM_WINDOW_IDS = 512
// The final delay deliberately exceeds Chrome's normal 30-second MV3 idle
// window. A missing optional host can therefore let an otherwise idle worker
// terminate, while a later worker wake restarts the fast reconnect sequence.
const NATIVE_PLACEMENT_UNAVAILABLE_RETRY_MS = 60_000
const NATIVE_PLACEMENT_RECONNECT_DELAYS_MS = [
  250,
  1_000,
  5_000,
  NATIVE_PLACEMENT_UNAVAILABLE_RETRY_MS,
] as const
const NATIVE_PLACEMENT_HOST_NAME = 'com.tabout.native_bridge'

export type NativePlacementBridgeResponse = {
  browserWindowId?: number
  reason?: string
  requestId: string
  status: 'accepted' | 'rejected'
  type: 'response'
  version: typeof NATIVE_PLACEMENT_BRIDGE_VERSION
  windowIds?: number[]
}

const nativeControlRequestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)
const nativeControlWindowIdSchema = Schema.Int.check(Schema.isGreaterThan(0))
const nativeControlCapabilitiesSchema = Schema.Array(Schema.Literals([
  NATIVE_MERGE_DESKTOP_CAPABILITY,
])).check(Schema.isMaxLength(16))
const nativeControlWindowIdsSchema = Schema.Array(nativeControlWindowIdSchema).check(
  Schema.isMaxLength(NATIVE_CONTROL_MAXIMUM_WINDOW_IDS),
)
const nativeControlResponseSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_CONTROL_BRIDGE_VERSION]),
  type: Schema.Literals(['response']),
  requestId: nativeControlRequestIdSchema,
  status: Schema.Literals(['accepted', 'rejected']),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_024))),
  windowIds: Schema.optionalKey(nativeControlWindowIdsSchema),
})
const nativeControllerStatusMessageSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_CONTROL_BRIDGE_VERSION]),
  type: Schema.Literals(['controller-status']),
  connected: Schema.Boolean,
  capabilities: nativeControlCapabilitiesSchema,
})

type NativeControlResponse = typeof nativeControlResponseSchema.Type
type NativeControllerStatusMessage = typeof nativeControllerStatusMessageSchema.Type

const isNativeControlResponse = Schema.is(nativeControlResponseSchema)
const isNativeControllerStatusMessage = Schema.is(nativeControllerStatusMessageSchema)

export interface NativeDesktopWindowSelection {
  readonly selectionToken: string
  readonly windowIds: readonly number[]
}

export interface NativeDesktopControllerStatus {
  readonly capabilities: readonly string[]
  readonly controllerConnected: boolean
  readonly hostConnected: boolean
}

export class NativeDesktopControlError extends Schema.TaggedError<NativeDesktopControlError>()(
  'NativeDesktopControlError',
  { reason: Schema.String },
) {}

export class NativePlacementBridge extends Context.Service<NativePlacementBridge, {
  readonly getStatus: () => Effect.Effect<NativeDesktopControllerStatus>
  readonly resolveDesktopWindows: (
    destinationWindowId: number,
  ) => Effect.Effect<NativeDesktopWindowSelection, NativeDesktopControlError>
  readonly revalidateDesktopWindows: (
    destinationWindowId: number,
    selectionToken: string,
  ) => Effect.Effect<NativeDesktopWindowSelection, NativeDesktopControlError>
}>()('tab-out/background/NativePlacementBridge') {}

class NativePlacementOperationError extends Schema.TaggedError<NativePlacementOperationError>()(
  'NativePlacementOperationError',
  { cause: Schema.Defect() },
) {}

class NativePlacementConnectionError extends Schema.TaggedError<NativePlacementConnectionError>()(
  'NativePlacementConnectionError',
  { cause: Schema.Defect() },
) {}

const nativePlacementRequestRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const nativePlacementRequestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
)
const nativePlacementCoordinateSchema = Schema.Finite.check(
  Schema.isBetween({ minimum: -100_000, maximum: 100_000 }),
)
const nativePlacementDimensionSchema = nativePlacementCoordinateSchema.check(
  Schema.isGreaterThan(0),
)
const nativePlacementTargetBoundsSchema = Schema.Struct({
  left: nativePlacementCoordinateSchema,
  top: nativePlacementCoordinateSchema,
  width: nativePlacementDimensionSchema,
  height: nativePlacementDimensionSchema,
}) satisfies Schema.Schema<TargetDisplayBounds>

const isNativePlacementRequestRecord = Schema.is(nativePlacementRequestRecordSchema)
const isNativePlacementRequestId = Schema.is(nativePlacementRequestIdSchema)
const isNativePlacementRequestTime = Schema.is(Schema.Finite)
const isNativePlacementTargetBounds = Schema.is(nativePlacementTargetBoundsSchema)

function response(
  requestId: string,
  status: NativePlacementBridgeResponse['status'],
  reason?: string,
  windowIds?: number[],
): NativePlacementBridgeResponse {
  return omitUndefined({
    version: NATIVE_PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId,
    status,
    reason: reason || undefined,
    windowIds,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The native placement request failed'
}

export const handleNativePlacementBridgeMessageEffect = Effect.fn('nativePlacementBridge.handleMessage')(function* (
  message: unknown,
  chromeApi: ChromeApi,
  nowMs: number,
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
      catch: (cause) => new NativePlacementOperationError({ cause }),
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
    try: () => createInactiveWindow(operation, targetBounds, requestId, chromeApi),
    catch: (cause) => new NativePlacementOperationError({ cause }),
  }))
  if (Result.isFailure(placementResult)) {
    return response(requestId, 'rejected', errorMessage(placementResult.failure.cause))
  }
  return {
    ...response(requestId, 'accepted'),
    browserWindowId: placementResult.success,
  }
})

export function makeNativePlacementBridgeLayer(
  chromeApi: ChromeApi,
): Layer.Layer<NativePlacementBridge> {
  return Layer.effect(NativePlacementBridge, Effect.gen(function* () {
    const scope = yield* Effect.scope
    const runtimeApi = chromeApi.runtime
    const status = yield* Ref.make<NativeDesktopControllerStatus>({
      capabilities: [],
      controllerConnected: false,
      hostConnected: false,
    })
    const activePort = yield* Ref.make<chrome.runtime.Port | null>(null)
    const pendingControlRequests = yield* Ref.make<ReadonlyMap<
      string,
      Deferred.Deferred<NativeControlResponse, NativeDesktopControlError>
    >>(new Map())
    const incomingMessages = yield* Queue.unbounded<{
      readonly message: unknown
      readonly port: chrome.runtime.Port
    }>()
    let reconnectAttempt = 0

    const controlError = (reason: string) => new NativeDesktopControlError({ reason })

    const notifyControllerStatusChanged = Effect.fn(
      'NativePlacementBridge.notifyControllerStatusChanged',
    )(function* () {
      if (!runtimeApi?.sendMessage) return
      yield* Effect.tryPromise({
        try: () => runtimeApi.sendMessage({
          type: DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE,
        }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void))
    })

    const setControllerStatus = Effect.fn(
      'NativePlacementBridge.setControllerStatus',
    )(function* (next: NativeDesktopControllerStatus) {
      const previous = yield* Ref.get(status)
      if (
        previous.hostConnected === next.hostConnected &&
        previous.controllerConnected === next.controllerConnected &&
        previous.capabilities.length === next.capabilities.length &&
        previous.capabilities.every((capability, index) =>
          next.capabilities[index] === capability)
      ) return
      yield* Ref.set(status, next)
      yield* notifyControllerStatusChanged().pipe(
        Effect.forkChild({ startImmediately: true }),
      )
    })

    const failPendingControlRequests = Effect.fn(
      'NativePlacementBridge.failPendingControlRequests',
    )(function* (reason: string) {
      const pending = yield* Ref.getAndSet(pendingControlRequests, new Map())
      yield* Effect.forEach(
        pending.values(),
        (completion) => Deferred.fail(completion, controlError(reason)),
        { concurrency: 'unbounded', discard: true },
      )
    })

    const updateControllerStatus = Effect.fn(
      'NativePlacementBridge.updateControllerStatus',
    )(function* (message: NativeControllerStatusMessage) {
      const current = yield* Ref.get(status)
      yield* setControllerStatus({
        capabilities: message.capabilities,
        controllerConnected: message.connected,
        hostConnected: current.hostConnected,
      })
    })

    const replyToNativeMessage = Effect.fn('NativePlacementBridge.reply')(function* (
      port: chrome.runtime.Port,
      message: unknown,
    ) {
      if ((yield* Ref.get(activePort)) !== port) return
      if (isNativeControllerStatusMessage(message)) {
        yield* updateControllerStatus(message)
        return
      }
      if (isNativeControlResponse(message)) {
        const completion = (yield* Ref.get(pendingControlRequests)).get(message.requestId)
        if (completion) yield* Deferred.succeed(completion, message)
        return
      }

      const result = yield* handleNativePlacementBridgeMessageEffect(message, chromeApi, Date.now())
      yield* Effect.try({
        try: () => port.postMessage(result),
        catch: (cause) => NativePlacementOperationError.make({ cause }),
      }).pipe(
        Effect.catchTag('NativePlacementOperationError', (error) => Effect.sync(() => {
          console.warn(
            'Tab Out native placement bridge could not reply:',
            errorMessage(error.cause),
          )
        })),
      )
    })

    yield* Queue.take(incomingMessages).pipe(
      Effect.flatMap(({ port, message }) => replyToNativeMessage(port, message).pipe(
        Effect.forkChild({ startImmediately: true }),
      )),
      Effect.forever,
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const connectUntilDisconnected = Effect.fn('NativePlacementBridge.connect')(function* () {
      if (!runtimeApi || typeof runtimeApi.connectNative !== 'function') {
        return yield* Effect.fail(NativePlacementConnectionError.make({
          cause: new Error('Native messaging is unavailable'),
        }))
      }
      const port = yield* Effect.try({
        try: () => runtimeApi.connectNative(NATIVE_PLACEMENT_HOST_NAME),
        catch: (cause) => NativePlacementConnectionError.make({ cause }),
      })
      yield* Ref.set(activePort, port)
      yield* setControllerStatus({
        capabilities: [],
        controllerConnected: false,
        hostConnected: true,
      })

      yield* Effect.callback<void>((resume) => {
        let disconnected = false

        const onMessage = (message: unknown) => {
          reconnectAttempt = 0
          Queue.offerUnsafe(incomingMessages, { port, message })
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
              disconnectError.message,
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
      yield* Ref.update(activePort, (current) => current === port ? null : current)
      yield* setControllerStatus({
        capabilities: [],
        controllerConnected: false,
        hostConnected: false,
      })
      yield* failPendingControlRequests('The native bridge disconnected')
    })

    const reconnect = Effect.fn('NativePlacementBridge.reconnect')(function* () {
      const connection = yield* Effect.result(connectUntilDisconnected())
      if (Result.isFailure(connection)) {
        yield* Effect.sync(() => {
          console.warn(
            'Tab Out native placement bridge could not connect:',
            errorMessage(connection.failure.cause),
          )
        })
      }

      const delayIndex = Math.min(
        reconnectAttempt,
        NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.length - 1,
      )
      const delay = NATIVE_PLACEMENT_RECONNECT_DELAYS_MS.at(delayIndex) ??
        NATIVE_PLACEMENT_UNAVAILABLE_RETRY_MS
      reconnectAttempt += 1
      yield* Effect.sleep(delay)
    })

    yield* reconnect().pipe(
      Effect.forever,
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const readProfileWindowIds = Effect.fn(
      'NativePlacementBridge.readProfileWindowIds',
    )(function* () {
      const windows = yield* Effect.tryPromise({
        try: () => chromeApi.windows.getAll({ windowTypes: ['normal'] }),
        catch: (cause) => controlError(errorMessage(cause)),
      })
      const windowIds: number[] = []
      for (const window of windows) {
        if (
          window.type === 'normal' &&
          window.state !== 'minimized' &&
          Number.isInteger(window.id) &&
          (window.id ?? 0) > 0
        ) windowIds.push(window.id as number)
      }
      if (windowIds.length > NATIVE_CONTROL_MAXIMUM_WINDOW_IDS) {
        return yield* Effect.fail(controlError(
          'The configured-profile window inventory is too large',
        ))
      }
      return windowIds
    })

    const requestControl = Effect.fn('NativePlacementBridge.requestControl')(function* (
      type: 'resolve-desktop-windows' | 'revalidate-desktop-windows',
      destinationWindowId: number,
      selectionToken?: string,
    ) {
      const port = yield* Ref.get(activePort)
      if (!port) return yield* Effect.fail(controlError('The native bridge is not connected'))
      const currentStatus = yield* Ref.get(status)
      if (
        !currentStatus.controllerConnected ||
        !currentStatus.capabilities.includes(NATIVE_MERGE_DESKTOP_CAPABILITY)
      ) {
        return yield* Effect.fail(controlError(
          'The Hammerspoon desktop-window controller is not connected',
        ))
      }

      const profileWindowIds = yield* readProfileWindowIds()
      if (!profileWindowIds.includes(destinationWindowId)) {
        return yield* Effect.fail(controlError(
          'The invoking Tab Out window is not an eligible profile window',
        ))
      }

      const requestId = `extension-control-${crypto.randomUUID()}`
      const completion = yield* Deferred.make<
        NativeControlResponse,
        NativeDesktopControlError
      >()
      yield* Ref.update(pendingControlRequests, (current) => {
        const next = new Map(current)
        next.set(requestId, completion)
        return next
      })
      const removePending = Ref.update(pendingControlRequests, (current) => {
        if (current.get(requestId) !== completion) return current
        const next = new Map(current)
        next.delete(requestId)
        return next
      })

      const result = yield* Effect.try({
        try: () => port.postMessage(omitUndefined({
          version: NATIVE_CONTROL_BRIDGE_VERSION,
          type,
          requestId,
          expiresAtMs: Date.now() + 5_000,
          destinationWindowId,
          profileWindowIds,
          selectionToken,
        })),
        catch: (cause) => controlError(errorMessage(cause)),
      }).pipe(
        Effect.andThen(Deferred.await(completion)),
        Effect.timeoutOrElse({
          duration: '6 seconds',
          orElse: () => Effect.fail(controlError('The native control request timed out')),
        }),
        Effect.ensuring(removePending),
      )

      if (result.status === 'rejected') {
        return yield* Effect.fail(controlError(
          result.reason || 'The desktop-window controller rejected the request',
        ))
      }
      if (
        !result.windowIds ||
        !result.windowIds.includes(destinationWindowId) ||
        new Set(result.windowIds).size !== result.windowIds.length
      ) {
        return yield* Effect.fail(controlError(
          'The desktop-window controller returned an invalid window selection',
        ))
      }
      return {
        selectionToken: selectionToken ?? requestId,
        windowIds: result.windowIds,
      }
    })

    return NativePlacementBridge.of({
      getStatus: () => Ref.get(status),
      resolveDesktopWindows: (destinationWindowId) => requestControl(
        'resolve-desktop-windows',
        destinationWindowId,
      ),
      revalidateDesktopWindows: (destinationWindowId, selectionToken) => requestControl(
        'revalidate-desktop-windows',
        destinationWindowId,
        selectionToken,
      ),
    })
  }))
}
