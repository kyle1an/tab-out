import type { Layer } from 'effect'

import type { ChromeApi } from '../../../src/extension/background/chrome-api.js'
import {
  emptyWorkingSetActivity,
  normalizeWorkingSetActivity
} from '../../../src/extension/working-set.js'
import {
  WorkingSetActivityStorage,
  type WorkingSetActivityStorageBackend,
  type WorkingSetActivityWrite
} from '../../../src/extension/background/working-set-activity-storage.js'
import type { WorkingSetActivityStore } from '../../../src/extension/types'
import {
  decodeCompactActivityEnvelope,
  DISPOSABLE_BENCHMARK_PREFIX,
  encodeCompactActivityEnvelope,
  makeMutationDiagnostics,
  makePromiseSerializer,
  type BenchmarkChromeStorageArea,
  type CompactActivityEnvelope,
  type WorkingSetBenchmarkBackend
} from './benchmark-backend.js'

export const CHROME_SHARD_COUNT = 32
export const CHROME_SHARD_STORAGE_KEYS = Array.from(
  { length: CHROME_SHARD_COUNT },
  (_, index) =>
    `${DISPOSABLE_BENCHMARK_PREFIX}:shard:${index.toString().padStart(2, '0')}`
)

const diagnostics = makeMutationDiagnostics()
let failNextWrite = false
const ALL_SHARD_INDEXES = Array.from(
  { length: CHROME_SHARD_COUNT },
  (_, index) => index
)

export function shardForWorkingSetKey(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % CHROME_SHARD_COUNT
}

export function makeWorkingSetActivityStorageLayer(
  chromeApi: ChromeApi
): Layer.Layer<WorkingSetActivityStorage> {
  return makeChromeShardsStorageLayer(chromeApi.storage?.local)
}

export function makeChromeShardsStorageLayer(
  storage: BenchmarkChromeStorageArea | undefined
): Layer.Layer<WorkingSetActivityStorage> {
  return WorkingSetActivityStorage.layer(makeChromeShardsBackend(storage))
}

function makeChromeShardsBackend(
  storage: BenchmarkChromeStorageArea | undefined
): WorkingSetActivityStorageBackend {
  const serialize = makePromiseSerializer()
  let expirySwept = false
  let requiresShardInitialization = true

  const persistShards = async (
    activity: WorkingSetActivityStore,
    shardIndexes: readonly number[]
  ): Promise<void> => {
    const encoded = shardIndexes.map((shardIndex) =>
      encodeShard(activity, shardIndex)
    )
    const keys = shardIndexes.map(shardStorageKey)
    if (storage === undefined) {
      throw new Error('Chrome local storage is unavailable')
    }
    if (keys.length === 0) {
      diagnostics.commitMutation([], [])
      return
    }
    await storage.set(Object.fromEntries(keys.map((key, index) => [
      key,
      encoded[index]
    ])))
    diagnostics.commitMutation(encoded, keys)
  }

  return {
    read: () => serialize(async () => {
      if (storage === undefined) {
        throw new Error('Chrome local storage is unavailable')
      }
      const stored = await storage.get([...CHROME_SHARD_STORAGE_KEYS])
      const presentShardCount = CHROME_SHARD_STORAGE_KEYS.filter(
        (key) => stored[key] !== undefined
      ).length
      if (presentShardCount === 0) {
        requiresShardInitialization = true
        expirySwept = true
        return emptyWorkingSetActivity()
      }
      if (presentShardCount !== CHROME_SHARD_COUNT) {
        throw new Error(
          `Incomplete Working Set shard set: expected ${CHROME_SHARD_COUNT}, found ${presentShardCount}`
        )
      }

      const decoded = await Promise.all(CHROME_SHARD_STORAGE_KEYS.map(
        async (key, shardIndex) => {
          const activity = await decodeCompactActivityEnvelope(stored[key])
          return retainRecordsForShard(activity, shardIndex)
        }
      ))
      requiresShardInitialization = false
      const materialized = expirySwept
        ? decoded
        : decoded.map((activity) => normalizeWorkingSetActivity(activity))
      if (!expirySwept) {
        const replacements: Record<string, unknown> = {}
        for (const [index, key] of CHROME_SHARD_STORAGE_KEYS.entries()) {
          if (stored[key] === undefined) continue
          const compact = encodeCompactActivityEnvelope(
            materialized[index] ?? emptyWorkingSetActivity()
          )
          if (JSON.stringify(compact) !== JSON.stringify(stored[key])) {
            replacements[key] = compact
          }
        }
        if (Object.keys(replacements).length > 0) {
          try {
            await storage.set(replacements)
          } catch {
            // A complete semantic read remains valid when best-effort cleanup fails.
          }
        }
        expirySwept = true
      }
      return {
        version: 1,
        records: Object.assign(
          {},
          ...materialized.map((activity) => activity.records)
        )
      }
    }),
    write: (change: WorkingSetActivityWrite) => {
      diagnostics.beginWrite()
      if (failNextWrite) {
        failNextWrite = false
        return serialize(() => Promise.reject(
          new Error('Synthetic Working Set benchmark write failure')
        ))
      }
      const touched = new Set(change.deleteKeys.map(shardForWorkingSetKey))
      if (change.upsert !== null) {
        touched.add(shardForWorkingSetKey(change.upsert.key))
      }
      return serialize(async () => {
        const shardIndexes = requiresShardInitialization
          ? ALL_SHARD_INDEXES
          : [...touched].toSorted((left, right) => left - right)
        await persistShards(change.activity, shardIndexes)
        if (requiresShardInitialization) requiresShardInitialization = false
      })
    },
    replace: (activity: WorkingSetActivityStore) => serialize(async () => {
      await persistShards(activity, ALL_SHARD_INDEXES)
      requiresShardInitialization = false
      expirySwept = false
    })
  }
}

