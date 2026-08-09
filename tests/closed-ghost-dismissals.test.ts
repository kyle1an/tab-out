import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closedGhostDismissalKey,
  createClosedGhostDismissalMutationStore,
  dismissClosedGhost,
  isClosedGhostDismissed,
  loadClosedGhostDismissalsResult,
  normalizeClosedGhostDismissals,
  restoreClosedGhost,
} from '../src/extension/closed-ghost-dismissals.js'

function createExclusiveRunner() {
  let queue = Promise.resolve()
  return function runExclusive<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = queue.then(task)
    queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function installClosedGhostStorage(
  initial: Record<string, number> = {},
  options: { getFailures?: number } = {},
) {
  let stored = structuredClone(initial)
  let getAttempts = 0
  let getFailuresRemaining = options.getFailures ?? 0
  const root = globalThis as typeof globalThis & { chrome?: typeof chrome }
  const previousChrome = root.chrome
  root.chrome = {
    storage: {
      local: {
        async get() {
          getAttempts += 1
          if (getFailuresRemaining > 0) {
            getFailuresRemaining -= 1
            throw new Error('storage read failed')
          }
          return { tabOutDismissedClosedGhostsV1: structuredClone(stored) }
        },
        async set(value: Record<string, unknown>) {
          stored = structuredClone(value.tabOutDismissedClosedGhostsV1 as Record<string, number>)
        },
      },
    },
  } as unknown as typeof chrome

  return {
    getAttempts: () => getAttempts,
    read: () => structuredClone(stored),
    restore() {
      if (previousChrome) root.chrome = previousChrome
      else delete root.chrome
    },
  }
}

test('closedGhostDismissalKey is stable for the same effective page', () => {
  const a = closedGhostDismissalKey({ url: 'https://example.com/article' })
  const b = closedGhostDismissalKey({ url: 'https://example.com/article' })
  assert.equal(a, b)
  assert.ok(a.length > 0)
})

test('isClosedGhostDismissed hides entries dismissed at or after their close time', () => {
  const entry = { url: 'https://example.com/a', lastClosedAt: 1000 }
  const key = closedGhostDismissalKey(entry)
  assert.equal(isClosedGhostDismissed(new Map([[key, 1000]]), entry), true)
  assert.equal(isClosedGhostDismissed(new Map([[key, 1500]]), entry), true)
})

test('isClosedGhostDismissed shows entries re-closed after the dismissal', () => {
  const entry = { url: 'https://example.com/a', lastClosedAt: 2000 }
  const key = closedGhostDismissalKey(entry)
  assert.equal(isClosedGhostDismissed(new Map([[key, 1000]]), entry), false)
})

test('isClosedGhostDismissed tolerates empty or missing dismissals', () => {
  const entry = { url: 'https://example.com/a', lastClosedAt: 1000 }
  assert.equal(isClosedGhostDismissed(null, entry), false)
  assert.equal(isClosedGhostDismissed(undefined, entry), false)
  assert.equal(isClosedGhostDismissed(new Map(), entry), false)
})

test('normalizeClosedGhostDismissals drops invalid and expired records', () => {
  const now = 1_700_000_000_000
  const normalized = normalizeClosedGhostDismissals(
    {
      keep: now - 1000,
      expired: now - 8 * 24 * 60 * 60 * 1000,
      bad: 'nope',
    },
    now,
  )

  assert.equal(normalized.get('keep'), now - 1000)
  assert.equal(normalized.has('expired'), false)
  assert.equal(normalized.has('bad'), false)
  assert.deepEqual(normalizeClosedGhostDismissals([now], now), new Map())
})

test('loadClosedGhostDismissalsResult distinguishes a rejected read from confirmed dismissals', async () => {
  const now = 1_700_000_000_000
  const entry = { url: 'https://example.test/article' }
  const key = closedGhostDismissalKey(entry)
  const storage = installClosedGhostStorage({ [key]: now - 100 }, { getFailures: 1 })

  try {
    const failed = await loadClosedGhostDismissalsResult(now)
    assert.equal(failed.ok, false)
    assert.equal(failed.value.size, 0)

    const loaded = await loadClosedGhostDismissalsResult(now)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.value.get(key), now - 100)
    assert.equal(storage.getAttempts(), 2)
  } finally {
    storage.restore()
  }
})

