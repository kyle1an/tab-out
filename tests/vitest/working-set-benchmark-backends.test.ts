import assert from 'node:assert/strict'
import { it, test } from '@effect/vitest'
import { Effect, Result, type Layer } from 'effect'

import { WorkingSetActivityStorage } from '../../src/extension/background/working-set-activity-storage.js'
import type {
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
} from '../../src/extension/types'
import { makeWorkingSetStorageProfile } from '../helpers/working-set-storage-profile.js'
import {
  decodeCompactActivityEnvelope,
  encodeCompactActivityEnvelope,
  encodeCompactActivityRecord,
  makeMutationDiagnostics,
  type BenchmarkChromeStorageArea,
  type WorkingSetBenchmarkBackend,
} from '../extension/working-set-backends/benchmark-backend.js'
import {
  benchmarkBackend as compactBenchmarkBackend,
  COMPACT_ENVELOPE_STORAGE_KEY,
  makeCompactEnvelopeStorageLayer,
} from '../extension/working-set-backends/compact-envelope-layer.js'
import {
  benchmarkBackend as shardsBenchmarkBackend,
  CHROME_SHARD_STORAGE_KEYS,
  corruptShardedRow,
  makeChromeShardsStorageLayer,
  shardForWorkingSetKey,
} from '../extension/working-set-backends/chrome-shards-layer.js'
import {
  decodeIndexedDbEntry,
  encodeIndexedDbEntry,
} from '../extension/working-set-backends/indexed-db-layer.js'

const NOW = Date.UTC(2026, 7, 8, 12)
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

class MemoryStorageArea implements BenchmarkChromeStorageArea {
  readonly values = new Map<string, unknown>()
  latestSetKeys: readonly string[] = []
  failNextSet = false
  getInvocationCount = 0
  setInvocationCount = 0

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    this.getInvocationCount += 1
    const requested = typeof keys === 'string' ? [keys] : keys
    return Object.fromEntries(requested.map((key) => [
      key,
      structuredClone(this.values.get(key)),
    ]))
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setInvocationCount += 1
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error('synthetic commit failure')
    }
    this.latestSetKeys = Object.keys(items)
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value))
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    const removed = typeof keys === 'string' ? [keys] : keys
    for (const key of removed) this.values.delete(key)
  }
}

interface ChromeCandidate {
  readonly name: string
  readonly diagnostics: WorkingSetBenchmarkBackend
  readonly makeLayer: (
    storage: BenchmarkChromeStorageArea,
  ) => Layer.Layer<WorkingSetActivityStorage>
}

const chromeCandidates: readonly ChromeCandidate[] = [
  {
    name: 'compact envelope',
    diagnostics: compactBenchmarkBackend,
    makeLayer: makeCompactEnvelopeStorageLayer,
  },
  {
    name: '32 Chrome shards',
    diagnostics: shardsBenchmarkBackend,
    makeLayer: makeChromeShardsStorageLayer,
  },
]

function withStorage<A, E>(
  layer: Layer.Layer<WorkingSetActivityStorage>,
  use: (storage: WorkingSetActivityStorage['Service']) => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return WorkingSetActivityStorage.pipe(
    Effect.flatMap(use),
    Effect.provide(layer),
  )
}

function activityRecord(index: number, at = NOW - index * 1000): WorkingSetActivityRecord {
  const key = `https://example.test/page-${index}`
  return {
    key,
    url: key,
    title: `Page ${index}`,
    domain: 'example.test',
    lastSeenAt: at,
    lastActivatedAt: at,
    events: [{ kind: 'activation', at }],
  }
}

function activityStore(
  records: readonly WorkingSetActivityRecord[],
): WorkingSetActivityStore {
  return {
    version: 1,
    records: Object.fromEntries(records.map((record) => [record.key, record])),
  }
}

test('mutation diagnostics defer payload serialization until metrics are read', () => {
  const diagnostics = makeMutationDiagnostics()
  let serializationCount = 0
  const payload = {
    toJSON() {
      serializationCount += 1
      return { value: 'benchmark-payload' }
    },
  }
  const values: unknown[] = [payload]

  diagnostics.commitMutation(values, ['benchmark-record'])
  values[0] = { value: 'mutated-list-entry' }
  assert.equal(serializationCount, 0)
  const logicalBytes = diagnostics.lastMutationLogicalBytes()
  assert.ok(logicalBytes > 0)
  assert.equal(serializationCount, 1)
  assert.equal(diagnostics.lastMutationLogicalBytes(), logicalBytes)
  assert.equal(serializationCount, 1)
})

