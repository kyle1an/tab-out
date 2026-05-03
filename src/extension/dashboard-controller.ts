export type RefreshOptions = Record<string, unknown>
type RefreshHandler = (options?: RefreshOptions) => Promise<void> | void

let activeRefresh: RefreshHandler | null = null
let pendingRefresh = false
let pendingRefreshOptions: RefreshOptions | undefined

export function registerDashboardRefresh(fn: RefreshHandler): () => void {
  activeRefresh = fn
  if (pendingRefresh) {
    pendingRefresh = false
    const options = pendingRefreshOptions
    pendingRefreshOptions = undefined
    activeRefresh(options)
  }
  return () => {
    if (activeRefresh === fn) activeRefresh = null
  }
}

export function requestDashboardRefresh(options: RefreshOptions = {}): Promise<void> | void {
  if (activeRefresh) return activeRefresh(options)
  pendingRefresh = true
  pendingRefreshOptions = options
  return Promise.resolve()
}
