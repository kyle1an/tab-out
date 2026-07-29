export function installWebLocksStub(): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        request: async <Value>(_name: string, task: () => Promise<Value> | Value): Promise<Value> => task()
      }
    }
  })
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, 'navigator', previous)
    } else {
      delete (globalThis as { navigator?: unknown }).navigator
    }
  }
}
