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
  normalize: (value: unknown) => string[]
}

export type StorageListMutationStore<Operation> = {
  mutate: (operation: Operation) => Promise<StorageListMutationAttempt>
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Serializes read-modify-write operations in one JavaScript context. Production
 * adapters add a Web Lock around each queued task so extension pages sharing
 * the same origin also read and write the list atomically with one another.
 */
export function createStorageListMutationStore<Operation>({
  adapter,
  applyOperation,
  normalize
}: StorageListMutationStoreOptions<Operation>): StorageListMutationStore<Operation> {
  let mutationQueue = Promise.resolve()

  function mutate(operation: Operation): Promise<StorageListMutationAttempt> {
    const result = mutationQueue.then(async (): Promise<StorageListMutationAttempt> => {
      let currentValue: string[] | null = null
      const task = async (): Promise<StorageListMutationAttempt> => {
        try {
          currentValue = normalize(await adapter.read())
          const value = normalize(applyOperation(currentValue, operation))
          if (!sameOrder(currentValue, value)) await adapter.write(value)
          return { ok: true, previousValue: currentValue, value }
        } catch (error) {
          return { ok: false, currentValue, error }
        }
      }

      try {
        return adapter.runExclusive ? await adapter.runExclusive(task) : await task()
      } catch (error) {
        return { ok: false, currentValue, error }
      }
    })
    mutationQueue = result.then(() => undefined)
    return result
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
  storageKey: string
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
    }
  }
}
