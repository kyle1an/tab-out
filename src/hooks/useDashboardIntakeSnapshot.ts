import { startTransition, useLayoutEffect, useState } from 'react'
import { appDashboardStore, type AppDashboardState } from '../extension/dashboard-intake.js'

/**
 * Page-side render mirror for Dashboard Intake. The store remains the owner
 * of every arrival, while large source snapshots regain the interruptible
 * commit that the pre-store reducer received from React transitions.
 */
export function useDashboardIntakeSnapshot(): AppDashboardState {
  const [snapshot, setSnapshot] = useState(appDashboardStore.readBuildTime)

  useLayoutEffect(() => {
    let transitioningSourceRequestId: number | null = null
    const unsubscribeBeforeApply = appDashboardStore.subscribeBeforeApply((event) => {
      if (event.reason === 'source-switch') {
        transitioningSourceRequestId = event.requestId
      }
    })
    const applySnapshot = () => {
      const nextSnapshot = appDashboardStore.read()
      if (nextSnapshot.sourceAppliedRequestId === transitioningSourceRequestId) {
        transitioningSourceRequestId = null
        startTransition(() => setSnapshot(nextSnapshot))
        return
      }
      setSnapshot(nextSnapshot)
    }
    const unsubscribe = appDashboardStore.subscribe(applySnapshot)
    applySnapshot()
    return () => {
      unsubscribe()
      unsubscribeBeforeApply()
    }
  }, [])

  return snapshot
}
