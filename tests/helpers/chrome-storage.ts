type ChromeStorageShim = {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>
      set: (values: Record<string, unknown>) => Promise<void>
    }
  }
}

export function installChromeStorageMock(
  initial: Record<string, unknown> = {}
) {
  const store: Record<string, unknown> = { ...initial }
  const mock: ChromeStorageShim = {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (values) => {
          Object.assign(store, values)
        }
      }
    }
  }
  const previous = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome?: unknown }).chrome = mock
  return () => {
    if (previous === undefined) {
      delete (globalThis as { chrome?: unknown }).chrome
    } else {
      ;(globalThis as { chrome?: unknown }).chrome = previous
    }
  }
}
