import { Effect } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { restoreClosedTabEffect } from './closed-tabs.js'

const runRestoreClosedTab = Effect.fn('closedTabActions.restore')(function*(sessionId: string) {
  if (!sessionId) return false
  const browserTabs = yield* BrowserTabs
  return yield* restoreClosedTabEffect(browserTabs.restoreSession(sessionId))
})

export function restoreClosedTab(sessionId: string): Promise<boolean> {
  return getAppRuntime().runPromise(runRestoreClosedTab(sessionId))
}
