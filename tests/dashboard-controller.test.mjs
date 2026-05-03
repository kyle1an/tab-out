import assert from 'node:assert/strict'
import test from 'node:test'

import { registerDashboardRefresh, requestDashboardRefresh } from '../extension/dashboard-controller.js'

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
