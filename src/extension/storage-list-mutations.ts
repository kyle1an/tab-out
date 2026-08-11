import { Effect, Schema, Semaphore } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { runPromiseExclusiveEffect } from './promise-exclusive-effect.js'

export type StorageListMutationAttempt =
  | {
    ok: true
    previousValue: string[]
    value: string[]
  }
  | {
    ok: false
    currentValue: string[] | null
    error: unknown
  }

export type StorageListMutationAdapter = {
  read: () => Promise<unknown>
  write: (value: string[]) => Promise<void>
  runExclusive?: <Value>(task: () => Promise<Value>) => Promise<Value>
}

type StorageListMutationStoreOptions<Operation> = {
  adapter: StorageListMutationAdapter
  applyOperation: (value: unknown, operation: Operation) => string[]
  isStoredValue: (value: unknown) => boolean
  normalize: (value: unknown) => string[]
}

export type StorageListMutationStore<Operation> = {
  mutate: (operation: Operation) => Promise<StorageListMutationAttempt>
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

class StorageListMutationError extends Schema.TaggedError<StorageListMutationError>()(
  'StorageListMutationError',
  { cause: Schema.Defect() },
) {}

function successfulMutationAttempt(
  previousValue: string[],
  value: string[],
): StorageListMutationAttempt {
  return { ok: true, previousValue, value }
}

function failedMutationAttempt(
  currentValue: string[] | null,
  error: unknown,
): StorageListMutationAttempt {
  return { ok: false, currentValue, error }
}

/**
 * Serializes read-modify-write operations in one JavaScript context. Production
 * adapters add a Web Lock around each queued task so extension pages sharing
 * the same origin also read and write the list atomically with one another.
 */
export function createStorageListMutationStore<Operation>({
  adapter,
  applyOperation,
  isStoredValue,
  normalize,
}: StorageListMutationStoreOptions<Operation>): StorageListMutationStore<Operation> {
  const mutationSemaphore = Semaphore.makeUnsafe(1)

  const runStorageListMutation = Effect.fn('storageListMutation.run')(function* (operation: Operation) {
    let currentValue: string[] | null = null
    const transaction = Effect.gen(function* () {
      const stored = yield* Effect.tryPromise({
        try: adapter.read,
        catch: (cause) => StorageListMutationError.make({ cause }),
      })
      const storedValueIsValid = yield* Effect.try({
        try: () => isStoredValue(stored),
        catch: (cause) => StorageListMutationError.make({ cause }),
      })
      if (!storedValueIsValid) {
        return yield* Effect.fail(StorageListMutationError.make({
          cause: new TypeError('Stored list value is malformed'),
        }))
      }
      const previousValue = yield* Effect.try({
        try: () => normalize(stored),
        catch: (cause) => StorageListMutationError.make({ cause }),
      })
      currentValue = previousValue
      const value = yield* Effect.try({
        try: () => normalize(applyOperation(previousValue, operation)),
        catch: (cause) => StorageListMutationError.make({ cause }),
      })
      if (!sameOrder(previousValue, value)) {
        yield* Effect.tryPromise({
          try: () => adapter.write(value),
          catch: (cause) => StorageListMutationError.make({ cause }),
        })
      }
      return successfulMutationAttempt(previousValue, value)
    }).pipe(
      Effect.catchTag('StorageListMutationError', (error) => (
        Effect.succeed(failedMutationAttempt(currentValue, error.cause))
      )),
    )

    const runExclusive = adapter.runExclusive
    if (!runExclusive) return yield* transaction
    return yield* runPromiseExclusiveEffect(
      runExclusive,
      transaction,
      (cause) => StorageListMutationError.make({ cause }),
    ).pipe(
      Effect.catchTag('StorageListMutationError', (error) => (
        Effect.succeed(failedMutationAttempt(currentValue, error.cause))
      )),
    )
  })

  function mutate(operation: Operation): Promise<StorageListMutationAttempt> {
    return getAppRuntime().runPromise(
      mutationSemaphore.withPermit(runStorageListMutation(operation)),
    )
  }

  return { mutate }
}

function localStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Pinned dashboard state storage is unavailable')
  }
  return chrome.storage.local
}

export function createChromeStorageListMutationAdapter(
  storageKey: string,
): StorageListMutationAdapter {
  const lockName = `tab-out:storage-list-mutation:${storageKey}`
  return {
    async read() {
      const stored = await localStorageArea().get(storageKey)
      return stored[storageKey]
    },
    async write(value) {
      await localStorageArea().set({ [storageKey]: value })
    },
    async runExclusive(task) {
      return navigator.locks.request(lockName, task)
    },
  }
}
