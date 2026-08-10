import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { dashboardViewFromSearch, urlForDashboardView } from '../extension/app-url.js'
import { DEFAULT_DASHBOARD_VIEW, dashboardSourceForView, dashboardViewOptionId, type DashboardView } from '../extension/dashboard-view.js'
import type { DashboardSource } from '../extension/types'

function syncDashboardViewToUrl(view: DashboardView) {
  const nextUrl = urlForDashboardView(view, window.location)
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
}

export function useDashboardViewRouting({
  source,
  sourceSelection,
}: {
  source: DashboardSource
  sourceSelection: DashboardSource
}) {
  const [dashboardViewSelection, setDashboardViewSelectionState] = useState(DEFAULT_DASHBOARD_VIEW)
  const [appliedDashboardView, setAppliedDashboardView] = useState(DEFAULT_DASHBOARD_VIEW)
  const [dashboardViewRoutingReady, setDashboardViewRoutingReady] = useState(false)
  const dashboardViewSelectionRef = useRef<DashboardView>(DEFAULT_DASHBOARD_VIEW)

  useLayoutEffect(() => {
    const nextView = dashboardViewFromSearch(window.location.search)
    dashboardViewSelectionRef.current = nextView
    setDashboardViewSelectionState(nextView)
    syncDashboardViewToUrl(nextView)
    setDashboardViewRoutingReady(true)
  }, [])

  const setDashboardViewSelection = useCallback(function setDashboardViewSelection(nextView: DashboardView) {
    if (nextView === dashboardViewSelectionRef.current) return
    dashboardViewSelectionRef.current = nextView
    setDashboardViewSelectionState(nextView)
    syncDashboardViewToUrl(nextView)
    if (dashboardSourceForView(nextView) === source) setAppliedDashboardView(nextView)
  }, [source])

  useLayoutEffect(() => {
    if (
      !dashboardViewRoutingReady ||
      source !== sourceSelection ||
      dashboardSourceForView(dashboardViewSelection) !== source
    ) return
    document.documentElement.removeAttribute('data-tabout-startup-view')
  }, [dashboardViewRoutingReady, dashboardViewSelection, source, sourceSelection])

  useLayoutEffect(() => {
    if (source !== sourceSelection) return
    if (dashboardSourceForView(dashboardViewSelection) === source) {
      if (dashboardViewSelection === appliedDashboardView) return
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- Dashboard Intake is an external transactional store; only its settled source snapshot can confirm that an async Dashboard View selection became the applied view.
      setAppliedDashboardView(dashboardViewSelection)
      return
    }
    const restoreAppliedViewFocus = document.activeElement?.id === dashboardViewOptionId(dashboardViewSelection)
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- Dashboard Intake is an external transactional store; a failed async source request must reconcile its optimistic URL/control selection to the last applied Dashboard View.
    setDashboardViewSelection(appliedDashboardView)
    if (restoreAppliedViewFocus) {
      document.getElementById(dashboardViewOptionId(appliedDashboardView))?.focus()
    }
  }, [appliedDashboardView, dashboardViewSelection, setDashboardViewSelection, source, sourceSelection])

  const visibleDashboardView = source === sourceSelection && dashboardSourceForView(dashboardViewSelection) === source
    ? dashboardViewSelection
    : appliedDashboardView

  return { dashboardViewRoutingReady, dashboardViewSelection, setDashboardViewSelection, visibleDashboardView }
}
