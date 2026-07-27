/* ================================================================
   Closed-ghost dismissals

   Chrome's `sessions` API exposes getRecentlyClosed/restore but no way
   to delete a single recently-closed entry, so "forgetting" a
   closed-ghost row can only be a local suppression. We persist a map of
   page identity -> dismissal timestamp in chrome.storage.local (the same
   storage Tab Out uses for page-chip pins) and hide a closed-ghost row
   while its identity was forgotten at or after that row was closed. If
   the same page is closed again later (a newer lastClosedAt), it
   reappears, so forgetting is per-closure rather than permanent.
   ================================================================ */

import { pageIdentityForWorkingSet } from './working-set.js'
import type { ClosedTabEntry } from './closed-tabs.js'
import type { BrowserReadResult } from './browser-tabs-gateway.js'

const CLOSED_GHOST_DISMISSAL_STORAGE_KEY = 'tabOutDismissedClosedGhostsV1'
const CLOSED_GHOST_DISMISSAL_MUTATION_LOCK = 'tab-out:closed-ghost-dismissal-mutation'

// Chrome's recently-closed list itself ages out, so long-lived dismissal
// records serve no purpose; prune anything older than this on load/save.
const CLOSED_GHOST_DISMISSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type ClosedGhostDismissals = ReadonlyMap<string, number>

type ClosedGhostIdentity = Pick<ClosedTabEntry, 'url'>
type ClosedGhostDismissalTarget = Pick<ClosedTabEntry, 'url' | 'lastClosedAt'>

export type ClosedGhostDismissalStoreAdapter = {
  read: () => Promise<unknown>
  write: (value: Record<string, number>) => Promise<void>
  runExclusive?: <Value>(task: () => Promise<Value>) => Promise<Value>
}

export type ClosedGhostDismissalMutationStore = {
  dismiss: (entry: ClosedGhostDismissalTarget, now?: number) => Promise<Map<string, number>>
  restore: (
    entry: ClosedGhostIdentity,
    expectedDismissedAt: number,
    now?: number
  ) => Promise<Map<string, number>>
}

export function closedGhostDismissalKey(entry: ClosedGhostIdentity): string {
  return pageIdentityForWorkingSet(entry.url) || entry.url
}

export function isClosedGhostDismissed(
  dismissals: ClosedGhostDismissals | null | undefined,
  entry: ClosedGhostDismissalTarget
): boolean {
  if (!dismissals || dismissals.size === 0) return false
  const dismissedAt = dismissals.get(closedGhostDismissalKey(entry))
  return typeof dismissedAt === 'number' && dismissedAt >= entry.lastClosedAt
}

function pruneExpired(map: Map<string, number>, now: number): Map<string, number> {
  for (const [key, at] of map) {
    if (!Number.isFinite(at) || now - at > CLOSED_GHOST_DISMISSAL_TTL_MS) map.delete(key)
  }
  return map
}

export function normalizeClosedGhostDismissals(value: unknown, now: number = Date.now()): Map<string, number> {
  const map = new Map<string, number>()
  if (value && typeof value === 'object') {
    for (const [key, at] of Object.entries(value as Record<string, unknown>)) {
      if (key && typeof at === 'number' && Number.isFinite(at)) map.set(key, at)
    }
  }
  return pruneExpired(map, now)
}

export async function loadClosedGhostDismissalsResult(
  now: number = Date.now()
): Promise<BrowserReadResult<Map<string, number>>> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ok: false, value: new Map() }
  }
  try {
    const stored = await chrome.storage.local.get(CLOSED_GHOST_DISMISSAL_STORAGE_KEY)
    return {
      ok: true,
      value: normalizeClosedGhostDismissals(stored[CLOSED_GHOST_DISMISSAL_STORAGE_KEY], now)
    }
  } catch {
    return { ok: false, value: new Map() }
  }
}

