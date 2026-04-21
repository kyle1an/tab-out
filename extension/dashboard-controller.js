let activeRefresh = null
let pendingRefresh = false

export function registerDashboardRefresh(fn) {
  activeRefresh = fn
  if (pendingRefresh) {
    pendingRefresh = false
    activeRefresh()
  }
  return () => {
    if (activeRefresh === fn) activeRefresh = null
  }
}

export function requestDashboardRefresh() {
  if (activeRefresh) return activeRefresh()
  pendingRefresh = true
  return Promise.resolve()
}
