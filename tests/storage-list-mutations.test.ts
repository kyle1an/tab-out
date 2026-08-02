import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyPinnedDomainMutation,
  normalizePinnedDomains,
  type PinnedDomainMutation
} from '../src/extension/domain-pins.js'
import {
  applyPinnedPageChipMutation,
  normalizePinnedPageChips,
  pageChipPinId,
  pageChipPinKeyForUrl,
  pageChipPinScopeId,
  type PinnedPageChipMutation
} from '../src/extension/page-chip-pins.js'
import {
  applyPinnedSectionMutation,
  normalizePinnedSections,
  subdomainPinId,
  type PinnedSectionMutation
} from '../src/extension/section-pins.js'
import {
  createStorageListMutationStore,
  type StorageListMutationAdapter
} from '../src/extension/storage-list-mutations.js'

function createSharedExclusiveRunner() {
  let queue = Promise.resolve()
  let active = 0
  let maxActive = 0
  return {
    get maxActive() {
      return maxActive
    },
    run<Value>(task: () => Promise<Value>): Promise<Value> {
      const result = queue.then(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          return await task()
        } finally {
          active -= 1
        }
      })
      queue = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
  }
}

async function assertIndependentContextsPreservePins<Operation>({
  applyOperation,
  firstOperation,
  normalize,
  secondOperation,
  expected
}: {
  applyOperation: (value: unknown, operation: Operation) => string[]
  firstOperation: Operation
  normalize: (value: unknown) => string[]
  secondOperation: Operation
  expected: string[]
}): Promise<void> {
  let stored: string[] = []
  let reads = 0
  let writes = 0
  const firstWriteStarted = Promise.withResolvers<void>()
  const releaseFirstWrite = Promise.withResolvers<void>()
  const exclusive = createSharedExclusiveRunner()

  function createAdapter(): StorageListMutationAdapter {
    return {
      read: async () => {
        reads += 1
        return [...stored]
      },
      write: async (value) => {
        writes += 1
        if (writes === 1) {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        }
        stored = [...value]
      },
      runExclusive: (task) => exclusive.run(task)
    }
  }

  // Separate stores model separate Tab Out extension pages. Only the injected
  // exclusive runner and backing value are shared, like Web Locks + storage.
  const firstContext = createStorageListMutationStore({
    adapter: createAdapter(),
    applyOperation,
    normalize
  })
  const secondContext = createStorageListMutationStore({
    adapter: createAdapter(),
    applyOperation,
    normalize
  })

  const first = firstContext.mutate(firstOperation)
  await firstWriteStarted.promise
  const second = secondContext.mutate(secondOperation)
  await Promise.resolve()

  assert.equal(reads, 1, 'the second context must wait before reading')
  releaseFirstWrite.resolve()
  const results = await Promise.all([first, second])

  assert.equal(results.every((result) => result.ok), true)
  assert.deepEqual(stored, expected)
  assert.equal(exclusive.maxActive, 1)
}

test('two contexts preserve different Domain Card pin intents', async () => {
  await assertIndependentContextsPreservePins<PinnedDomainMutation>({
    applyOperation: applyPinnedDomainMutation,
    firstOperation: { type: 'set-pinned', domain: 'alpha.test', pinned: true },
    normalize: normalizePinnedDomains,
    secondOperation: { type: 'set-pinned', domain: 'bravo.test', pinned: true },
    expected: ['alpha.test', 'bravo.test']
  })
})

test('one context serializes overlapping mutations without a Web Lock', async () => {
  let stored: string[] = []
  let reads = 0
  let writes = 0
  const firstWriteStarted = Promise.withResolvers<void>()
  const releaseFirstWrite = Promise.withResolvers<void>()
  const store = createStorageListMutationStore<PinnedDomainMutation>({
    adapter: {
      read: async () => {
        reads += 1
        return [...stored]
      },
      write: async (value) => {
        writes += 1
        if (writes === 1) {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        }
        stored = [...value]
      }
    },
    applyOperation: applyPinnedDomainMutation,
    normalize: normalizePinnedDomains
  })

  const first = store.mutate({ type: 'set-pinned', domain: 'alpha.test', pinned: true })
  await firstWriteStarted.promise
  const second = store.mutate({ type: 'set-pinned', domain: 'bravo.test', pinned: true })
  await Promise.resolve()
  assert.equal(reads, 1)

  releaseFirstWrite.resolve()
  await Promise.all([first, second])

  assert.deepEqual(stored, ['alpha.test', 'bravo.test'])
  assert.equal(reads, 2)
})

test('two stale contexts setting the same pin do not toggle it back off', async () => {
  await assertIndependentContextsPreservePins<PinnedDomainMutation>({
    applyOperation: applyPinnedDomainMutation,
    firstOperation: { type: 'set-pinned', domain: 'alpha.test', pinned: true },
    normalize: normalizePinnedDomains,
    secondOperation: { type: 'set-pinned', domain: 'alpha.test', pinned: true },
    expected: ['alpha.test']
  })
})

test('two contexts preserve different section pin intents', async () => {
  const firstId = subdomainPinId('alpha.test', 'docs')
  const secondId = subdomainPinId('bravo.test', 'mail')
  await assertIndependentContextsPreservePins<PinnedSectionMutation>({
    applyOperation: applyPinnedSectionMutation,
    firstOperation: { type: 'set-pinned', id: firstId, pinned: true },
    normalize: normalizePinnedSections,
    secondOperation: { type: 'set-pinned', id: secondId, pinned: true },
    expected: [firstId, secondId]
  })
})

