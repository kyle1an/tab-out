import assert from 'node:assert/strict'
import test from 'node:test'

import {
  mergeDashboardRefreshOptions,
  replaceDashboardRefreshForTesting,
  requestDashboardRefresh,
  settleDashboardRefresh
} from '../src/extension/dashboard-intake.js'
import type { DashboardRefreshOptions } from '../src/extension/dashboard-intake.js'

test('dashboard refresh options expose only supported coordination flags', () => {
  const options = {
    animateCards: true,
    startupSnapshot: true
  } satisfies DashboardRefreshOptions

  assert.deepEqual(options, { animateCards: true, startupSnapshot: true })

  // @ts-expect-error Unknown refresh flags must not silently cross the intake seam.
  void ({ unexpectedFlag: true } satisfies DashboardRefreshOptions)
})

test('requestDashboardRefresh forwards refresh options to the intake refresh target', async () => {
  let receivedOptions = null
  const unregister = replaceDashboardRefreshForTesting((options) => {
    receivedOptions = options
  })

  await requestDashboardRefresh({ animateCards: true })
  unregister()

  assert.deepEqual(receivedOptions, { animateCards: true })
})

test('merged dashboard refreshes preserve stronger coordination flags', () => {
  const options = mergeDashboardRefreshOptions(
    { animateCards: true },
    { startupSnapshot: true }
  )

  assert.deepEqual(options, { animateCards: true, startupSnapshot: true })
})

test('automatic dashboard refresh settlement absorbs a rejected handler', async () => {
  await assert.doesNotReject(settleDashboardRefresh(Promise.reject(new Error('refresh failed'))))
})