test('compact Working Set tuples round-trip exact semantic records and isolate malformed rows', async () => {
  const expected = activityStore([
    {
      ...activityRecord(0),
      dismissedAt: NOW + 100,
      dismissedUntil: NOW + 60_000,
    },
    {
      ...activityRecord(1),
      lastSeenAt: NOW,
      lastNavigatedAt: NOW,
      events: [
        ...activityRecord(1).events,
        { kind: 'navigation', at: NOW },
      ],
    },
  ])
  const encoded = encodeCompactActivityEnvelope(expected)

  assert.deepEqual(await decodeCompactActivityEnvelope(encoded), expected)
  assert.deepEqual(
    await decodeCompactActivityEnvelope([
      encoded[0],
      [encodeCompactActivityRecord(activityRecord(0)), ['malformed-row']],
    ]),
    activityStore([activityRecord(0)]),
  )
  const validRow = encodeCompactActivityRecord(activityRecord(0))
  assert.deepEqual(
    await decodeCompactActivityEnvelope([
      encoded[0],
      [[
        validRow[0],
        validRow[1],
        validRow[2],
        validRow[3],
        [...validRow[4], ['malformed-event']],
      ]],
    ]),
    activityStore([activityRecord(0)]),
  )
  await assert.rejects(() => decodeCompactActivityEnvelope([2, []]))
})

test('IndexedDB projection isolates malformed events and rejects invalid projections', async () => {
  const activatedAt = NOW
  const navigatedAt = NOW - 1000
  const record: WorkingSetActivityRecord = {
    ...activityRecord(2, activatedAt),
    lastNavigatedAt: navigatedAt,
    events: [
      { kind: 'activation', at: activatedAt },
      { kind: 'navigation', at: navigatedAt },
    ],
  }
  const [key, value] = encodeIndexedDbEntry(record)

  assert.equal(key, record.key)
  assert.deepEqual(Object.keys(value).sort(), [
    'events',
    'lastEventAt',
    'title',
  ])
  assert.equal(value.lastEventAt, activatedAt)
  assert.deepEqual(await decodeIndexedDbEntry(key, value), record)
  assert.deepEqual(await decodeIndexedDbEntry(key, {
    ...value,
    events: [
      value.events[0],
      'malformed-event',
      [2, activatedAt + 10_000],
      [0, Number.POSITIVE_INFINITY],
      [1],
      { kind: 'navigation', at: navigatedAt },
      value.events[1],
    ],
  }), record)
  await assert.rejects(() => decodeIndexedDbEntry(key, {
    ...value,
    events: [
      'malformed-event',
      [2, activatedAt],
      [0, Number.POSITIVE_INFINITY],
      [1],
      { kind: 'activation', at: activatedAt },
    ],
  }))
  await assert.rejects(() => decodeIndexedDbEntry(key, {
    ...value,
    lastEventAt: value.lastEventAt + 1,
  }))
})

for (const candidate of chromeCandidates) {
  it.effect(`${candidate.name} fulfills roundtrip, expiry, burst, and commit-failure contracts`, () => {
    const storageArea = new MemoryStorageArea()
    return withStorage(candidate.makeLayer(storageArea), (storage) => Effect.gen(function* () {
      const fresh = activityRecord(0, Date.now() - 1000)
      const expired = activityRecord(1, Date.now() - THIRTY_DAYS_MS - 1)
      yield* storage.replace(activityStore([fresh, expired]))
      assert.equal(storageArea.getInvocationCount, 0)
      assert.deepEqual(
        yield* storage.read(),
        activityStore([fresh]),
      )
      assert.equal(storageArea.setInvocationCount, 2)
      const physicallyRetained = yield* Effect.promise(() => Promise.all(
        [...storageArea.values.values()].map(decodeCompactActivityEnvelope),
      ))
      assert.deepEqual(
        physicallyRetained.flatMap((activity) =>
          Object.keys(activity.records).filter((key) => key === expired.key),
        ),
        [],
      )

      const writesBeforeBurst = candidate.diagnostics.writeInvocationCount()
      const cumulative: WorkingSetActivityRecord[] = []
      const burst = Array.from({ length: 40 }, (_, index) => {
        const upsert = activityRecord(index + 10, Date.now() - index)
        cumulative.push(upsert)
        return {
          activity: activityStore([...cumulative]),
          upsert,
          deleteKeys: [],
        }
      })
      yield* Effect.all(burst.map((change) => storage.write(change)), {
        concurrency: 'unbounded',
      })
      assert.deepEqual(
        Object.keys((yield* storage.read()).records).sort(),
        Object.keys(burst.at(-1)?.activity.records ?? {}).sort(),
      )
      assert.equal(
        candidate.diagnostics.writeInvocationCount() - writesBeforeBurst,
        burst.length,
      )

      storageArea.failNextSet = true
      assert.equal(Result.isFailure(yield* Effect.result(storage.replace(
        activityStore([activityRecord(99, Date.now())]),
      ))), true)
    }))
  })
}