test('stale Undo does not revive a newer dismissal for the same page', async () => {
  const storage = installClosedGhostStorage()
  const entry = { url: 'https://example.test/article', lastClosedAt: 500 }
  const key = closedGhostDismissalKey(entry)

  try {
    const firstDismissals = await dismissClosedGhost(entry, 1000)
    const expectedDismissedAt = firstDismissals.get(key)
    assert.equal(expectedDismissedAt, 1000)

    await dismissClosedGhost(entry, 2000)
    const afterStaleUndo = await restoreClosedGhost(entry, expectedDismissedAt as number, 2001)

    assert.equal(afterStaleUndo.get(key), 2000)
    assert.equal(storage.read()[key], 2000)
  } finally {
    storage.restore()
  }
})

test('independent mutation stores preserve concurrent dismissals for distinct pages', async () => {
  let stored: Record<string, number> = {}
  const adapter = {
    read: async () => structuredClone(stored),
    write: async (value: Record<string, number>) => {
      stored = structuredClone(value)
    },
    runExclusive: createExclusiveRunner(),
  }
  const firstContext = createClosedGhostDismissalMutationStore(adapter)
  const secondContext = createClosedGhostDismissalMutationStore(adapter)
  const first = { url: 'https://first.example.test/article', lastClosedAt: 100 }
  const second = { url: 'https://second.example.test/article', lastClosedAt: 200 }

  await Promise.all([
    firstContext.dismiss(first, 1000),
    secondContext.dismiss(second, 2000),
  ])

  assert.deepEqual(stored, {
    [closedGhostDismissalKey(first)]: 1000,
    [closedGhostDismissalKey(second)]: 2000,
  })
})

test('dismiss keeps the latest timestamp for the same page', async () => {
  let stored: Record<string, number> = {}
  const mutations = createClosedGhostDismissalMutationStore({
    read: async () => structuredClone(stored),
    write: async (value) => {
      stored = structuredClone(value)
    },
  })
  const entry = { url: 'https://example.test/article', lastClosedAt: 5000 }
  const key = closedGhostDismissalKey(entry)

  await mutations.dismiss(entry, 1000)
  const afterOlderClock = await mutations.dismiss({ ...entry, lastClosedAt: 100 }, 2000)

  assert.equal(stored[key], 5000)
  assert.equal(afterOlderClock.get(key), 5000)
})

test('a failed dismissal write rejects without returning false state and does not poison the queue', async () => {
  let stored: Record<string, number> = {}
  let shouldFail = true
  const mutations = createClosedGhostDismissalMutationStore({
    read: async () => structuredClone(stored),
    write: async (value) => {
      if (shouldFail) throw new Error('storage write failed')
      stored = structuredClone(value)
    },
  })
  const entry = { url: 'https://example.test/article', lastClosedAt: 100 }
  const key = closedGhostDismissalKey(entry)

  await assert.rejects(mutations.dismiss(entry, 1000), /storage write failed/)
  assert.deepEqual(stored, {})

  shouldFail = false
  const persisted = await mutations.dismiss(entry, 1000)
  assert.equal(stored[key], 1000)
  assert.equal(persisted.get(key), 1000)
})

test('a rejected dismissal lock preserves the failure and releases local serialization', async () => {
  let stored: Record<string, number> = {}
  let lockAttempts = 0
  const lockFailure = new Error('lock unavailable')
  const mutations = createClosedGhostDismissalMutationStore({
    read: async () => structuredClone(stored),
    write: async (value) => {
      stored = structuredClone(value)
    },
    runExclusive: async (task) => {
      lockAttempts += 1
      if (lockAttempts === 1) throw lockFailure
      return task()
    },
  })
  const entry = { url: 'https://example.test/article', lastClosedAt: 100 }

  await assert.rejects(mutations.dismiss(entry, 1000), (error) => error === lockFailure)
  const persisted = await mutations.dismiss(entry, 1000)

  assert.equal(persisted.get(closedGhostDismissalKey(entry)), 1000)
})
