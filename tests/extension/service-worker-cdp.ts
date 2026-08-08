import { performance } from 'node:perf_hooks'

import type { BrowserContext, CDPSession, Page } from '@playwright/test'
import { Schema } from 'effect'

const TARGET_TIMEOUT_MS = 15_000
const TARGET_POLL_MS = 25
const ABSENCE_CONFIRMATIONS = 5
const CHILD_COMMAND_TIMEOUT_MS = 15_000

const nonNegativeFiniteSchema = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0)
)

const nestedCommandResponseSchema = Schema.Struct({
  id: Schema.Int,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({
    code: Schema.Int,
    message: Schema.String
  }))
})

const heapUsageSchema = Schema.Struct({
  usedSize: nonNegativeFiniteSchema,
  totalSize: nonNegativeFiniteSchema,
  embedderHeapUsedSize: nonNegativeFiniteSchema,
  backingStorageSize: nonNegativeFiniteSchema
})

const samplingProfileSchema = Schema.Struct({
  profile: Schema.Struct({
    samples: Schema.Array(Schema.Struct({
      size: nonNegativeFiniteSchema,
      nodeId: Schema.Int,
      ordinal: Schema.Int
    }))
  })
})

const isNestedCommandResponse = Schema.is(nestedCommandResponseSchema)
const isHeapUsage = Schema.is(heapUsageSchema)
const isSamplingProfile = Schema.is(samplingProfileSchema)

export interface ServiceWorkerHeapUsage {
  readonly usedSize: number
  readonly totalSize: number
  readonly embedderHeapUsedSize: number
  readonly backingStorageSize: number
}

export interface ServiceWorkerHeapSamplingSummary {
  readonly sampleCount: number
  readonly sampledBytes: number
}

export interface ServiceWorkerHeapSamplingOptions {
  readonly samplingInterval: number
  readonly stackDepth: number
  readonly includeObjectsCollectedByMajorGC: boolean
  readonly includeObjectsCollectedByMinorGC: boolean
}

export interface AttachedServiceWorkerCdp extends AsyncDisposable {
  readonly collectGarbage: () => Promise<void>
  readonly getHeapUsage: () => Promise<ServiceWorkerHeapUsage>
  readonly startSampling: (
    options: ServiceWorkerHeapSamplingOptions
  ) => Promise<void>
  readonly stopSampling: () => Promise<ServiceWorkerHeapSamplingSummary>
  readonly detach: () => Promise<void>
}

interface PendingNestedResponse {
  readonly promise: Promise<unknown>
  readonly cancel: () => void
}

function describeError(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function waitForNestedResponse(
  root: CDPSession,
  sessionId: string,
  commandId: number
): PendingNestedResponse {
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectPending: ((reason: Error) => void) | undefined

  const cleanup = (): void => {
    if (settled) return
    settled = true
    if (timeout !== undefined) clearTimeout(timeout)
    root.off('Target.receivedMessageFromTarget', onMessage)
  }

  const onMessage = (event: { sessionId: string; message: string }): void => {
    if (event.sessionId !== sessionId || settled) return
    let decoded: unknown
    try {
      decoded = JSON.parse(event.message)
    } catch {
      return
    }
    if (!isNestedCommandResponse(decoded) || decoded.id !== commandId) return
    cleanup()
    if (decoded.error !== undefined) {
      rejectPending?.(new Error(
        `Service-worker CDP command failed (${String(decoded.error.code)}): ` +
        decoded.error.message
      ))
      return
    }
    resolvePending(decoded.result)
  }

  let resolvePending: (value: unknown) => void = () => undefined
  const promise = new Promise<unknown>((resolve, reject) => {
    resolvePending = resolve
    rejectPending = reject
    timeout = setTimeout(() => {
      cleanup()
      reject(new Error(
        `Service-worker CDP command ${String(commandId)} timed out after ` +
        `${String(CHILD_COMMAND_TIMEOUT_MS)}ms`
      ))
    }, CHILD_COMMAND_TIMEOUT_MS)
  })
  root.on('Target.receivedMessageFromTarget', onMessage)

  return {
    promise,
    cancel: () => {
      cleanup()
      rejectPending?.(new Error(
        `Service-worker CDP command ${String(commandId)} was cancelled`
      ))
    }
  }
}

class NestedServiceWorkerCdp implements AttachedServiceWorkerCdp {
  readonly #root: CDPSession
  readonly #sessionId: string
  #nextCommandId = 1
  #detached = false

  constructor(root: CDPSession, sessionId: string) {
    this.#root = root
    this.#sessionId = sessionId
  }

  async enableHeapProfiler(): Promise<void> {
    await this.#send('HeapProfiler.enable')
  }

  async collectGarbage(): Promise<void> {
    await this.#send('HeapProfiler.collectGarbage')
  }

  async getHeapUsage(): Promise<ServiceWorkerHeapUsage> {
    const response = await this.#send('Runtime.getHeapUsage')
    if (!isHeapUsage(response)) {
      throw new Error('Runtime.getHeapUsage returned an invalid response')
    }
    return response
  }

  async startSampling(
    options: ServiceWorkerHeapSamplingOptions
  ): Promise<void> {
    await this.#send('HeapProfiler.startSampling', options)
  }

  async stopSampling(): Promise<ServiceWorkerHeapSamplingSummary> {
    const response = await this.#send('HeapProfiler.stopSampling')
    if (!isSamplingProfile(response)) {
      throw new Error('HeapProfiler.stopSampling returned an invalid response')
    }
    return {
      sampleCount: response.profile.samples.length,
      sampledBytes: response.profile.samples.reduce(
        (total, sample) => total + sample.size,
        0
      )
    }
  }

  async detach(): Promise<void> {
    if (this.#detached) return
    this.#detached = true
    try {
      await this.#root.send('Target.detachFromTarget', {
        sessionId: this.#sessionId
      })
    } catch {
      // The worker can disappear before an explicit detach.
    }
    await this.#root.detach().catch(() => undefined)
  }

  async #send(method: string, params?: unknown): Promise<unknown> {
    if (this.#detached) {
      throw new Error('Service-worker CDP session is already detached')
    }
    const id = this.#nextCommandId
    this.#nextCommandId += 1
    const pending = waitForNestedResponse(this.#root, this.#sessionId, id)
    const message = JSON.stringify({
      id,
      method,
      ...(params === undefined ? {} : { params })
    })
    try {
      await this.#root.send('Target.sendMessageToTarget', {
        sessionId: this.#sessionId,
        message
      })
    } catch (cause) {
      pending.cancel()
      await pending.promise.catch(() => undefined)
      throw cause
    }
    return pending.promise
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.detach()
  }
}

