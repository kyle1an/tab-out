import { once } from 'node:events'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import process from 'node:process'

import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Cause,
  Clock,
  Console,
  Effect,
  Fiber,
  FileSystem,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream,
} from 'effect'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

import { omitUndefined } from '../../src/lib/omit-undefined.ts'

const PLACEMENT_BRIDGE_VERSION = 5
const CONTROL_BRIDGE_VERSION = 6

class NativeHostTestError extends Schema.TaggedError<NativeHostTestError>()(
  'NativeHostTestError',
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `${this.operation}: ${detail}`
  }
}

class NativeSocketPending extends Schema.TaggedError<NativeSocketPending>()(
  'NativeSocketPending',
  { socketPath: Schema.String },
) {}

const NativeRequest = Schema.Struct({
  version: Schema.Literal(PLACEMENT_BRIDGE_VERSION),
  type: Schema.Literal('status'),
  requestId: Schema.String,
  expiresAtMs: Schema.Number,
})

const AcceptedResponse = Schema.Struct({
  version: Schema.Literal(PLACEMENT_BRIDGE_VERSION),
  type: Schema.Literal('response'),
  requestId: Schema.Literal('integration-round-trip'),
  status: Schema.Literal('accepted'),
  browserProcessId: Schema.Int.check(Schema.isGreaterThan(1)),
})

const RejectedProcessResponse = Schema.Struct({
  version: Schema.Literal(PLACEMENT_BRIDGE_VERSION),
  type: Schema.Literal('response'),
  requestId: Schema.Literal('process-authority-mismatch'),
  status: Schema.Literal('rejected'),
  reason: Schema.String,
})

const AcceptedProcessResponse = Schema.Struct({
  version: Schema.Literal(PLACEMENT_BRIDGE_VERSION),
  type: Schema.Literal('response'),
  requestId: Schema.Literal('process-authority-match'),
  status: Schema.Literal('accepted'),
  browserProcessId: Schema.Int.check(Schema.isGreaterThan(1)),
  browserWindowId: Schema.Literal(303),
})

type RunningNativeHost = {
  readonly handle: ChildProcessSpawner.ChildProcessHandle
  readonly input: Queue.Queue<Uint8Array, Cause.Done<void>>
  readonly stdoutFiber: Fiber.Fiber<void, NativeHostTestError>
  readonly stderrFiber: Fiber.Fiber<void, NativeHostTestError>
  readonly stderr: Ref.Ref<string>
  readonly nativeMessages: Queue.Queue<unknown> | null
}

type NativeOutputMode = 'capture' | 'ignore' | 'respond-placement'

function nativeHostTestError(operation: string, cause: unknown): NativeHostTestError {
  return NativeHostTestError.make({ operation, cause })
}

function check(
  condition: boolean,
  operation: string,
  message: string,
): Effect.Effect<void, NativeHostTestError> {
  return condition
    ? Effect.void
    : Effect.fail(nativeHostTestError(operation, new Error(message)))
}

function collectText<E, R>(stream: Stream.Stream<Uint8Array, E, R>): Effect.Effect<string, E, R> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(() => '', (output, chunk) => output + chunk),
  )
}

function encodeNativeMessage(message: unknown): Effect.Effect<Uint8Array, NativeHostTestError> {
  return Effect.try({
    try: () => {
      const body = Buffer.from(JSON.stringify(message))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32LE(body.length)
      return Buffer.concat([prefix, body])
    },
    catch: (cause) => nativeHostTestError('encode native messaging response', cause),
  })
}

type NativeMessageHandler = (
  message: unknown,
) => Effect.Effect<void, NativeHostTestError>

function makeNativeMessageDecoder(
  operation: string,
  handleMessage: NativeMessageHandler,
) {
  let nativeBuffer = Buffer.alloc(0)

  return Effect.fn('nativeHostTest.decodeNativeMessage')(function* (chunk: Uint8Array) {
    nativeBuffer = Buffer.concat([nativeBuffer, chunk])
    while (nativeBuffer.length >= 4) {
      const messageLength = nativeBuffer.readUInt32LE(0)
      if (messageLength > 64 * 1024) {
        return yield* Effect.fail(nativeHostTestError(
          operation,
          new Error(`native message length ${messageLength} exceeds the protocol limit`),
        ))
      }
      if (nativeBuffer.length < messageLength + 4) return

      const body = nativeBuffer.subarray(4, messageLength + 4)
      nativeBuffer = nativeBuffer.subarray(messageLength + 4)
      const message = yield* Effect.try({
        try: (): unknown => JSON.parse(body.toString('utf8')),
        catch: (cause) => nativeHostTestError(operation, cause),
      })
      yield* handleMessage(message)
    }
  })
}

