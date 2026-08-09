import { Effect, Layer } from 'effect'

import type { ChromeApi } from '../../../src/extension/background/chrome-api.js'
import {
  readChromeStorageValue,
  removeChromeStorageValue,
  writeChromeStorageValue
} from '../../../src/extension/background/chrome-storage.js'
import {
  emptyWorkingSetActivity,
  parseWorkingSetActivityStorageValue
} from '../../../src/extension/working-set.js'
import {
  WORKING_SET_ACTIVITY_KEY,
  WorkingSetActivityStorage,
  WorkingSetActivityStorageError,
  type WorkingSetActivityWrite
} from '../../../src/extension/background/working-set-activity-storage.js'
import {
  makeMutationDiagnostics,
  type WorkingSetBenchmarkBackend
} from './benchmark-backend.js'

const diagnostics = makeMutationDiagnostics()
let failNextWrite = false

function fallbackValidActivity() {
  const activity = emptyWorkingSetActivity()
  const key = 'https://example.test/benchmark-valid'
  const at = Date.now()
  activity.records[key] = {
    key,
    url: key,
    title: 'Example Benchmark Record',
    domain: 'example.test',
    lastSeenAt: at,
    lastActivatedAt: at,
    events: [{ kind: 'activation', at }]
  }
  return activity
}

export function makeWorkingSetActivityStorageLayer(
  chromeApi: ChromeApi
): Layer.Layer<WorkingSetActivityStorage> {
  const storage = chromeApi.storage?.local
  const unavailable = (): Promise<never> => Promise.reject(
    new Error('Chrome local storage is unavailable for Working Set activity')
  )
  const legacyLayer = WorkingSetActivityStorage.layer({
    read: () => storage
      ? readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
      : unavailable(),
    write: (change: WorkingSetActivityWrite) => storage
      ? writeChromeStorageValue(
          storage,
          WORKING_SET_ACTIVITY_KEY,
          change.activity
        )
      : unavailable(),
    replace: (activity) => storage
      ? writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, activity)
      : unavailable()
  })
  return Layer.effect(
    WorkingSetActivityStorage,
    Effect.gen(function*() {
      const legacyStorage = yield* WorkingSetActivityStorage
      const write = Effect.fn('WorkingSetBenchmark.currentEnvelope.write')(
        function*(change: WorkingSetActivityWrite) {
          yield* Effect.sync(diagnostics.beginWrite)
          const shouldFail = yield* Effect.sync(() => {
            if (!failNextWrite) return false
            failNextWrite = false
            return true
          })
          if (shouldFail) {
            return yield* Effect.fail(WorkingSetActivityStorageError.make({
              operation: 'write',
              reason: 'backend',
              cause: new Error('Synthetic Working Set benchmark write failure')
            }))
          }
          yield* legacyStorage.write(change)
          yield* Effect.sync(() => diagnostics.commitMutation(
            [change.activity],
            [WORKING_SET_ACTIVITY_KEY]
          ))
        }
      )
      return WorkingSetActivityStorage.of({
        read: legacyStorage.read,
        write,
        replace: legacyStorage.replace
      })
    })
  ).pipe(Layer.provide(legacyLayer))
}

export const benchmarkBackend: WorkingSetBenchmarkBackend = {
  variant: 'current',
  ownedStorage: {
    kind: 'chrome-storage',
    keys: [WORKING_SET_ACTIVITY_KEY]
  },
  lastMutationLogicalBytes: diagnostics.lastMutationLogicalBytes,
  lastMutationPhysicalWrites: diagnostics.lastMutationPhysicalWrites,
  writeInvocationCount: diagnostics.writeInvocationCount,
  failNextMutation() {
    failNextWrite = true
  },
  async corrupt(kind, chromeApi): Promise<void> {
    const storage = chromeApi.storage?.local
    if (storage === undefined) {
      throw new Error('Chrome local storage is unavailable')
    }
    if (kind === 'missing-required-store') {
      // Key storage has no schema authority to remove; absence of its sole
      // owned key is the comparable, explicitly known-empty condition.
      await removeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
      return
    }
    if (kind === 'outer-version') {
      await writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, {
        version: 2,
        records: {}
      })
      return
    }

    const parsed = parseWorkingSetActivityStorageValue(
      await readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
    )
    const activity = parsed.status === 'valid' &&
      Object.keys(parsed.activity.records).length > 0
      ? parsed.activity
      : fallbackValidActivity()
    await writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, {
      version: 1,
      records: {
        ...activity.records,
        'invalid-benchmark-row': null
      }
    })
  },
  async reset(chromeApi): Promise<void> {
    failNextWrite = false
    diagnostics.reset()
    const storage = chromeApi.storage?.local
    if (storage !== undefined) {
      await removeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
    }
  },
  close: () => {}
}
