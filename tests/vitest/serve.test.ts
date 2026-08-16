import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Result } from 'effect'

import {
  DebugServerError,
  runDashboardDebugServer,
} from '../../scripts/serve.js'

function serverPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP port')
  return address.port
}

function listenOnAvailablePort(server: Server): Promise<void> {
  server.listen(0, '127.0.0.1')
  return once(server, 'listening').then(() => undefined)
}

it.live('debug server serves the dashboard fixture and closes with its scope', () => Effect.gen(function* () {
  const shutdown = yield* Deferred.make<void>()
  const listening = Promise.withResolvers<number>()
  const serverFiber = yield* runDashboardDebugServer({
    port: 0,
    awaitShutdown: Deferred.await(shutdown),
    onListening: listening.resolve,
  }).pipe(Effect.forkChild({ startImmediately: true }))
  const port = yield* Effect.promise(() => listening.promise)
  const url = `http://127.0.0.1:${port}/tests/fixtures/dashboard-resize.html`

  const response = yield* Effect.promise(() => fetch(url))
  assert.equal(response.status, 200)
  assert.match(yield* Effect.promise(() => response.text()), /data-tabout="dashboard-shell"/)

  const staticResponse = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/extension/manifest.json`))
  assert.equal(staticResponse.status, 200)
  assert.equal(staticResponse.headers.get('content-type'), 'application/json')
  assert.equal((yield* Effect.promise(() => staticResponse.json())).manifest_version, 3)

  const missingResponse = yield* Effect.promise(() => fetch(`http://127.0.0.1:${port}/missing`))
  assert.equal(missingResponse.status, 404)
  assert.equal(yield* Effect.promise(() => missingResponse.text()), 'Not found')

  yield* Deferred.succeed(shutdown, undefined)
  yield* Fiber.join(serverFiber)
  yield* Effect.promise(() => assert.rejects(fetch(url, { signal: AbortSignal.timeout(1_000) })))
}))

it.live('debug server reports a typed port-binding failure', () => Effect.acquireUseRelease(
  Effect.promise(async () => {
    const server = createServer()
    await listenOnAvailablePort(server)
    return server
  }),
  (blockingServer) => Effect.gen(function* () {
    const port = serverPort(blockingServer)
    const result = yield* Effect.result(runDashboardDebugServer({
      port,
      awaitShutdown: Effect.never,
    }))

    assert.equal(Result.isFailure(result), true)
    if (Result.isSuccess(result)) throw new Error('occupied port unexpectedly started a second server')
    assert.ok(result.failure instanceof DebugServerError)
    assert.equal(result.failure.port, port)
  }),
  (blockingServer) => Effect.promise(() => blockingServer[Symbol.asyncDispose]()),
))
