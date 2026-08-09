import { performance } from 'node:perf_hooks'

import type { BrowserContext, CDPSession, Page } from '@playwright/test'

const TARGET_TIMEOUT_MS = 15_000
const TARGET_POLL_MS = 25
const ABSENCE_CONFIRMATIONS = 5

function describeError(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function matchingServiceWorkerTargets(
  session: CDPSession,
  workerUrl: string
) {
  const observed = await session.send('Target.getTargets')
  return observed.targetInfos.filter((candidate) =>
    candidate.type === 'service_worker' && candidate.url === workerUrl)
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