export function subscribeClosedGhostDismissals(
  handler: (dismissals: Map<string, number>) => void
): () => void {
  const event = globalThis.chrome?.storage?.onChanged
  if (!event?.addListener) return () => {}
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== 'local' || !Object.hasOwn(changes, CLOSED_GHOST_DISMISSAL_STORAGE_KEY)) return
    handler(normalizeClosedGhostDismissals(changes[CLOSED_GHOST_DISMISSAL_STORAGE_KEY]?.newValue))
  }
  event.addListener(listener)
  return () => event.removeListener?.(listener)
}

/**
 * Serializes one context's mutations while the production adapter's Web Lock
 * makes each read-modify-write pair atomic across all open Tab Out pages.
 * Mutation results are returned only after storage accepts the write, so a
 * caller cannot apply or toast state that was never persisted.
 */
export function createClosedGhostDismissalMutationStore(
  adapter: ClosedGhostDismissalStoreAdapter
): ClosedGhostDismissalMutationStore {
  let mutationQueue = Promise.resolve()

  function enqueue<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = mutationQueue.then(() => (
      adapter.runExclusive ? adapter.runExclusive(task) : task()
    ))
    mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function dismiss(
    entry: ClosedGhostDismissalTarget,
    now: number = Date.now()
  ): Promise<Map<string, number>> {
    return enqueue(async () => {
      const map = normalizeClosedGhostDismissals(await adapter.read(), now)
      const key = closedGhostDismissalKey(entry)
      const previousDismissedAt = map.get(key)
      const dismissedAt = Math.max(
        previousDismissedAt ?? Number.NEGATIVE_INFINITY,
        Number.isFinite(entry.lastClosedAt) ? entry.lastClosedAt : Number.NEGATIVE_INFINITY,
        Number.isFinite(now) ? now : Date.now()
      )

      if (previousDismissedAt !== dismissedAt) {
        map.set(key, dismissedAt)
        await adapter.write(Object.fromEntries(map))
      }
      return map
    })
  }

  function restore(
    entry: ClosedGhostIdentity,
    expectedDismissedAt: number,
    now: number = Date.now()
  ): Promise<Map<string, number>> {
    return enqueue(async () => {
      const map = normalizeClosedGhostDismissals(await adapter.read(), now)
      const key = closedGhostDismissalKey(entry)
      // Undo belongs to one exact dismissal. If another page/context forgot
      // the same URL later, that newer user intent must remain in storage.
      if (map.get(key) === expectedDismissedAt) {
        map.delete(key)
        await adapter.write(Object.fromEntries(map))
      }
      return map
    })
  }

  return { dismiss, restore }
}

function closedGhostDismissalStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Closed-page dismissal storage is unavailable')
  }
  return chrome.storage.local
}

async function readClosedGhostDismissalsValue(): Promise<unknown> {
  const stored = await closedGhostDismissalStorageArea().get(CLOSED_GHOST_DISMISSAL_STORAGE_KEY)
  return stored[CLOSED_GHOST_DISMISSAL_STORAGE_KEY]
}

async function writeClosedGhostDismissalsValue(value: Record<string, number>): Promise<void> {
  await closedGhostDismissalStorageArea().set({
    [CLOSED_GHOST_DISMISSAL_STORAGE_KEY]: value
  })
}

const closedGhostDismissalMutationStore = createClosedGhostDismissalMutationStore({
  read: readClosedGhostDismissalsValue,
  write: writeClosedGhostDismissalsValue,
  runExclusive: (task) => navigator.locks.request(CLOSED_GHOST_DISMISSAL_MUTATION_LOCK, task)
})

export async function dismissClosedGhost(
  entry: ClosedGhostDismissalTarget,
  now: number = Date.now()
): Promise<Map<string, number>> {
  return closedGhostDismissalMutationStore.dismiss(entry, now)
}

export async function restoreClosedGhost(
  entry: ClosedGhostIdentity,
  expectedDismissedAt: number,
  now: number = Date.now()
): Promise<Map<string, number>> {
  return closedGhostDismissalMutationStore.restore(entry, expectedDismissedAt, now)
}
