import type { StorageListMutationAttempt } from './storage-list-mutations.js'

type SerializedStateWriteResult =
  | { ok: true, isLatest: boolean, value: string[] }
  | { ok: false, isLatest: boolean, rollbackValue: string[], error: unknown }

type SerializedStateWriter<Operation> = {
  replacePersisted(value: string[]): void
  write(operation: Operation): Promise<SerializedStateWriteResult>
}

/**
 * Tracks optimistic mutation revisions around an operation-based persistence
 * boundary. A superseded failure never rolls back newer intent; the latest
 * failure rolls back to the freshest value the boundary successfully read.
 */
export function createSerializedStateWriter<Operation>(
  initialPersistedValue: string[],
  mutate: (operation: Operation) => Promise<StorageListMutationAttempt>,
): SerializedStateWriter<Operation> {
  let latestRevision = 0
  let persistedValue = initialPersistedValue
  let persistedGeneration = 0

  function sameOrder(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  return {
    replacePersisted(value) {
      persistedValue = value
      persistedGeneration += 1
    },
    async write(operation) {
      const revision = ++latestRevision
      const startingPersistedGeneration = persistedGeneration
      const result = await mutate(operation)
      if (result.ok === true) {
        const persistedChangedWhileWriting = persistedGeneration !== startingPersistedGeneration
        if (!persistedChangedWhileWriting || sameOrder(persistedValue, result.value)) {
          persistedValue = result.value
        }
        return {
          ok: true,
          isLatest: revision === latestRevision,
          // storage.onChanged can arrive before the originating set() settles.
          // A matching value is that write's acknowledgement; a different value
          // is newer cross-context state and must win over this in-flight result.
          value: persistedChangedWhileWriting && !sameOrder(persistedValue, result.value)
            ? persistedValue
            : result.value,
        }
      }
      const persistedChangedWhileWriting = persistedGeneration !== startingPersistedGeneration
      if (result.currentValue && (
        !persistedChangedWhileWriting || sameOrder(persistedValue, result.currentValue)
      )) {
        persistedValue = result.currentValue
      }
      return {
        ok: false,
        isLatest: revision === latestRevision,
        rollbackValue: persistedChangedWhileWriting
          ? persistedValue
          : result.currentValue ?? persistedValue,
        error: result.error,
      }
    },
  }
}