async function matchingServiceWorkerTargets(
  session: CDPSession,
  workerUrl: string
) {
  const observed = await session.send('Target.getTargets')
  return observed.targetInfos.filter((candidate) =>
    candidate.type === 'service_worker' && candidate.url === workerUrl)
}

export async function attachToServiceWorkerCdp(
  context: BrowserContext,
  controller: Page,
  workerUrl: string
): Promise<AttachedServiceWorkerCdp> {
  const root = await context.newCDPSession(controller)
  try {
    const deadline = performance.now() + TARGET_TIMEOUT_MS
    while (performance.now() < deadline) {
      const target = (await matchingServiceWorkerTargets(root, workerUrl))[0]
      if (target !== undefined) {
        // Omitting flatten is intentional. Playwright cannot put a child
        // sessionId on a flat command, so child traffic is bridged through
        // Target.sendMessageToTarget and Target.receivedMessageFromTarget.
        const attached = await root.send('Target.attachToTarget', {
          targetId: target.targetId
        })
        const nested = new NestedServiceWorkerCdp(root, attached.sessionId)
        await nested.enableHeapProfiler()
        return nested
      }
      await delay(TARGET_POLL_MS)
    }
    throw new Error(
      `No service-worker target appeared for ${workerUrl} within ` +
      `${String(TARGET_TIMEOUT_MS)}ms`
    )
  } catch (cause) {
    await root.detach().catch(() => undefined)
    throw cause
  }
}

export async function terminateServiceWorkerAndProveAbsent(
  context: BrowserContext,
  controller: Page,
  workerUrl: string
): Promise<void> {
  const session = await context.newCDPSession(controller)
  try {
    const deadline = performance.now() + TARGET_TIMEOUT_MS
    let consecutiveAbsentObservations = 0
    let closeAttempts = 0
    let rejectedCloseAttempts = 0
    let lastCloseError: string | null = null
    while (performance.now() < deadline) {
      const matchingTargets = await matchingServiceWorkerTargets(
        session,
        workerUrl
      )
      if (matchingTargets.length === 0) {
        consecutiveAbsentObservations += 1
        if (consecutiveAbsentObservations >= ABSENCE_CONFIRMATIONS) return
      } else {
        consecutiveAbsentObservations = 0
        for (const target of matchingTargets) {
          closeAttempts += 1
          try {
            const closed = await session.send('Target.closeTarget', {
              targetId: target.targetId
            })
            if (!closed.success) rejectedCloseAttempts += 1
          } catch (cause) {
            lastCloseError = describeError(cause)
          }
        }
      }
      await delay(TARGET_POLL_MS)
    }
    throw new Error(
      'Installed service-worker target never reached stable absence ' +
      `within ${String(TARGET_TIMEOUT_MS)}ms ` +
      `(closeAttempts=${String(closeAttempts)}, ` +
      `rejectedCloseAttempts=${String(rejectedCloseAttempts)}, ` +
      `lastCloseError=${lastCloseError ?? 'none'})`
    )
  } finally {
    await session.detach().catch(() => undefined)
  }
}
