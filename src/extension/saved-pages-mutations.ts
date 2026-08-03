import { Data, Effect, Semaphore } from 'effect'

import {
  normalizeSavedPagesStore,
  SAVED_PAGES_STORAGE_KEY,
  savedPageRecordsEqual,
  savedPagesStoresEqual,
  type SavedPagesStore,
  type SavedPagesStoreMutation
} from './saved-pages.js'
import { parseSavedPagesStoreValue } from './saved-pages-storage.js'

export type SavedPagesStoreAdapter = {
  read: () => Promise<unknown>
  write: (store: SavedPagesStore) => Promise<void>
  runExclusive?: <Value>(task: () => Promise<Value>) => Promise<Value>
}

export type SavedPagesMutationStore = {
  mutate: <Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>
  ) => Promise<Value>
  persistMetadataUpdates: (
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined
  ) => Promise<void>
}

class SavedPagesMutationError extends Data.TaggedError('SavedPagesMutationError')<{
  readonly cause: unknown
}> {}

/**
 * Serialize Saved Pages read-modify-write operations through one seam. The
 * production adapter also supplies a Web Lock, so separate Tab Out pages for
 * the same extension origin cannot both read an old store and overwrite each
 * other's user intent. A rejected read aborts the mutation before any write.
 */
export function createSavedPagesMutationStore(adapter: SavedPagesStoreAdapter): SavedPagesMutationStore {
  const mutationSemaphore = Semaphore.makeUnsafe(1)

  const runSavedPagesMutation = Effect.fn('savedPages.runMutation')(function*<Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>
  ) {
    const transaction = Effect.gen(function*() {
      const stored = yield* Effect.tryPromise({
        try: adapter.read,
        catch: (cause) => new SavedPagesMutationError({ cause })
      })
      const parsed = yield* Effect.try({
        try: () => parseSavedPagesStoreValue(stored),
        catch: (cause) => new SavedPagesMutationError({ cause })
      })
      if (!parsed.ok) {
        return yield* Effect.fail(new SavedPagesMutationError({
          cause: new Error('Saved Pages storage is malformed')
        }))
      }
      const currentStore = parsed.value
      const result = yield* Effect.try({
        try: () => mutation(currentStore),
        catch: (cause) => new SavedPagesMutationError({ cause })
      })
      const nextStore = yield* Effect.try({
        try: () => normalizeSavedPagesStore(result.store),
        catch: (cause) => new SavedPagesMutationError({ cause })
      })
      const storesEqual = yield* Effect.try({
        try: () => savedPagesStoresEqual(currentStore, nextStore),
        catch: (cause) => new SavedPagesMutationError({ cause })
      })
      if (!storesEqual) {
        yield* Effect.tryPromise({
          try: () => adapter.write(nextStore),
          catch: (cause) => new SavedPagesMutationError({ cause })
        })
      }
      return result.value
    })

    const runExclusive = adapter.runExclusive
    if (!runExclusive) return yield* transaction
    return yield* Effect.tryPromise({
      try: () => runExclusive(() => Effect.runPromise(transaction.pipe(
        Effect.catchTag('SavedPagesMutationError', (error) => Effect.fail(error.cause))
      ))),
      catch: (cause) => new SavedPagesMutationError({ cause })
    })
  })

  function mutate<Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>
  ): Promise<Value> {
    return Effect.runPromise(
      mutationSemaphore.withPermit(runSavedPagesMutation(mutation)).pipe(
        Effect.catchTag('SavedPagesMutationError', (error) => Effect.fail(error.cause))
      )
    )
  }

  function persistMetadataUpdates(
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined
  ): Promise<void> {
    const base = normalizeSavedPagesStore(baseStore)
    const merged = normalizeSavedPagesStore(mergedStore)
    const updates = Object.keys(base.pages).flatMap((key) => {
      const before = base.pages[key]
      const after = merged.pages[key]
      return before && after && !savedPageRecordsEqual(before, after)
        ? [{ key, before, after }]
        : []
    })
    if (updates.length === 0) return Promise.resolve()

    return mutate((latestStore) => {
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
  }

  return { mutate, persistMetadataUpdates }
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
  runExclusive: (task) => navigator.locks.request(SAVED_PAGES_MUTATION_LOCK, task)
})

export function mutateSavedPagesStore<Value>(
  mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>
): Promise<Value> {
  return savedPagesMutationStore.mutate(mutation)
}

export function persistSavedPageMetadataUpdates(
  baseStore: Partial<SavedPagesStore> | null | undefined,
  mergedStore: Partial<SavedPagesStore> | null | undefined
): Promise<void> {
  return savedPagesMutationStore.persistMetadataUpdates(baseStore, mergedStore)
}