for (const candidate of chromeCandidates) {
  it.effect(`${candidate.name} fails exactly its next ordinary mutation`, () => {
    const storageArea = new MemoryStorageArea()
    const original = activityRecord(40, Date.now() - 1000)
    const updatedAt = Date.now()
    const updated: WorkingSetActivityRecord = {
      ...original,
      lastSeenAt: updatedAt,
      lastNavigatedAt: updatedAt,
      events: [...original.events, { kind: 'navigation', at: updatedAt }],
    }

    return withStorage(candidate.makeLayer(storageArea), (storage) => Effect.gen(function* () {
      yield* storage.replace(activityStore([original]))
      candidate.diagnostics.failNextMutation()
      yield* storage.replace(activityStore([original]))
      const writesBeforeFailure = candidate.diagnostics.writeInvocationCount()

      assert.equal(Result.isFailure(yield* Effect.result(storage.write({
        activity: activityStore([updated]),
        upsert: updated,
        deleteKeys: [],
      }))), true)
      assert.deepEqual(
        yield* storage.read(),
        activityStore([original]),
      )
      assert.equal(
        candidate.diagnostics.writeInvocationCount(),
        writesBeforeFailure + 1,
      )

      yield* storage.write({
        activity: activityStore([updated]),
        upsert: updated,
        deleteKeys: [],
      })
      assert.deepEqual(
        yield* storage.read(),
        activityStore([updated]),
      )
    }))
  })
}

for (const candidate of [
  {
    name: 'compact envelope',
    makeLayer: () => makeCompactEnvelopeStorageLayer(undefined),
  },
  {
    name: '32 Chrome shards',
    makeLayer: () => makeChromeShardsStorageLayer(undefined),
  },
]) {
  it.effect(`${candidate.name} fails closed when Chrome local storage is unavailable`, () => {
    const record = activityRecord(30, Date.now())

    return withStorage(candidate.makeLayer(), (storage) => Effect.gen(function* () {
      assert.equal(Result.isFailure(yield* Effect.result(storage.read())), true)
      assert.equal(Result.isFailure(yield* Effect.result(storage.write({
        activity: activityStore([record]),
        upsert: record,
        deleteKeys: [],
      }))), true)
      assert.equal(
        Result.isFailure(yield* Effect.result(storage.replace(activityStore([record])))),
        true,
      )
    }))
  })
}

it.effect('a sharded record mutation writes exactly its deterministic shard', () => {
  const storageArea = new MemoryStorageArea()
  const original = activityRecord(3)
  const updated: WorkingSetActivityRecord = {
    ...original,
    lastSeenAt: NOW + 1000,
    lastNavigatedAt: NOW + 1000,
    events: [...original.events, { kind: 'navigation', at: NOW + 1000 }],
  }

  return withStorage(makeChromeShardsStorageLayer(storageArea), (storage) => Effect.gen(function* () {
    yield* storage.replace(activityStore([original]))
    yield* storage.write({
      activity: activityStore([updated]),
      upsert: updated,
      deleteKeys: [],
    })

    assert.equal(storageArea.latestSetKeys.length, 1)
    assert.deepEqual(
      storageArea.latestSetKeys,
      shardsBenchmarkBackend.lastMutationPhysicalWrites(),
    )
    assert.match(
      storageArea.latestSetKeys[0] ?? '',
      new RegExp(`:${shardForWorkingSetKey(updated.key).toString().padStart(2, '0')}$`),
    )
  }))
})

it.effect('an empty shard set initializes all 32 keys on its first record write', () => {
  const storageArea = new MemoryStorageArea()
  const record = activityRecord(7, Date.now())

  return withStorage(makeChromeShardsStorageLayer(storageArea), (storage) => Effect.gen(function* () {
    assert.deepEqual(
      yield* storage.read(),
      activityStore([]),
    )
    yield* storage.write({
      activity: activityStore([record]),
      upsert: record,
      deleteKeys: [],
    })

    assert.deepEqual(
      storageArea.latestSetKeys.toSorted(),
      [...CHROME_SHARD_STORAGE_KEYS].toSorted(),
    )
    assert.equal(storageArea.values.size, CHROME_SHARD_STORAGE_KEYS.length)
    assert.deepEqual(
      yield* storage.read(),
      activityStore([record]),
    )
  }))
})

