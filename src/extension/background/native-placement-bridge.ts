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

const NATIVE_PROFILE_SELECTION_VERSION = 1
export const NATIVE_PLACEMENT_BRIDGE_VERSION = 6
export const NATIVE_CONTROL_BRIDGE_VERSION = 7
export const NATIVE_MERGE_DESKTOP_CAPABILITY = 'merge-desktop'
const NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY =
  'nativeIntegrationProfileIdV1'
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
const nativeProfileIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const nativeProfileSelectionStatusMessageSchema = Schema.Struct({
  version: Schema.Literals([NATIVE_PROFILE_SELECTION_VERSION]),
  type: Schema.Literals(['profile-selection-status']),
  selection: Schema.Literals(['another-profile', 'required', 'selected']),
})

type NativeControlResponse = typeof nativeControlResponseSchema.Type
type NativeControllerStatusMessage = typeof nativeControllerStatusMessageSchema.Type
type NativeProfileSelectionStatusMessage =
  typeof nativeProfileSelectionStatusMessageSchema.Type

const isNativeControlResponse = Schema.is(nativeControlResponseSchema)
const isNativeControllerStatusMessage = Schema.is(nativeControllerStatusMessageSchema)
const isNativeProfileId = Schema.is(nativeProfileIdSchema)
const isNativeProfileSelectionStatusMessage = Schema.is(
  nativeProfileSelectionStatusMessageSchema,
)

export interface NativeDesktopWindowSelection {
  readonly selectionToken: string
  readonly windowIds: readonly number[]
}

export interface NativeDesktopControllerStatus {
  readonly capabilities: readonly string[]
  readonly controllerConnected: boolean
  readonly hostConnected: boolean
  readonly profileSelection: 'another-profile' | 'required' | 'selected' | 'unknown'
}

export class NativeDesktopControlError extends Schema.TaggedError<NativeDesktopControlError>()(
  'NativeDesktopControlError',
  { reason: Schema.String },
) {}

