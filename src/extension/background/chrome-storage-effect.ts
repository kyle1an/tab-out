import * as Effect from 'effect/Effect'

export type ChromeStorageReadError = {
  readonly _tag: 'ChromeStorageReadError'
  readonly key: string
  readonly cause: unknown
}

export type ChromeStorageWriteError = {
  readonly _tag: 'ChromeStorageWriteError'
  readonly key: string
  readonly cause: unknown
}

export function readChromeStorageValue(storage: chrome.storage.StorageArea, key: string): Effect.Effect<unknown, ChromeStorageReadError> {
  return Effect.tryPromise({
    try: async () => {
      const stored = await storage.get(key)
      return stored[key]
    },
    catch: (cause) => ({ _tag: 'ChromeStorageReadError', key, cause })
  })
}

export function writeChromeStorageValue(storage: chrome.storage.StorageArea, key: string, value: unknown): Effect.Effect<void, ChromeStorageWriteError> {
  return Effect.tryPromise({
    try: () => storage.set({ [key]: value }),
    catch: (cause) => ({ _tag: 'ChromeStorageWriteError', key, cause })
  })
}

export function runChromeEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

export function runChromeEffectBestEffort<E>(effect: Effect.Effect<unknown, E>): Promise<void> {
  return Effect.runPromise(Effect.catchAll(effect, () => Effect.void)).then(() => undefined)
}