test('two contexts preserve different Page Chip pin intents', async () => {
  const scope = pageChipPinScopeId('example.test', '', '', '')
  const firstId = pageChipPinId('tabs', scope, pageChipPinKeyForUrl('https://example.test/alpha'))
  const secondId = pageChipPinId('tabs', scope, pageChipPinKeyForUrl('https://example.test/bravo'))
  await assertIndependentContextsPreservePins<PinnedPageChipMutation>({
    applyOperation: applyPinnedPageChipMutation,
    firstOperation: { type: 'set-pinned', id: firstId, pinned: true },
    normalize: normalizePinnedPageChips,
    secondOperation: { type: 'set-pinned', id: secondId, pinned: true },
    expected: [firstId, secondId]
  })
})

test('a Domain Card reorder replays against the latest cross-context order', async () => {
  let stored = ['alpha.test', 'bravo.test', 'charlie.test']
  const firstWriteStarted = Promise.withResolvers<void>()
  const releaseFirstWrite = Promise.withResolvers<void>()
  const exclusive = createSharedExclusiveRunner()
  let writes = 0
  function createAdapter(): StorageListMutationAdapter {
    return {
      read: async () => [...stored],
      write: async (value) => {
        writes += 1
        if (writes === 1) {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        }
        stored = [...value]
      },
      runExclusive: (task) => exclusive.run(task)
    }
  }
  const firstContext = createStorageListMutationStore<PinnedDomainMutation>({
    adapter: createAdapter(),
    applyOperation: applyPinnedDomainMutation,
    normalize: normalizePinnedDomains
  })
  const secondContext = createStorageListMutationStore<PinnedDomainMutation>({
    adapter: createAdapter(),
    applyOperation: applyPinnedDomainMutation,
    normalize: normalizePinnedDomains
  })

  const pin = firstContext.mutate({ type: 'set-pinned', domain: 'delta.test', pinned: true })
  await firstWriteStarted.promise
  const reorder = secondContext.mutate({
    type: 'reorder',
    domain: 'charlie.test',
    placement: { targetDomain: 'alpha.test', position: 'before' }
  })
  releaseFirstWrite.resolve()
  await Promise.all([pin, reorder])

  assert.deepEqual(stored, ['charlie.test', 'alpha.test', 'bravo.test', 'delta.test'])
})

test('a storage read failure aborts before write and does not poison the local queue', async () => {
  let stored: string[] = []
  let reads = 0
  let writes = 0
  const store = createStorageListMutationStore<PinnedDomainMutation>({
    adapter: {
      read: async () => {
        reads += 1
        if (reads === 1) throw new Error('storage read failed')
        return [...stored]
      },
      write: async (value) => {
        writes += 1
        stored = [...value]
      }
    },
    applyOperation: applyPinnedDomainMutation,
    normalize: normalizePinnedDomains
  })

  const failed = await store.mutate({ type: 'set-pinned', domain: 'alpha.test', pinned: true })
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.equal(failed.currentValue, null)
  assert.equal(writes, 0)

  const recovered = await store.mutate({ type: 'set-pinned', domain: 'bravo.test', pinned: true })
  assert.equal(recovered.ok, true)
  assert.deepEqual(stored, ['bravo.test'])
  assert.equal(writes, 1)
})

test('a storage write failure exposes the freshly read rollback value and later writes recover', async () => {
  let stored = ['alpha.test']
  let writes = 0
  const store = createStorageListMutationStore<PinnedDomainMutation>({
    adapter: {
      read: async () => [...stored],
      write: async (value) => {
        writes += 1
        if (writes === 1) throw new Error('storage write failed')
        stored = [...value]
      }
    },
    applyOperation: applyPinnedDomainMutation,
    normalize: normalizePinnedDomains
  })

  const failed = await store.mutate({ type: 'set-pinned', domain: 'bravo.test', pinned: true })
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.deepEqual(failed.currentValue, ['alpha.test'])
  assert.deepEqual(stored, ['alpha.test'])

  const recovered = await store.mutate({ type: 'set-pinned', domain: 'charlie.test', pinned: true })
  assert.equal(recovered.ok, true)
  assert.deepEqual(stored, ['alpha.test', 'charlie.test'])
})

test('a rejected exclusive lock releases the local serializer for the next mutation', async () => {
  let stored: string[] = []
  let lockAttempts = 0
  const store = createStorageListMutationStore<PinnedDomainMutation>({
    adapter: {
      read: async () => [...stored],
      write: async (value) => {
        stored = [...value]
      },
      runExclusive: async (task) => {
        lockAttempts += 1
        if (lockAttempts === 1) throw new Error('lock unavailable')
        return task()
      }
    },
    applyOperation: applyPinnedDomainMutation,
    normalize: normalizePinnedDomains
  })

  const failed = await store.mutate({ type: 'set-pinned', domain: 'alpha.test', pinned: true })
  assert.equal(failed.ok, false)
  if (failed.ok) return
  assert.equal(failed.currentValue, null)
  assert.match(String(failed.error), /lock unavailable/)

  const recovered = await store.mutate({ type: 'set-pinned', domain: 'bravo.test', pinned: true })
  assert.equal(recovered.ok, true)
  assert.deepEqual(stored, ['bravo.test'])
})
