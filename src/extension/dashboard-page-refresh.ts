import type { DashboardRefreshOptions } from './dashboard-controller.js'

const DASHBOARD_PAGE_REFRESH_DELAY_MS = 250

type DashboardPageRefreshSchedulerDeps = {
  isVisible: () => boolean
  refresh: (options: DashboardRefreshOptions) => void
}

export type DashboardPageRefreshScheduler = {
  schedule: (options?: DashboardRefreshOptions) => void
  visibilityChanged: () => void
}

function mergeRefreshOptions(
  current: DashboardRefreshOptions,
  next: DashboardRefreshOptions
): DashboardRefreshOptions {
  return {
    ...((current.animateCards || next.animateCards) ? { animateCards: true } : {}),
    ...((current.startupSnapshot || next.startupSnapshot) ? { startupSnapshot: true } : {})
  }
}

export function createDashboardPageRefreshScheduler(
  deps: DashboardPageRefreshSchedulerDeps
): DashboardPageRefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let scheduledOptions: DashboardRefreshOptions = {}
  let hiddenRefreshPending = false
  let hiddenOptions: DashboardRefreshOptions = {}

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function deferWhileHidden(options: DashboardRefreshOptions): void {
    hiddenRefreshPending = true
    hiddenOptions = mergeRefreshOptions(hiddenOptions, options)
  }

  function moveScheduledRefreshToHidden(): void {
    if (timer === null) return
    clearTimer()
    deferWhileHidden(scheduledOptions)
    scheduledOptions = {}
  }

  function takePendingOptions(): DashboardRefreshOptions {
    const options = mergeRefreshOptions(hiddenOptions, scheduledOptions)
    hiddenRefreshPending = false
    hiddenOptions = {}
    scheduledOptions = {}
    return options
  }

  function schedule(options: DashboardRefreshOptions = {}): void {
    if (!deps.isVisible()) {
      moveScheduledRefreshToHidden()
      deferWhileHidden(options)
      return
    }
    scheduledOptions = mergeRefreshOptions(scheduledOptions, options)
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      if (!deps.isVisible()) {
        deferWhileHidden(scheduledOptions)
        scheduledOptions = {}
        return
      }
      deps.refresh(takePendingOptions())
    }, DASHBOARD_PAGE_REFRESH_DELAY_MS)
  }

  function visibilityChanged(): void {
    if (!deps.isVisible()) {
      moveScheduledRefreshToHidden()
      return
    }
    const hadScheduledRefresh = timer !== null
    clearTimer()
    const hadPendingRefresh = hadScheduledRefresh || hiddenRefreshPending
    const options = takePendingOptions()
    // Keep the existing visibility contract: becoming visible always verifies live browser
    // state, even if Chrome did not deliver an event while this page was hidden.
    deps.refresh(hadPendingRefresh ? options : {})
  }

  return { schedule, visibilityChanged }
}
