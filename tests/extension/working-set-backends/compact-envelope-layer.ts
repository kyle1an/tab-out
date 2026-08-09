import type { Layer } from 'effect'

import type { ChromeApi } from '../../../src/extension/background/chrome-api.js'
import {
  emptyWorkingSetActivity,
  normalizeWorkingSetActivity,
} from '../../../src/extension/working-set.js'
import {
  WorkingSetActivityStorage,
  type WorkingSetActivityStorageBackend,
  type WorkingSetActivityWrite,
} from '../../../src/extension/background/working-set-activity-storage.js'
import type { WorkingSetActivityStore } from '../../../src/extension/types'
import {
  decodeCompactActivityEnvelope,
  DISPOSABLE_BENCHMARK_PREFIX,
  encodeCompactActivityEnvelope,
  makeMutationDiagnostics,
  makePromiseSerializer,
  type BenchmarkChromeStorageArea,
  type WorkingSetBenchmarkBackend,
} from './benchmark-backend.js'

export const COMPACT_ENVELOPE_STORAGE_KEY =
  `${DISPOSABLE_BENCHMARK_PREFIX}:compact-envelope`

const diagnostics = makeMutationDiagnostics()
let failNextWrite = false

export function makeWorkingSetActivityStorageLayer(
  chromeApi: ChromeApi,
): Layer.Layer<WorkingSetActivityStorage> {
  return makeCompactEnvelopeStorageLayer(chromeApi.storage?.local)
}

export function makeCompactEnvelopeStorageLayer(
  storage: BenchmarkChromeStorageArea | undefined,
): Layer.Layer<WorkingSetActivityStorage> {
  return WorkingSetActivityStorage.layer(makeCompactEnvelopeBackend(storage))
}

function makeCompactEnvelopeBackend(
  storage: BenchmarkChromeStorageArea | undefined,
): WorkingSetActivityStorageBackend {
  const serialize = makePromiseSerializer()
  let expirySwept = false

  const persist = async (activity: WorkingSetActivityStore): Promise<void> => {
    const encoded = encodeCompactActivityEnvelope(activity)
    if (storage === undefined) {
      throw new Error('Chrome local storage is unavailable')
    }
    await storage.set({ [COMPACT_ENVELOPE_STORAGE_KEY]: encoded })
    diagnostics.commitMutation([encoded], [COMPACT_ENVELOPE_STORAGE_KEY])
  }

  return {
    read: () => serialize(async () => {
      if (storage === undefined) {
        throw new Error('Chrome local storage is unavailable')
      }
      const stored = (await storage.get(COMPACT_ENVELOPE_STORAGE_KEY))[
        COMPACT_ENVELOPE_STORAGE_KEY
      ]
      if (stored === undefined) {
        expirySwept = true
        return undefined
      }
      const decoded = await decodeCompactActivityEnvelope(stored)
      if (expirySwept) return decoded

      const normalized = normalizeWorkingSetActivity(decoded)
      const compact = encodeCompactActivityEnvelope(normalized)
      expirySwept = true
      if (JSON.stringify(compact) !== JSON.stringify(stored)) {
        try {
          await storage.set({ [COMPACT_ENVELOPE_STORAGE_KEY]: compact })
        } catch {
          // A complete semantic read remains valid when best-effort cleanup fails.
        }
      }
      return normalized
    }),
    write: (change: WorkingSetActivityWrite) => {
      diagnostics.beginWrite()
      if (failNextWrite) {
        failNextWrite = false
        return serialize(() => Promise.reject(
          new Error('Synthetic Working Set benchmark write failure'),
        ))
      }
      return serialize(() => persist(change.activity))
    },
    replace: (activity: WorkingSetActivityStore) => serialize(async () => {
      await persist(activity)
      expirySwept = false
    }),
  }
}

export const benchmarkBackend: WorkingSetBenchmarkBackend = {
  variant: 'compact',
  ownedStorage: {
    kind: 'chrome-storage',
    keys: [COMPACT_ENVELOPE_STORAGE_KEY],
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
      await storage.remove(COMPACT_ENVELOPE_STORAGE_KEY)
      return
    }
    if (kind === 'outer-version') {
      await storage.set({ [COMPACT_ENVELOPE_STORAGE_KEY]: [999, []] })
      return
    }

    const current = (await storage.get(COMPACT_ENVELOPE_STORAGE_KEY))[
      COMPACT_ENVELOPE_STORAGE_KEY
    ]
    let activity = emptyWorkingSetActivity()
    if (current !== undefined) {
      try {
        activity = await decodeCompactActivityEnvelope(current)
      } catch {
        // A valid row is added below so this corruption specifically probes row isolation.
      }
    }
    if (Object.keys(activity.records).length === 0) {
      activity = fallbackActivity()
    }
    const encoded = encodeCompactActivityEnvelope(activity)
    await storage.set({
      [COMPACT_ENVELOPE_STORAGE_KEY]: [
        encoded[0],
        [...encoded[1], ['malformed-benchmark-row']],
      ],
    })
  },
  async reset(chromeApi) {
    await chromeApi.storage?.local?.remove(COMPACT_ENVELOPE_STORAGE_KEY)
    failNextWrite = false
    diagnostics.reset()
  },
  close() {},
}

function fallbackActivity(): WorkingSetActivityStore {
  const at = Date.now()
  const key = 'https://example.test/benchmark-valid'
  return {
    version: 1,
    records: {
      [key]: {
        key,
        url: key,
        title: 'Example Benchmark Record',
        domain: 'example.test',
        lastSeenAt: at,
        lastActivatedAt: at,
        events: [{ kind: 'activation', at }],
      },
    },
  }
}