function makeNativeRequestResponder(input: Queue.Queue<Uint8Array, Cause.Done<void>>) {
  const decodeRequest = Schema.decodeUnknownEffect(
    NativeRequest,
    { onExcessProperty: 'error' },
  )
  const respond = Effect.fn('nativeHostTest.respondToNativeRequest')(function* (
    message: unknown,
  ) {
    const request = yield* decodeRequest(message).pipe(
      Effect.mapError((cause) => nativeHostTestError('decode native messaging request', cause)),
    )
    const response = yield* encodeNativeMessage({
      version: PLACEMENT_BRIDGE_VERSION,
      type: 'response',
      requestId: request.requestId,
      status: 'accepted',
    })
    yield* Queue.offer(input, response)
  })

  return makeNativeMessageDecoder(
    'decode native messaging request',
    respond,
  )
}

function makeNativeMessageCollector(output: Queue.Queue<unknown>) {
  return makeNativeMessageDecoder(
    'decode native messaging output',
    (message) => Queue.offer(output, message),
  )
}

const startNativeHost = Effect.fn('nativeHostTest.startNativeHost')(function* (
  hostPath: string,
  socketPath: string,
  outputMode: NativeOutputMode,
) {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>()
  const nativeMessages = outputMode === 'capture'
    ? yield* Queue.unbounded<unknown>()
    : null
  const stderr = yield* Ref.make('')
  const handle = yield* ChildProcess.make(
    hostPath,
    ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
    {
      env: { TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH: socketPath },
      extendEnv: true,
      stdin: {
        stream: Stream.fromQueue(input),
        endOnDone: true,
      },
      stdout: outputMode === 'ignore' ? 'ignore' : 'pipe',
      stderr: 'pipe',
    },
  ).pipe(
    Effect.mapError((cause) => nativeHostTestError('start native host', cause)),
  )

  const stdoutFiber = yield* (outputMode === 'respond-placement'
    ? handle.stdout.pipe(
        Stream.mapError((cause) => nativeHostTestError('read native host stdout', cause)),
        Stream.runForEach(makeNativeRequestResponder(input)),
      )
    : outputMode === 'capture' && nativeMessages
      ? handle.stdout.pipe(
          Stream.mapError((cause) => nativeHostTestError('read native host stdout', cause)),
          Stream.runForEach(makeNativeMessageCollector(nativeMessages)),
        )
      : Effect.void
  ).pipe(Effect.forkScoped)
  const stderrFiber = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.mapError((cause) => nativeHostTestError('read native host stderr', cause)),
    Stream.runForEach((chunk) => Ref.update(stderr, (current) => current + chunk)),
    Effect.forkScoped,
  )

  yield* Effect.addFinalizer(() => Queue.end(input).pipe(
    Effect.andThen(handle.exitCode),
    Effect.asVoid,
    Effect.timeoutOrElse({
      duration: '2 seconds',
      orElse: () => handle.kill(),
    }),
    Effect.ignoreCause,
  ))

  return {
    handle,
    input,
    stdoutFiber,
    stderrFiber,
    stderr,
    nativeMessages,
  } satisfies RunningNativeHost
})

const finishNativeHost = Effect.fn('nativeHostTest.finishNativeHost')(function* (
  host: RunningNativeHost,
) {
  yield* Queue.end(host.input)
  const exitCode = yield* host.handle.exitCode.pipe(
    Effect.mapError((cause) => nativeHostTestError('wait for native host', cause)),
    Effect.timeoutOrElse({
      duration: '2 seconds',
      orElse: () => host.handle.kill().pipe(
        Effect.mapError((cause) => nativeHostTestError('stop native host', cause)),
        Effect.andThen(host.handle.exitCode),
        Effect.mapError((cause) => nativeHostTestError('wait for stopped native host', cause)),
      ),
    }),
  )
  yield* Fiber.join(host.stdoutFiber)
  yield* Fiber.join(host.stderrFiber)
  const stderr = yield* Ref.get(host.stderr)
  return { exitCode, stderr }
})

