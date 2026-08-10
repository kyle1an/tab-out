import { Effect, Schema, Semaphore } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { runPromiseExclusiveEffect } from './promise-exclusive-effect.js'
import {
  normalizeSavedPagesStore,
  SAVED_PAGES_STORAGE_KEY,
  savedPageRecordsEqual,
  savedPagesStoresEqual,
  type SavedPagesStore,
  type SavedPagesStoreMutation,
} from './saved-pages.js'
import { parseSavedPagesStoreValue } from './saved-pages-storage.js'

export type SavedPagesStoreAdapter = {
  read: () => Promise<unknown>
  write: (store: SavedPagesStore) => Promise<void>
  runExclusive?: <Value>(task: () => Promise<Value>) => Promise<Value>
}

export type SavedPagesMutationStore = {
  mutateEffect: <Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
  ) => Effect.Effect<Value, SavedPagesMutationError>
  mutate: <Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
  ) => Promise<Value>
  persistMetadataUpdatesEffect: (
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined,
  ) => Effect.Effect<void, SavedPagesMutationError>
  persistMetadataUpdates: (
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined,
  ) => Promise<void>
}

export class SavedPagesMutationError extends Schema.TaggedErrorClass<SavedPagesMutationError>()(
  'SavedPagesMutationError',
  { cause: Schema.Defect() },
) {}

/**
 * Serialize Saved Pages read-modify-write operations through one seam. The
 * production adapter also supplies a Web Lock, so separate Tab Out pages for
 * the same extension origin cannot both read an old store and overwrite each
 * other's user intent. A rejected read aborts the mutation before any write.
 */
export function createSavedPagesMutationStore(adapter: SavedPagesStoreAdapter): SavedPagesMutationStore {
  const mutationSemaphore = Semaphore.makeUnsafe(1)

  const runSavedPagesMutation = Effect.fn('savedPages.runMutation')(function* <Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
  ) {
    const transaction = Effect.gen(function* () {
      const stored = yield* Effect.tryPromise({
        try: adapter.read,
        catch: (cause) => SavedPagesMutationError.make({ cause }),
      })
      const parsed = yield* Effect.try({
        try: () => parseSavedPagesStoreValue(stored),
        catch: (cause) => SavedPagesMutationError.make({ cause }),
      })
      if (!parsed.ok) {
        return yield* Effect.fail(SavedPagesMutationError.make({
          cause: new Error('Saved Pages storage is malformed'),
        }))
      }
      const currentStore = parsed.value
      const result = yield* Effect.try({
        try: () => mutation(currentStore),
        catch: (cause) => SavedPagesMutationError.make({ cause }),
      })
      const nextStore = yield* Effect.try({
        try: () => normalizeSavedPagesStore(result.store),
        catch: (cause) => SavedPagesMutationError.make({ cause }),
      })
      const storesEqual = yield* Effect.try({
        try: () => savedPagesStoresEqual(currentStore, nextStore),
        catch: (cause) => SavedPagesMutationError.make({ cause }),
      })
      if (!storesEqual) {
        yield* Effect.tryPromise({
          try: () => adapter.write(nextStore),
          catch: (cause) => SavedPagesMutationError.make({ cause }),
        })
      }
      return result.value
    })

    const runExclusive = adapter.runExclusive
    if (!runExclusive) return yield* transaction
    return yield* runPromiseExclusiveEffect(
      runExclusive,
      transaction,
      (cause) => SavedPagesMutationError.make({ cause }),
    )
  })

  function mutateEffect<Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
  ): Effect.Effect<Value, SavedPagesMutationError> {
    return mutationSemaphore.withPermit(runSavedPagesMutation(mutation))
  }

  function mutate<Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
  ): Promise<Value> {
    return getAppRuntime().runPromise(mutateEffect(mutation).pipe(
      Effect.catchTag('SavedPagesMutationError', (error) => Effect.fail(error.cause)),
    ))
  }

  const persistMetadataUpdatesEffect = Effect.fn(
    'savedPages.persistMetadataUpdates',
  )(function* (
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined,
  ) {
    const [base, merged] = yield* Effect.try({
      try: () => [
        normalizeSavedPagesStore(baseStore),
        normalizeSavedPagesStore(mergedStore),
      ] as const,
      catch: (cause) => SavedPagesMutationError.make({ cause }),
    })
    const updates = Object.keys(base.pages).flatMap((key) => {
      const before = base.pages[key]
      const after = merged.pages[key]
      return before && after && !savedPageRecordsEqual(before, after)
        ? [{ key, before, after }]
        : []
    })
    if (updates.length === 0) return

    return yield* mutateEffect((latestStore) => {
      const nextStore = normalizeSavedPagesStore(latestStore)
      for (const { key, before, after } of updates) {
        const latestRecord = latestStore.pages[key]
        // The render snapshot is advisory. Apply it only while the stored
        // record is still exactly the version that produced the snapshot;
        // a remove, re-save, or newer metadata refresh always wins.
        if (!latestRecord || !savedPageRecordsEqual(latestRecord, before)) continue
        nextStore.pages[key] = after
      }
      return { store: nextStore, value: undefined }
    })
  })

  function persistMetadataUpdates(
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined,
  ): Promise<void> {
    return getAppRuntime().runPromise(
      persistMetadataUpdatesEffect(baseStore, mergedStore).pipe(
        Effect.catchTag('SavedPagesMutationError', (error) => Effect.fail(error.cause)),
      ),
    )
  }

  return {
    mutateEffect,
    mutate,
    persistMetadataUpdatesEffect,
    persistMetadataUpdates,
  }
}

const SAVED_PAGES_MUTATION_LOCK = 'tab-out:saved-pages-mutation'

function savedPagesStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Saved Pages storage is unavailable')
  }
  return chrome.storage.local
}

async function readSavedPagesStoreValue(): Promise<unknown> {
  const stored = await savedPagesStorageArea().get(SAVED_PAGES_STORAGE_KEY)
  return stored[SAVED_PAGES_STORAGE_KEY]
}

async function writeSavedPagesStoreValue(store: SavedPagesStore): Promise<void> {
  await savedPagesStorageArea().set({ [SAVED_PAGES_STORAGE_KEY]: store })
}

const savedPagesMutationStore = createSavedPagesMutationStore({
  read: readSavedPagesStoreValue,
  write: writeSavedPagesStoreValue,
  runExclusive: (task) => navigator.locks.request(SAVED_PAGES_MUTATION_LOCK, task),
})

export function mutateSavedPagesStore<Value>(
  mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
): Promise<Value> {
  return savedPagesMutationStore.mutate(mutation)
}

export function mutateSavedPagesStoreEffect<Value>(
  mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
): Effect.Effect<Value, SavedPagesMutationError> {
  return savedPagesMutationStore.mutateEffect(mutation)
}

export function persistSavedPageMetadataUpdatesEffect(
  baseStore: Partial<SavedPagesStore> | null | undefined,
  mergedStore: Partial<SavedPagesStore> | null | undefined,
): Effect.Effect<void, SavedPagesMutationError> {
  return savedPagesMutationStore.persistMetadataUpdatesEffect(baseStore, mergedStore)
}
