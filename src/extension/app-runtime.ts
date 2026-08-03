import { Effect, Layer, ManagedRuntime } from 'effect'

import { BrowserTabs } from './browser-tabs-service.js'

function createAppRuntime() {
  const runtime = ManagedRuntime.make(Layer.mergeAll(BrowserTabs.layer()))
  // Construct the page service graph before the startup workflow so every
  // browser operation shares this runtime from the first Chrome read onward.
  runtime.runSync(Effect.void)
  return runtime
}

let sharedAppRuntime: ReturnType<typeof createAppRuntime> | null = null

export function getAppRuntime() {
  sharedAppRuntime ??= createAppRuntime()
  return sharedAppRuntime
}