const waitForSocket = Effect.fn('nativeHostTest.waitForSocket')(function* (
  host: RunningNativeHost,
  socketPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const probe = fileSystem.access(socketPath).pipe(
    Effect.mapError(() => NativeSocketPending.make({ socketPath })),
    Effect.catchTag('NativeSocketPending', (pending) => Effect.gen(function* () {
      const isRunning = yield* host.handle.isRunning.pipe(
        Effect.mapError((cause) => nativeHostTestError('inspect native host', cause)),
      )
      if (isRunning) return yield* Effect.fail(pending)

      const exitCode = yield* host.handle.exitCode.pipe(
        Effect.mapError((cause) => nativeHostTestError('wait for early native host exit', cause)),
      )
      const stderr = yield* Ref.get(host.stderr)
      return yield* Effect.fail(nativeHostTestError(
        'wait for native host socket',
        new Error(`native host exited with code ${exitCode}: ${stderr}`),
      ))
    })),
  )

  yield* probe.pipe(
    Effect.retry({
      schedule: Schedule.spaced('50 millis').pipe(Schedule.upTo({ times: 199 })),
      while: (error) => error._tag === 'NativeSocketPending',
    }),
    Effect.catchTag('NativeSocketPending', () => Ref.get(host.stderr).pipe(
      Effect.flatMap((stderr) => Effect.fail(nativeHostTestError(
        'wait for native host socket',
        new Error(`native host did not create ${socketPath} within 10 seconds: ${stderr}`),
      ))),
    )),
  )
})

const runClient = Effect.fn('nativeHostTest.runClient')(function* (
  hostPath: string,
  request: string,
  socketPath?: string,
) {
  const handle = yield* ChildProcess.make(hostPath, ['--request', request], {
    env: omitUndefined({ TAB_OUT_NATIVE_BRIDGE_SOCKET_PATH: socketPath }),
    extendEnv: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('start native host client', cause)),
  )

  const [stdout, stderr, exitCode] = yield* Effect.all([
    collectText(handle.stdout),
    collectText(handle.stderr),
    handle.exitCode,
  ] as const, { concurrency: 'unbounded' }).pipe(
    Effect.mapError((cause) => nativeHostTestError('run native host client', cause)),
  )

  return { stdout, stderr, exitCode }
})

function disposeServer(server: Server): Effect.Effect<void> {
  if (!server.listening) return Effect.void
  return Effect.tryPromise({
    try: () => server[Symbol.asyncDispose](),
    catch: (cause) => nativeHostTestError('close replacement socket server', cause),
  }).pipe(Effect.orDie)
}

function listenOnUnixSocket(socketPath: string) {
  return Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer()),
      disposeServer,
    )
    yield* Effect.tryPromise({
      try: (signal) => {
        server.listen(socketPath)
        return once(server, 'listening', { signal })
      },
      catch: (cause) => nativeHostTestError('start replacement socket server', cause),
    })
    return server
  })
}

type ControllerClient = {
  readonly messages: Queue.Queue<unknown>
  readonly socket: Socket
}

const connectController = Effect.fn('nativeHostTest.connectController')(function* (
  socketPath: string,
) {
  const messages = yield* Queue.unbounded<unknown>()
  const socket = createConnection(socketPath)
  socket.on('error', () => {})
  yield* Effect.tryPromise({
    try: (signal) => once(socket, 'connect', { signal }),
    catch: (cause) => nativeHostTestError('connect desktop-window controller', cause),
  })

  let lineBuffer = ''
  socket.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf8')
    while (true) {
      const newlineIndex = lineBuffer.indexOf('\n')
      if (newlineIndex < 0) return
      const line = lineBuffer.slice(0, newlineIndex)
      lineBuffer = lineBuffer.slice(newlineIndex + 1)
      try {
        Queue.offerUnsafe(messages, JSON.parse(line) as unknown)
      } catch {
        Queue.offerUnsafe(messages, { type: 'invalid-json', line })
      }
    }
  })
  yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()))
  return { messages, socket } satisfies ControllerClient
})

