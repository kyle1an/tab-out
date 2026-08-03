import { Effect, Layer, ManagedRuntime } from 'effect'

import { Badge } from './badge.js'
import type { ChromeApi } from './chrome-api.js'

export function createBackgroundRuntime(chromeApi: ChromeApi) {
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Badge.layer(chromeApi)
  ))
  // Every worker service layer is synchronously constructed. Build it during
  // module initialization so the first event starts work at the same boundary
  // as Chrome's listener callback rather than waiting on lazy layer startup.
  runtime.runSync(Effect.void)
  return runtime
}
