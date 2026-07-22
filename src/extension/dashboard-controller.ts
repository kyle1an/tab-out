export type DashboardRefreshOptions = {
  animateCards?: boolean
  startupSnapshot?: boolean
}

type RefreshHandler = (options?: DashboardRefreshOptions) => Promise<void> | void

let activeRefresh: RefreshHandler | null = null
let pendingRefresh = false
let pendingRefreshOptions: DashboardRefreshOptions | undefined

function mergeRefreshOptions(
  current: DashboardRefreshOptions | undefined,
  next: DashboardRefreshOptions
): DashboardRefreshOptions {
  return {
    ...current,
    ...next,
    ...((current?.animateCards || next.animateCards) ? { animateCards: true } : {}),
    ...((current?.startupSnapshot || next.startupSnapshot) ? { startupSnapshot: true } : {})
  }
}

/** Settle automatic/event-driven refreshes without creating an unhandled rejection. */
export async function settleDashboardRefresh(refresh: Promise<void> | void): Promise<void> {
  try {
    await refresh
  } catch {}
}

export function registerDashboardRefresh(fn: RefreshHandler): () => void {
  activeRefresh = fn
  if (pendingRefresh) {
    pendingRefresh = false
    const options = pendingRefreshOptions
    pendingRefreshOptions = undefined
    void settleDashboardRefresh(activeRefresh(options))
  }
  return () => {
    if (activeRefresh === fn) activeRefresh = null
  }
}

export function requestDashboardRefresh(options: DashboardRefreshOptions = {}): Promise<void> | void {
  if (activeRefresh) return activeRefresh(options)
  pendingRefresh = true
  pendingRefreshOptions = mergeRefreshOptions(pendingRefreshOptions, options)
  return Promise.resolve()
}