const writeControllerMessage = Effect.fn('nativeHostTest.writeControllerMessage')(function* (
  client: ControllerClient,
  message: unknown,
) {
  yield* Effect.tryPromise({
    try: () => new Promise<void>((resolveWrite, rejectWrite) => {
      client.socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) rejectWrite(error)
        else resolveWrite()
      })
    }),
    catch: (cause) => nativeHostTestError('write desktop-window controller message', cause),
  })
})

function takeMessage(
  queue: Queue.Queue<unknown>,
  operation: string,
): Effect.Effect<unknown, NativeHostTestError> {
  return Queue.take(queue).pipe(Effect.timeoutOrElse({
    duration: '2 seconds',
    orElse: () => Effect.fail(nativeHostTestError(
      operation,
      new Error('timed out waiting for protocol message'),
    )),
  }))
}

function objectMessage(message: unknown): Record<string, unknown> {
  return typeof message === 'object' && message !== null
    ? message as Record<string, unknown>
    : {}
}

const testRoundTrip = Effect.fn('nativeHostTest.roundTrip')(function* (hostPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: 'tab-out-native-bridge-',
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('create round-trip directory', cause)),
  )
  const socketPath = join(temporaryDirectory, 'bridge.sock')
  const host = yield* startNativeHost(hostPath, socketPath, 'respond-placement')
  yield* waitForSocket(host, socketPath)

  const currentTime = yield* Clock.currentTimeMillis
  const request = JSON.stringify({
    version: PLACEMENT_BRIDGE_VERSION,
    type: 'status',
    requestId: 'integration-round-trip',
    expiresAtMs: currentTime + 5_000,
  })
  const client = yield* runClient(hostPath, request, socketPath)
  yield* check(
    client.exitCode === ChildProcessSpawner.ExitCode(0),
    'run round-trip client',
    client.stderr || `client exited with code ${client.exitCode}`,
  )
  yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AcceptedResponse),
    { onExcessProperty: 'error' },
  )(client.stdout).pipe(
    Effect.mapError((cause) => nativeHostTestError('validate round-trip response', cause)),
  )

  const result = yield* finishNativeHost(host)
  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(0),
    'stop round-trip native host',
    `native host exited with code ${result.exitCode}`,
  )
  yield* check(result.stderr === '', 'inspect round-trip native host', result.stderr)
})