function retainRecordsForShard(
  activity: WorkingSetActivityStore,
  shardIndex: number
): WorkingSetActivityStore {
  return {
    version: 1,
    records: Object.fromEntries(Object.entries(activity.records).filter(
      ([recordKey]) => shardForWorkingSetKey(recordKey) === shardIndex
    ))
  }
}

function encodeShard(
  activity: WorkingSetActivityStore,
  shardIndex: number
): CompactActivityEnvelope {
  return encodeCompactActivityEnvelope({
    version: 1,
    records: Object.fromEntries(Object.entries(activity.records).filter(
      ([key]) => shardForWorkingSetKey(key) === shardIndex
    ))
  })
}

function shardStorageKey(shardIndex: number): string {
  const key = CHROME_SHARD_STORAGE_KEYS[shardIndex]
  if (key === undefined) {
    throw new RangeError(`Unknown Working Set benchmark shard ${shardIndex}`)
  }
  return key
}

export const benchmarkBackend: WorkingSetBenchmarkBackend = {
  variant: 'shards-32',
  ownedStorage: {
    kind: 'chrome-storage',
    keys: CHROME_SHARD_STORAGE_KEYS
  },
  lastMutationLogicalBytes: diagnostics.lastMutationLogicalBytes,
  lastMutationPhysicalWrites: diagnostics.lastMutationPhysicalWrites,
  writeInvocationCount: diagnostics.writeInvocationCount,
  failNextMutation() {
    failNextWrite = true
  },
  async corrupt(kind, chromeApi) {
    const storage = chromeApi.storage?.local
    if (storage === undefined) {
      throw new Error('Chrome local storage is unavailable')
    }
    if (kind === 'missing-required-store') {
      await storage.remove(shardStorageKey(0))
      return
    }
    if (kind === 'outer-version') {
      await storage.set({ [shardStorageKey(0)]: [999, []] })
      return
    }

    await corruptShardedRow(storage)
  },
  async reset(chromeApi) {
    await chromeApi.storage?.local?.remove([...CHROME_SHARD_STORAGE_KEYS])
    failNextWrite = false
    diagnostics.reset()
  },
  close() {}
}

export async function corruptShardedRow(
  storage: BenchmarkChromeStorageArea
): Promise<void> {
  const stored = await storage.get([...CHROME_SHARD_STORAGE_KEYS])
  let targetIndex = CHROME_SHARD_STORAGE_KEYS.findIndex(
    (key) => stored[key] !== undefined
  )
  if (targetIndex < 0) targetIndex = 0
  let activity = emptyWorkingSetActivity()

  for (const [shardIndex, key] of CHROME_SHARD_STORAGE_KEYS.entries()) {
    if (stored[key] === undefined) continue
    try {
      const decoded = await decodeCompactActivityEnvelope(stored[key])
      if (Object.keys(decoded.records).length > 0) {
        targetIndex = shardIndex
        activity = decoded
        break
      }
    } catch {
      // Keep searching for a shard with a valid sibling record.
    }
  }
  if (Object.keys(activity.records).length === 0) {
    activity = fallbackActivityForShard(targetIndex)
  }

  const encoded = encodeCompactActivityEnvelope(activity)
  await storage.set({
    [shardStorageKey(targetIndex)]: [
      encoded[0],
      [...encoded[1], ['malformed-benchmark-row']]
    ]
  })
}

function fallbackActivityForShard(shardIndex: number): WorkingSetActivityStore {
  const at = Date.now()
  const key = fallbackKeyForShard(shardIndex)
  return {
    version: 1,
    records: {
      [key]: {
        key,
        url: key,
        title: 'Example Benchmark Record',
        domain: URL.parse(key)?.hostname ?? '',
        lastSeenAt: at,
        lastActivatedAt: at,
        events: [{ kind: 'activation', at }]
      }
    }
  }
}

function fallbackKeyForShard(shardIndex: number): string {
  for (let index = 0; index < 10_000; index += 1) {
    const key = `https://example.test/benchmark-valid-${String(index)}`
    if (shardForWorkingSetKey(key) === shardIndex) return key
  }
  throw new Error(`Unable to create benchmark fallback for shard ${shardIndex}`)
}
