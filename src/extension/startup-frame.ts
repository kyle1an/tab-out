import { Effect, Result, Schema } from 'effect'

import { readAppStartupFilterIntent, type AppStartupFrame } from '../app-startup.js'
import { appDashboardStore, fetchDashboardSnapshotEffect, fetchDashboardStartupSnapshotEffect, type MissionOrderMap } from './dashboard-intake.js'
import { loadDashboardLocalStateResultEffect } from './dashboard-local-state.js'
import { loadClosedGhostDismissalsResultEffect } from './closed-ghost-dismissals.js'
import { isHistoryFilterEnabled } from './history-range.js'
import { loadHistoryRangePreferenceResultEffect } from './history-range-storage.js'
import { fetchDashboardServiceStateResultEffect } from './dashboard-service-state.js'
import {
  dashboardStartupPreviousOrder,
  dashboardStartupTitleHistory,
  loadDashboardStartupSeedEffect,
  rebaseDashboardStartupWorkingSetPriority,
} from './startup-snapshot.js'
import { seedOpenTabsTitleHistory } from './tabs.js'

export class StartupFrameAuthorityError extends Schema.TaggedError<StartupFrameAuthorityError>()(
  'StartupFrameAuthorityError',
  { authority: Schema.String },
) {}

function unknownAuthority(authority: string): StartupFrameAuthorityError {
  return StartupFrameAuthorityError.make({ authority })
}

/**
 * Capture every semantic startup authority before publishing any of them.
 * The compact seed may affect order/title continuity, but never supplies a
 * visible row, action, preference, or dismissal on its own.
 */
export const captureAppStartupFrameEffect = Effect.fn(
  'startupFrame.capture',
)(function* () {
  const [
    seed,
    localStateResult,
    historyRangeResult,
    dismissalsResult,
    serviceStateResult,
  ] = yield* Effect.all([
    loadDashboardStartupSeedEffect(),
    loadDashboardLocalStateResultEffect(),
    loadHistoryRangePreferenceResultEffect(),
    loadClosedGhostDismissalsResultEffect(),
    fetchDashboardServiceStateResultEffect(),
  ] as const, { concurrency: 'unbounded' })

  if (!localStateResult.ok) return yield* Effect.fail(unknownAuthority('pins'))
  if (!historyRangeResult.ok) return yield* Effect.fail(unknownAuthority('history range'))
  if (!dismissalsResult.ok) return yield* Effect.fail(unknownAuthority('closed-row dismissals'))

  seedOpenTabsTitleHistory(dashboardStartupTitleHistory(seed))

  const source = appDashboardStore.read().sourceSelection
  const filter = readAppStartupFilterIntent()
  const tabOrder = dashboardStartupPreviousOrder(seed)
  const previousOrder: MissionOrderMap = {
    tabs: tabOrder,
    bookmarks: new Map(),
    history: new Map(),
  }
  const snapshotOptions = {
    source,
    filter,
    historyRange: historyRangeResult.value,
    historyFilterEnabled: isHistoryFilterEnabled(historyRangeResult.value),
    pinnedDomains: [...localStateResult.state.pinnedDomains],
    prefetchedServiceStateResult: serviceStateResult,
    previousOrder,
  }
  const sourceSnapshotResult = source === 'tabs'
    ? null
    : yield* Effect.result(fetchDashboardSnapshotEffect(snapshotOptions))
  const sourceSnapshot = sourceSnapshotResult && Result.isSuccess(sourceSnapshotResult)
    ? sourceSnapshotResult.success
    : null
  const frameSource = sourceSnapshotResult && Result.isFailure(sourceSnapshotResult)
    ? 'tabs'
    : source
  if (frameSource !== source) appDashboardStore.selectStartupSource(frameSource)
  const tabsSnapshot = yield* fetchDashboardStartupSnapshotEffect({
    ...snapshotOptions,
    source: 'tabs',
    // Tabs-side bookmark/history companions are visible only when Tabs is the
    // admitted source. A successful Bookmarks startup still captures the Tabs
    // authorities needed by Activation History without reading hidden filter
    // companions; a failed source must prepare the complete filtered fallback.
    filter: frameSource === 'tabs' ? filter : '',
  })
  const snapshot = {
    ...tabsSnapshot,
    ...(sourceSnapshot ? { dashboard: sourceSnapshot.dashboard } : {}),
    workingSet: rebaseDashboardStartupWorkingSetPriority(seed, tabsSnapshot.workingSet),
  }

  return {
    closedGhostDismissals: dismissalsResult.value,
    historyRange: historyRangeResult.value,
    localState: localStateResult.state,
    snapshot,
    source: frameSource,
  } satisfies AppStartupFrame
})