const testCreateProcessAuthority = Effect.fn(
  'nativeHostTest.createProcessAuthority',
)(function* (hostPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: 'tab-out-native-process-authority-',
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('create process-authority directory', cause)),
  )
  const socketPath = join(temporaryDirectory, 'bridge.sock')
  const host = yield* startNativeHost(hostPath, socketPath, 'capture')
  yield* waitForSocket(host, socketPath)
  const nativeMessages = host.nativeMessages
  if (!nativeMessages) {
    return yield* Effect.fail(nativeHostTestError(
      'capture process-authority output',
      new Error('native output queue is unavailable'),
    ))
  }

  const currentTime = yield* Clock.currentTimeMillis
  const client = yield* runClient(hostPath, JSON.stringify({
    version: PLACEMENT_BRIDGE_VERSION,
    type: 'create-window',
    requestId: 'process-authority-mismatch',
    expiresAtMs: currentTime + 500,
    expectedBrowserProcessId: 2_147_483_647,
    operation: 'filter',
    targetBounds: { left: 0, top: 0, width: 1_440, height: 900 },
  }), socketPath)
  yield* check(
    client.exitCode === ChildProcessSpawner.ExitCode(0),
    'run mismatched process-authority client',
    client.stderr || `client exited with code ${client.exitCode}`,
  )
  const rejection = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(RejectedProcessResponse),
    { onExcessProperty: 'error' },
  )(client.stdout).pipe(
    Effect.mapError((cause) => nativeHostTestError('validate process-authority rejection', cause)),
  )
  yield* check(
    rejection.reason.includes('browser process does not match'),
    'reject mismatched process authority before forwarding',
    rejection.reason,
  )
  const forwardedCount = yield* Queue.size(nativeMessages)
  yield* check(
    forwardedCount === 0,
    'keep mismatched process authority out of Chrome',
    `forwarded ${forwardedCount} native messages`,
  )

  const matchingRequestId = 'process-authority-match'
  const matchingClientFiber = yield* runClient(hostPath, JSON.stringify({
    version: PLACEMENT_BRIDGE_VERSION,
    type: 'create-window',
    requestId: matchingRequestId,
    expiresAtMs: currentTime + 5_000,
    expectedBrowserProcessId: process.pid,
    operation: 'filter',
    targetBounds: { left: 0, top: 0, width: 1_440, height: 900 },
  }), socketPath).pipe(Effect.forkScoped)
  const forwarded = objectMessage(yield* takeMessage(
    nativeMessages,
    'capture matching process-authority request',
  ))
  yield* check(
    forwarded.requestId === matchingRequestId,
    'forward matching process authority to Chrome',
    JSON.stringify(forwarded),
  )
  yield* check(
    !('expectedBrowserProcessId' in forwarded),
    'strip local process authority before forwarding',
    JSON.stringify(forwarded),
  )
  const nativeResponse = yield* encodeNativeMessage({
    version: PLACEMENT_BRIDGE_VERSION,
    type: 'response',
    requestId: matchingRequestId,
    status: 'accepted',
    browserWindowId: 303,
  })
  yield* Queue.offer(host.input, nativeResponse)
  const matchingClient = yield* Fiber.join(matchingClientFiber)
  yield* check(
    matchingClient.exitCode === ChildProcessSpawner.ExitCode(0),
    'run matching process-authority client',
    matchingClient.stderr || `client exited with code ${matchingClient.exitCode}`,
  )
  const matchingResponse = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(AcceptedProcessResponse),
    { onExcessProperty: 'error' },
  )(matchingClient.stdout).pipe(
    Effect.mapError((cause) => nativeHostTestError('validate matching process response', cause)),
  )
  yield* check(
    matchingResponse.status === 'accepted' && matchingResponse.browserProcessId === process.pid,
    'stamp matching process authority on the local response',
    matchingClient.stdout,
  )

  const result = yield* finishNativeHost(host)
  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(0),
    'stop process-authority native host',
    `native host exited with code ${result.exitCode}`,
  )
  yield* check(result.stderr === '', 'inspect process-authority native host', result.stderr)
})

const testSocketHandoff = Effect.fn('nativeHostTest.socketHandoff')(function* (hostPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: 'tab-out-native-bridge-handoff-',
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('create handoff directory', cause)),
  )
  const socketPath = join(temporaryDirectory, 'bridge.sock')
  const host = yield* startNativeHost(hostPath, socketPath, 'ignore')
  yield* waitForSocket(host, socketPath)
  yield* fileSystem.remove(socketPath).pipe(
    Effect.mapError((cause) => nativeHostTestError('unlink native host socket for handoff', cause)),
  )
  yield* listenOnUnixSocket(socketPath)

  const result = yield* finishNativeHost(host)
  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(0),
    'stop handoff native host',
    `native host exited with code ${result.exitCode}`,
  )
  yield* check(result.stderr === '', 'inspect handoff native host', result.stderr)
  yield* fileSystem.access(socketPath).pipe(
    Effect.mapError((cause) => nativeHostTestError(
      'verify replacement socket after native host shutdown',
      cause,
    )),
  )
})

const testDeadlineOverflow = Effect.fn('nativeHostTest.deadlineOverflow')(function* (hostPath: string) {
  const result = yield* runClient(hostPath, JSON.stringify({
    version: PLACEMENT_BRIDGE_VERSION,
    type: 'status',
    requestId: 'deadline-overflow',
    expiresAtMs: 1e100,
  }))

  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(1),
    'validate overflowing deadline exit code',
    result.stderr || `client exited with code ${result.exitCode}`,
  )
  yield* check(
    /deadline is too far in the future/.test(result.stderr),
    'validate overflowing deadline error',
    result.stderr,
  )
})

