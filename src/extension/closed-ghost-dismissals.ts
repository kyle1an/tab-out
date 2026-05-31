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

export const CLOSED_GHOST_DISMISSAL_STORAGE_KEY = 'tabOutDismissedClosedGhostsV1'

// Chrome's recently-closed list itself ages out, so long-lived dismissal
// records serve no purpose; prune anything older than this on load/save.
const CLOSED_GHOST_DISMISSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type ClosedGhostDismissals = ReadonlyMap<string, number>

type ClosedGhostIdentity = Pick<ClosedTabEntry, 'url'>
type ClosedGhostDismissalTarget = Pick<ClosedTabEntry, 'url' | 'lastClosedAt'>

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

export async function loadClosedGhostDismissals(now: number = Date.now()): Promise<Map<string, number>> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return new Map()
  try {
    const stored = await chrome.storage.local.get(CLOSED_GHOST_DISMISSAL_STORAGE_KEY)
    return normalizeClosedGhostDismissals(stored[CLOSED_GHOST_DISMISSAL_STORAGE_KEY], now)
  } catch {
    return new Map()
  }
}

async function saveClosedGhostDismissals(map: Map<string, number>): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.set({
    [CLOSED_GHOST_DISMISSAL_STORAGE_KEY]: Object.fromEntries(map)
  })
}

export async function dismissClosedGhost(
  entry: ClosedGhostDismissalTarget,
  now: number = Date.now()
): Promise<Map<string, number>> {
  const map = pruneExpired(await loadClosedGhostDismissals(now), now)
  map.set(closedGhostDismissalKey(entry), Math.max(now, entry.lastClosedAt))
  await saveClosedGhostDismissals(map)
  return map
}

export async function restoreClosedGhost(
  entry: ClosedGhostIdentity,
  now: number = Date.now()
): Promise<Map<string, number>> {
  const map = pruneExpired(await loadClosedGhostDismissals(now), now)
  map.delete(closedGhostDismissalKey(entry))
  await saveClosedGhostDismissals(map)
  return map
}