export class NativePlacementBridge extends Context.Service<NativePlacementBridge, {
  readonly getStatus: () => Effect.Effect<NativeDesktopControllerStatus>
  readonly selectCurrentProfile: () => Effect.Effect<void, NativeDesktopControlError>
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

async function readOrCreateNativeProfileId(chromeApi: ChromeApi): Promise<string> {
  const storage = chromeApi.storage?.local
  if (!storage) throw new Error('Local extension storage is unavailable')
  const stored = await storage.get(NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY)
  const existing = stored[NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY]
  if (isNativeProfileId(existing)) return existing

  const profileId = crypto.randomUUID()
  await storage.set({ [NATIVE_INTEGRATION_PROFILE_ID_STORAGE_KEY]: profileId })
  return profileId
}

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
      profileSelection: 'unknown',
    })
    const activePort = yield* Ref.make<chrome.runtime.Port | null>(null)
    const pendingProfileSelection = yield* Ref.make<Deferred.Deferred<
      boolean,
      NativeDesktopControlError
    > | null>(null)
    const pendingControlRequests = yield* Ref.make<ReadonlyMap<
      string,
      Deferred.Deferred<NativeControlResponse, NativeDesktopControlError>
    >>(new Map())
    const incomingMessages = yield* Queue.unbounded<{
      readonly disconnect: () => void
      readonly message: unknown
      readonly port: chrome.runtime.Port
    }>()
    let reconnectAttempt = 0
    let cachedProfileId: string | null = null

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
        previous.profileSelection === next.profileSelection &&
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

    const failPendingProfileSelection = Effect.fn(
      'NativePlacementBridge.failPendingProfileSelection',
    )(function* (reason: string) {
      const completion = yield* Ref.getAndSet(pendingProfileSelection, null)
      if (completion) yield* Deferred.fail(completion, controlError(reason))
    })

    const updateControllerStatus = Effect.fn(
      'NativePlacementBridge.updateControllerStatus',
    )(function* (message: NativeControllerStatusMessage) {
      const current = yield* Ref.get(status)
      if (current.profileSelection !== 'selected') return
      yield* setControllerStatus({
        capabilities: message.capabilities,
        controllerConnected: message.connected,
        hostConnected: current.hostConnected,
        profileSelection: current.profileSelection,
      })
    })

    const updateProfileSelectionStatus = Effect.fn(
      'NativePlacementBridge.updateProfileSelectionStatus',
    )(function* (message: NativeProfileSelectionStatusMessage) {
      const current = yield* Ref.get(status)
      const profileSelection = message.selection
      yield* setControllerStatus({
        capabilities: profileSelection === 'selected' ? current.capabilities : [],
        controllerConnected: profileSelection === 'selected'
          ? current.controllerConnected
          : false,
        hostConnected: current.hostConnected,
        profileSelection,
      })
      const completion = yield* Ref.getAndSet(pendingProfileSelection, null)
      if (completion) yield* Deferred.succeed(completion, profileSelection === 'selected')
    })

    const replyToNativeMessage = Effect.fn('NativePlacementBridge.reply')(function* (
      port: chrome.runtime.Port,
      message: unknown,
      disconnect: () => void,
    ) {
      if ((yield* Ref.get(activePort)) !== port) return
      if (isNativeProfileSelectionStatusMessage(message)) {
        yield* updateProfileSelectionStatus(message)
        if (message.selection === 'another-profile') {
          yield* Effect.sync(disconnect)
        }
        return
      }
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
      Effect.flatMap(({ disconnect, message, port }) => {
        const reply = replyToNativeMessage(port, message, disconnect)
        if (
          isNativeProfileSelectionStatusMessage(message) ||
          isNativeControllerStatusMessage(message) ||
          isNativeControlResponse(message)
        ) return reply
        return reply.pipe(
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      }),
      Effect.forever,
      Effect.forkIn(scope, { startImmediately: true }),
    )

    const connectUntilDisconnected = Effect.fn('NativePlacementBridge.connect')(function* () {
      if (!runtimeApi || typeof runtimeApi.connectNative !== 'function') {
        return yield* Effect.fail(NativePlacementConnectionError.make({
          cause: new Error('Native messaging is unavailable'),
        }))
      }
      const profileId = cachedProfileId ?? (yield* Effect.tryPromise({
        try: () => readOrCreateNativeProfileId(chromeApi),
        catch: (cause) => NativePlacementConnectionError.make({ cause }),
      }))
      cachedProfileId = profileId
      const port = yield* Effect.try({
        try: () => runtimeApi.connectNative(NATIVE_PLACEMENT_HOST_NAME),
        catch: (cause) => NativePlacementConnectionError.make({ cause }),
      })
      yield* Ref.set(activePort, port)
      yield* setControllerStatus({
        capabilities: [],
        controllerConnected: false,
        hostConnected: true,
        profileSelection: 'unknown',
      })

      yield* Effect.callback<void>((resume) => {
        let disconnected = false

        const removeListeners = () => {
          port.onMessage.removeListener(onMessage)
          port.onDisconnect.removeListener(onDisconnect)
        }
        const finishDisconnect = () => {
          if (disconnected) return
          disconnected = true
          removeListeners()
          resume(Effect.void)
        }
        const disconnect = () => {
          if (disconnected) return
          finishDisconnect()
          try {
            port.disconnect()
          } catch {}
        }
        const onMessage = (message: unknown) => {
          reconnectAttempt = 0
          Queue.offerUnsafe(incomingMessages, { disconnect, message, port })
        }
        const onDisconnect = () => {
          const disconnectError = runtimeApi.lastError
          if (disconnected) return
          finishDisconnect()
          if (disconnectError?.message) {
            console.info(
              'Tab Out native placement bridge disconnected:',
              disconnectError.message,
            )
          }
        }

        port.onMessage.addListener(onMessage)
        port.onDisconnect.addListener(onDisconnect)

        try {
          port.postMessage({
            version: NATIVE_PROFILE_SELECTION_VERSION,
            type: 'profile-hello',
            profileId,
          })
        } catch (cause) {
          disconnected = true
          removeListeners()
          console.info(
            'Tab Out native placement bridge disconnected:',
            errorMessage(cause),
          )
          resume(Effect.void)
        }

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
      const currentStatus = yield* Ref.get(status)
      yield* setControllerStatus({
        capabilities: [],
        controllerConnected: false,
        hostConnected: false,
        profileSelection: currentStatus.profileSelection,
      })
      yield* failPendingProfileSelection('The native bridge disconnected')
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

      if ((yield* Ref.get(status)).profileSelection === 'another-profile') {
        return yield* Effect.never
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

    const selectCurrentProfile = Effect.fn(
      'NativePlacementBridge.selectCurrentProfile',
    )(function* () {
      const currentStatus = yield* Ref.get(status)
      if (currentStatus.profileSelection === 'selected') return
      if (currentStatus.profileSelection === 'another-profile') {
        return yield* Effect.fail(controlError(
          'Another Chrome profile is already selected for the macOS integration',
        ))
      }
      if (currentStatus.profileSelection !== 'required') {
        return yield* Effect.fail(controlError(
          'The native bridge profile-selection status is unavailable',
        ))
      }

      const port = yield* Ref.get(activePort)
      const profileId = cachedProfileId
      if (!port || !profileId) {
        return yield* Effect.fail(controlError('The native bridge is not connected'))
      }
      const completion = yield* Deferred.make<boolean, NativeDesktopControlError>()
      const installed = yield* Ref.modify(pendingProfileSelection, (current) => (
        current ? [false, current] : [true, completion]
      ))
      if (!installed) {
        return yield* Effect.fail(controlError(
          'Native bridge profile selection is already in progress',
        ))
      }
      const removePending = Ref.update(pendingProfileSelection, (current) =>
        current === completion ? null : current)
      const selected = yield* Effect.try({
        try: () => port.postMessage({
          version: NATIVE_PROFILE_SELECTION_VERSION,
          type: 'select-profile',
          profileId,
        }),
        catch: (cause) => controlError(errorMessage(cause)),
      }).pipe(
        Effect.andThen(Deferred.await(completion)),
        Effect.timeoutOrElse({
          duration: '6 seconds',
          orElse: () => Effect.fail(controlError(
            'The native bridge profile-selection request timed out',
          )),
        }),
        Effect.ensuring(removePending),
      )
      if (!selected) {
        return yield* Effect.fail(controlError(
          'Another Chrome profile was selected first for the macOS integration',
        ))
      }
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
      selectCurrentProfile,
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
