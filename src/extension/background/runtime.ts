import { Effect, Layer, ManagedRuntime } from 'effect'

import { BrowserTabs } from '../browser-tabs-service.js'
import { Badge } from './badge.js'
import type { ChromeApi } from './chrome-api.js'
import { NativePlacementBridge } from './native-placement-bridge.js'
import { StartupSnapshot } from './startup-snapshot-service.js'
import { TabHistory } from './tab-history-service.js'
import { WorkingSet } from './working-set-service.js'

export function createBackgroundRuntime(chromeApi: ChromeApi) {
  const coreServices = Layer.mergeAll(
    BrowserTabs.layer(),
    Badge.layer(chromeApi),
    NativePlacementBridge.layer(chromeApi),
    TabHistory.layer(chromeApi),
    WorkingSet.layer(chromeApi)
  )
  const getDashboardServiceState = Effect.gen(function*() {
    const workingSet = yield* WorkingSet
    const tabHistoryService = yield* TabHistory
    const workingSetActivity = yield* workingSet.getWorkingSetActivity()
    const { tabHistory, openTabsSnapshot } = yield*
      tabHistoryService.getTabHistorySnapshotCapture(workingSetActivity)
    return { tabHistory, workingSetActivity, openTabsSnapshot }
  })
  const runtimeLayer = StartupSnapshot.layer({
    alarms: chromeApi.alarms,
    getDashboardServiceState
  }).pipe(Layer.provideMerge(coreServices))
  const runtime = ManagedRuntime.make(runtimeLayer)
  // Every worker service layer is synchronously constructed. Build it during
  // module initialization so the first event starts work at the same boundary
  // as Chrome's listener callback rather than waiting on lazy layer startup.
  runtime.runSync(Effect.void)
  return runtime
}
