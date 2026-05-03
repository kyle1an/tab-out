let activeRefresh = null
let pendingRefresh = false
let pendingRefreshOptions = null

export function registerDashboardRefresh(fn) {
  activeRefresh = fn
  if (pendingRefresh) {
    pendingRefresh = false
    const options = pendingRefreshOptions
    pendingRefreshOptions = null
    activeRefresh(options)
  }
  return () => {
    if (activeRefresh === fn) activeRefresh = null
  }
}

export function requestDashboardRefresh(options = {}) {
  if (activeRefresh) return activeRefresh(options)
  pendingRefresh = true
  pendingRefreshOptions = options
  return Promise.resolve()
}