const testDesktopControllerRoundTrip = Effect.fn(
  'nativeHostTest.desktopControllerRoundTrip',
)(function* (hostPath: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: 'tab-out-native-controller-',
  }).pipe(
    Effect.mapError((cause) => nativeHostTestError('create controller directory', cause)),
  )
  const socketPath = join(temporaryDirectory, 'bridge.sock')
  const host = yield* startNativeHost(hostPath, socketPath, 'capture')
  yield* waitForSocket(host, socketPath)
  const nativeMessages = host.nativeMessages
  if (!nativeMessages) {
    return yield* Effect.fail(nativeHostTestError(
      'capture native controller output',
      new Error('native output queue is unavailable'),
    ))
  }

  const controller = yield* connectController(socketPath)
  const currentTime = yield* Clock.currentTimeMillis
  yield* writeControllerMessage(controller, {
    version: CONTROL_BRIDGE_VERSION,
    type: 'controller-register',
    requestId: 'controller-round-trip',
    expiresAtMs: currentTime + 5_000,
    capabilities: ['merge-desktop'],
  })
  const registration = objectMessage(yield* takeMessage(
    controller.messages,
    'read controller registration response',
  ))
  yield* check(
    registration.version === CONTROL_BRIDGE_VERSION &&
    registration.requestId === 'controller-round-trip' &&
    registration.status === 'accepted',
    'validate controller registration',
    JSON.stringify(registration),
  )

  const status = objectMessage(yield* takeMessage(
    nativeMessages,
    'read native controller status',
  ))
  yield* check(
    status.version === CONTROL_BRIDGE_VERSION &&
    status.type === 'controller-status' &&
    status.connected === true,
    'validate native controller status',
    JSON.stringify(status),
  )

  const controlRequest = {
    version: CONTROL_BRIDGE_VERSION,
    type: 'resolve-desktop-windows',
    requestId: 'merge-round-trip',
    expiresAtMs: currentTime + 5_000,
    destinationWindowId: 71,
    profileWindowIds: [71, 72],
  }
  yield* Queue.offer(host.input, yield* encodeNativeMessage(controlRequest))
  const forwarded = objectMessage(yield* takeMessage(
    controller.messages,
    'read forwarded native control request',
  ))
  yield* check(
    forwarded.requestId === 'merge-round-trip' &&
    forwarded.type === 'resolve-desktop-windows' &&
    typeof forwarded.browserProcessId === 'number' &&
    forwarded.browserProcessId > 1 &&
    JSON.stringify(forwarded.profileWindowIds) === '[71,72]',
    'validate forwarded native control request',
    JSON.stringify(forwarded),
  )

  yield* writeControllerMessage(controller, {
    version: CONTROL_BRIDGE_VERSION,
    type: 'response',
    requestId: 'merge-round-trip',
    status: 'accepted',
    windowIds: [72, 71],
  })
  const response = objectMessage(yield* takeMessage(
    nativeMessages,
    'read native control response',
  ))
  yield* check(
    response.requestId === 'merge-round-trip' &&
    JSON.stringify(response.windowIds) === '[72,71]',
    'validate native control response',
    JSON.stringify(response),
  )

  yield* Queue.offer(host.input, yield* encodeNativeMessage({
    ...controlRequest,
    version: CONTROL_BRIDGE_VERSION - 1,
    requestId: 'stale-control-version-round-trip',
  }))
  const rejectedStaleControlVersion = objectMessage(yield* takeMessage(
    nativeMessages,
    'read rejected stale-version control request',
  ))
  yield* check(
    rejectedStaleControlVersion.version === CONTROL_BRIDGE_VERSION - 1 &&
    rejectedStaleControlVersion.status === 'rejected' &&
    rejectedStaleControlVersion.requestId === 'stale-control-version-round-trip' &&
    /protocol version/.test(String(rejectedStaleControlVersion.reason)),
    'reject stale control protocol versions without a timeout',
    JSON.stringify(rejectedStaleControlVersion),
  )

  yield* Queue.offer(host.input, yield* encodeNativeMessage({
    ...controlRequest,
    requestId: 'private-field-round-trip',
    url: 'https://example.test/private-field',
  }))
  const rejectedPrivateRequest = objectMessage(yield* takeMessage(
    nativeMessages,
    'read rejected private-field control request',
  ))
  yield* check(
    rejectedPrivateRequest.status === 'rejected' &&
    rejectedPrivateRequest.requestId === 'private-field-round-trip' &&
    /unsupported fields/.test(String(rejectedPrivateRequest.reason)),
    'reject private fields before Hammerspoon transport',
    JSON.stringify(rejectedPrivateRequest),
  )
  yield* check(
    !JSON.stringify(rejectedPrivateRequest).includes('example.test'),
    'keep rejected private fields out of native responses',
    JSON.stringify(rejectedPrivateRequest),
  )

  yield* Queue.offer(host.input, yield* encodeNativeMessage({
    ...controlRequest,
    requestId: 'boolean-window-id-round-trip',
    profileWindowIds: [71, true],
  }))
  const rejectedBooleanWindowId = objectMessage(yield* takeMessage(
    nativeMessages,
    'read rejected boolean window ID request',
  ))
  yield* check(
    rejectedBooleanWindowId.status === 'rejected' &&
    rejectedBooleanWindowId.requestId === 'boolean-window-id-round-trip' &&
    /window inventory/.test(String(rejectedBooleanWindowId.reason)),
    'reject JSON booleans where numeric window IDs are required',
    JSON.stringify(rejectedBooleanWindowId),
  )

  yield* Queue.offer(host.input, yield* encodeNativeMessage({
    ...controlRequest,
    requestId: 'oversized-window-inventory-round-trip',
    profileWindowIds: Array.from({ length: 513 }, (_, index) => index + 1),
  }))
  const rejectedOversizedWindowInventory = objectMessage(yield* takeMessage(
    nativeMessages,
    'read rejected oversized window inventory request',
  ))
  yield* check(
    rejectedOversizedWindowInventory.status === 'rejected' &&
    rejectedOversizedWindowInventory.requestId === 'oversized-window-inventory-round-trip' &&
    /window inventory/.test(String(rejectedOversizedWindowInventory.reason)),
    'reject oversized window inventories',
    JSON.stringify(rejectedOversizedWindowInventory),
  )

  yield* Queue.offer(host.input, yield* encodeNativeMessage({
    ...controlRequest,
    requestId: 'controller-private-field-round-trip',
  }))
  const forwardedPrivateResponseRequest = objectMessage(yield* takeMessage(
    controller.messages,
    'read control request before private controller response',
  ))
  yield* check(
    forwardedPrivateResponseRequest.requestId === 'controller-private-field-round-trip',
    'validate request before private controller response',
    JSON.stringify(forwardedPrivateResponseRequest),
  )
  yield* writeControllerMessage(controller, {
    version: CONTROL_BRIDGE_VERSION,
    type: 'response',
    requestId: 'controller-private-field-round-trip',
    status: 'accepted',
    windowIds: [72, 71],
    title: 'Example private field',
  })
  const disconnectedStatus = objectMessage(yield* takeMessage(
    nativeMessages,
    'read controller disconnect after private response',
  ))
  const rejectedPrivateResponse = objectMessage(yield* takeMessage(
    nativeMessages,
    'read rejected private controller response',
  ))
  yield* check(
    disconnectedStatus.type === 'controller-status' &&
    disconnectedStatus.connected === false,
    'disconnect a controller that returns private fields',
    JSON.stringify(disconnectedStatus),
  )
  yield* check(
    rejectedPrivateResponse.status === 'rejected' &&
    rejectedPrivateResponse.requestId === 'controller-private-field-round-trip' &&
    !JSON.stringify(rejectedPrivateResponse).includes('Example private field'),
    'reject private controller fields without forwarding them',
    JSON.stringify(rejectedPrivateResponse),
  )

  const result = yield* finishNativeHost(host)
  yield* check(
    result.exitCode === ChildProcessSpawner.ExitCode(0),
    'stop controller native host',
    `native host exited with code ${result.exitCode}`,
  )
  yield* check(result.stderr === '', 'inspect controller native host', result.stderr)
})

const runNativeHostTests = Effect.fn('nativeHostTest.run')(function* () {
  const hostArgument = process.argv[2]
  if (!hostArgument) {
    return yield* Effect.fail(nativeHostTestError(
      'resolve native host',
      new Error('native host path is required'),
    ))
  }
  const hostPath = resolve(hostArgument)

  yield* testRoundTrip(hostPath)
  yield* testCreateProcessAuthority(hostPath)
  yield* testDesktopControllerRoundTrip(hostPath)
  yield* testSocketHandoff(hostPath)
  yield* testDeadlineOverflow(hostPath)
  yield* Console.log('native bridge round trip: ok')
})

runNativeHostTests().pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