it.effect('a partial shard set fails instead of materializing missing shards as empty', () => {
  const storageArea = new MemoryStorageArea()

  return withStorage(makeChromeShardsStorageLayer(storageArea), (storage) => Effect.gen(function* () {
    yield* storage.replace(activityStore([]))
    yield* Effect.promise(() => storageArea.remove(CHROME_SHARD_STORAGE_KEYS[0] ?? ''))

    assert.equal(Result.isFailure(yield* Effect.result(storage.read())), true)
  }))
})

it.effect('a record stored outside its deterministic shard is isolated and repaired', () => {
  const storageArea = new MemoryStorageArea()
  const misplaced = activityRecord(8, Date.now())
  const correctShard = shardForWorkingSetKey(misplaced.key)
  const wrongShard = (correctShard + 1) % CHROME_SHARD_STORAGE_KEYS.length
  const wrongShardKey = CHROME_SHARD_STORAGE_KEYS[wrongShard]
  const sibling = Array.from(
    { length: 1000 },
    (_, index) => activityRecord(index + 100, Date.now() - index),
  ).find((record) => shardForWorkingSetKey(record.key) === wrongShard)

  return withStorage(makeChromeShardsStorageLayer(storageArea), (storage) => Effect.gen(function* () {
    yield* storage.replace(activityStore([]))
    if (wrongShardKey === undefined || sibling === undefined) {
      throw new Error('Expected deterministic benchmark shard fixture')
    }
    yield* Effect.promise(() => storageArea.set({
      [wrongShardKey]: encodeCompactActivityEnvelope(
        activityStore([misplaced, sibling]),
      ),
    }))

    assert.deepEqual(
      yield* storage.read(),
      activityStore([sibling]),
    )
    assert.deepEqual(storageArea.latestSetKeys, [wrongShardKey])
    assert.deepEqual(
      yield* Effect.promise(() => decodeCompactActivityEnvelope(storageArea.values.get(wrongShardKey))),
      activityStore([sibling]),
    )
  }))
})

it.effect('shard row corruption preserves every record in the 500x20 profile', () => {
  const storageArea = new MemoryStorageArea()
  const profile = makeWorkingSetStorageProfile('500x20', Date.now())
  const expectedKeys = Object.keys(profile.activity.records).toSorted()
  const record0039 = Object.values(profile.activity.records).find(
    (record) => record.domain === 'working-set-0039.example.test',
  )

  return withStorage(makeChromeShardsStorageLayer(storageArea), (storage) => Effect.gen(function* () {
    yield* storage.replace(profile.activity)
    yield* Effect.promise(() => corruptShardedRow(storageArea))
    const repaired = yield* storage.read()

    assert.deepEqual(Object.keys(repaired.records).toSorted(), expectedKeys)
    assert.ok(record0039 !== undefined)
    assert.ok(repaired.records[record0039.key] !== undefined)
  }))
})

it.effect('a compact record mutation rewrites its one whole-envelope key', () => {
  const storageArea = new MemoryStorageArea()
  const record = activityRecord(4)

  return withStorage(makeCompactEnvelopeStorageLayer(storageArea), (storage) => Effect.gen(function* () {
    yield* storage.write({
      activity: activityStore([record]),
      upsert: record,
      deleteKeys: [],
    })
    assert.deepEqual(storageArea.latestSetKeys, [COMPACT_ENVELOPE_STORAGE_KEY])
    assert.deepEqual(
      compactBenchmarkBackend.lastMutationPhysicalWrites(),
      [COMPACT_ENVELOPE_STORAGE_KEY],
    )
  }))
})

it.effect('compact cleanup failure preserves the semantic read and is attempted once', () => {
  const storageArea = new MemoryStorageArea()
  const fresh = activityRecord(20, Date.now())
  const expired = activityRecord(21, Date.now() - THIRTY_DAYS_MS - 1)

  return withStorage(makeCompactEnvelopeStorageLayer(storageArea), (storage) => Effect.gen(function* () {
    yield* storage.replace(activityStore([fresh, expired]))
    const setsBeforeCleanup = storageArea.setInvocationCount
    storageArea.failNextSet = true

    assert.deepEqual(
      yield* storage.read(),
      activityStore([fresh]),
    )
    assert.equal(storageArea.setInvocationCount, setsBeforeCleanup + 1)
    assert.deepEqual(
      yield* storage.read(),
      activityStore([fresh]),
    )
    assert.equal(storageArea.setInvocationCount, setsBeforeCleanup + 1)
  }))
})
