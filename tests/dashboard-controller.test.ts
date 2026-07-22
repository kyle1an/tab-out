import assert from 'node:assert/strict'
import test from 'node:test'

import { registerDashboardRefresh, requestDashboardRefresh, settleDashboardRefresh } from '../src/extension/dashboard-controller.js'
import type { DashboardRefreshOptions } from '../src/extension/dashboard-controller.js'

test('dashboard refresh options expose only supported coordination flags', () => {
  const options = {
    animateCards: true,
    startupSnapshot: true
  } satisfies DashboardRefreshOptions

  assert.deepEqual(options, { animateCards: true, startupSnapshot: true })

  // @ts-expect-error Unknown refresh flags must not silently cross the controller seam.
  void ({ unexpectedFlag: true } satisfies DashboardRefreshOptions)
})

test('requestDashboardRefresh forwards refresh options to the active handler', async () => {
  let receivedOptions = null
  const unregister = registerDashboardRefresh((options) => {
    receivedOptions = options
  })

  await requestDashboardRefresh({ animateCards: true })
  unregister()

  assert.deepEqual(receivedOptions, { animateCards: true })
})

test('requestDashboardRefresh preserves options queued before registration', async () => {
  let receivedOptions = null

  await requestDashboardRefresh({ animateCards: true })
  const unregister = registerDashboardRefresh((options) => {
    receivedOptions = options
  })
  unregister()

  assert.deepEqual(receivedOptions, { animateCards: true })
})

test('queued dashboard refreshes preserve stronger coordination flags', async () => {
  let receivedOptions = null

  await requestDashboardRefresh({ animateCards: true })
  await requestDashboardRefresh({ startupSnapshot: true })
  await requestDashboardRefresh()
  const unregister = registerDashboardRefresh((options) => {
    receivedOptions = options
  })
  unregister()

  assert.deepEqual(receivedOptions, { animateCards: true, startupSnapshot: true })
})

test('automatic dashboard refresh settlement absorbs a rejected handler', async () => {
  await assert.doesNotReject(settleDashboardRefresh(Promise.reject(new Error('refresh failed'))))
})
