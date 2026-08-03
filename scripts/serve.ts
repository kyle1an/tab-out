import { createReadStream, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { extname, resolve } from 'node:path'

import { Data, Deferred, Effect, Fiber } from 'effect'

// Dev-only static server for manually debugging the dashboard UI in a plain
// browser. Serves the repo root so tests/fixtures/dashboard-resize.html (which
// mocks chrome.* with fake tabs) can load the built extension/dist/app.js.
// The extension itself ships no server — this is purely a local debugging aid.
// See docs/debugging-the-dashboard.md.

const ROOT = resolve('.')
const DEFAULT_PORT = 8765
const HOST = '127.0.0.1'
const DASHBOARD_FIXTURE = resolve(ROOT, 'tests/fixtures/dashboard-resize.html')
const GENERATED_INDEX = resolve(ROOT, 'extension/index.html')
const APP_ROOT_START = '<!-- TAB_OUT_APP_ROOT_START -->'
const APP_ROOT_END = '<!-- TAB_OUT_APP_ROOT_END -->'
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml'
}

export class DebugServerError extends Data.TaggedError('DebugServerError')<{
  readonly port: number
  readonly cause: unknown
}> {}

export type DashboardDebugServerOptions = {
  readonly port: number
  readonly awaitShutdown: Effect.Effect<void>
  readonly onListening?: ((port: number) => void) | undefined
}

type DebugServerResource = {
  readonly server: Server
  readonly failure: Deferred.Deferred<never, DebugServerError>
  readonly onError: (cause: Error) => void
}

function markedAppRoot(source: string): string {
  const start = source.indexOf(APP_ROOT_START)
  const end = source.indexOf(APP_ROOT_END, start)
  if (start < 0 || end < 0) throw new Error('Dashboard page is missing generated app-root markers')
  return source.slice(start, end + APP_ROOT_END.length)
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const target = resolve(ROOT, `.${decodeURIComponent(url.pathname)}`)
  if (!target.startsWith(ROOT) || !existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end('Not found')
    return
  }
  if (target === DASHBOARD_FIXTURE) {
    try {
      const [fixture, generatedIndex] = await Promise.all([
        readFile(DASHBOARD_FIXTURE, 'utf8'),
        readFile(GENERATED_INDEX, 'utf8')
      ])
      const fixtureStart = fixture.indexOf(APP_ROOT_START)
      const fixtureEnd = fixture.indexOf(APP_ROOT_END, fixtureStart)
      if (fixtureStart < 0 || fixtureEnd < 0) throw new Error('Dashboard fixture is missing app-root markers')
      const body = fixture.slice(0, fixtureStart) + markedAppRoot(generatedIndex) +
        fixture.slice(fixtureEnd + APP_ROOT_END.length)
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(body)
    } catch (error) {
      res.writeHead(500).end(error instanceof Error ? error.message : String(error))
    }
    return
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(target)] || 'application/octet-stream' })
  createReadStream(target).pipe(res)
}

function acquireDebugServer(port: number): Effect.Effect<DebugServerResource> {
  return Effect.sync(() => {
    const failure = Deferred.makeUnsafe<never, DebugServerError>()
    const server = createServer(handleRequest)
    const onError = (cause: Error) => {
      Deferred.doneUnsafe(failure, Effect.fail(new DebugServerError({ port, cause })))
    }
    server.on('error', onError)
    return { server, failure, onError }
  })
}

function releaseDebugServer(resource: DebugServerResource): Effect.Effect<void> {
  const { server, onError } = resource
  if (!server.listening) {
    return Effect.sync(() => {
      server.removeListener('error', onError)
    })
  }

  return Effect.callback((resume) => {
    server.close(() => {
      server.removeListener('error', onError)
      resume(Effect.void)
    })
    server.closeAllConnections()
  })
}

function listen(resource: DebugServerResource, port: number): Effect.Effect<void, DebugServerError> {
  const listening = Effect.callback<void>((resume) => {
    function onListening(): void {
      resume(Effect.void)
    }

    resource.server.once('listening', onListening)
    resource.server.listen(port, HOST)
    return Effect.sync(() => {
      resource.server.removeListener('listening', onListening)
    })
  })

  return listening.pipe(Effect.raceFirst(Deferred.await(resource.failure)))
}

function boundPort(server: Server, requestedPort: number): number {
  const address = server.address()
  return address && typeof address !== 'string' ? address.port : requestedPort
}

const runDashboardDebugServerScoped = Effect.fn('debugServer.run')(function*(
  options: DashboardDebugServerOptions
) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    return yield* Effect.fail(new DebugServerError({
      port: options.port,
      cause: new RangeError(`Invalid debug server port: ${options.port}`)
    }))
  }

  const resource = yield* Effect.acquireRelease(
    acquireDebugServer(options.port),
    releaseDebugServer
  )
  const shutdownFiber = yield* options.awaitShutdown.pipe(
    Effect.forkScoped({ startImmediately: true })
  )
  yield* listen(resource, options.port)
  yield* Effect.sync(() => options.onListening?.(boundPort(resource.server, options.port)))
  return yield* Fiber.join(shutdownFiber).pipe(
    Effect.raceFirst(Deferred.await(resource.failure))
  )
})

export function runDashboardDebugServer(
  options: DashboardDebugServerOptions
): Effect.Effect<void, DebugServerError> {
  return Effect.scoped(runDashboardDebugServerScoped(options))
}

const awaitShutdown = Effect.callback<void>((resume) => {
  function cleanup(): void {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
  }

  function shutdown(): void {
    cleanup()
    resume(Effect.void)
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return Effect.sync(cleanup)
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function debugServerMain(): Promise<number> {
  const port = Number(process.env.PORT) || DEFAULT_PORT
  return Effect.runPromise(runDashboardDebugServer({
    port,
    awaitShutdown,
    onListening: (boundServerPort) => {
      process.stdout.write(`Tab Out debug server  http://${HOST}:${boundServerPort}\n`)
      process.stdout.write(
        `Dashboard fixture      http://${HOST}:${boundServerPort}/tests/fixtures/dashboard-resize.html\n`
      )
    }
  }).pipe(
    Effect.as(0),
    Effect.catchTag('DebugServerError', (error) => Effect.sync(() => {
      console.error(`Tab Out debug server failed on port ${error.port}: ${errorMessage(error.cause)}`)
      return 1
    }))
  ))
}

if (import.meta.main) {
  debugServerMain().then(
    (exitCode) => {
      process.exitCode = exitCode
    },
    (cause: unknown) => {
      console.error(`Tab Out debug server failed unexpectedly: ${errorMessage(cause)}`)
      process.exitCode = 1
    }
  )
}
