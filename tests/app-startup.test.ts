import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyAppStartup,
  readAppStartup,
  readBuildTimeAppStartup,
  subscribeAppStartup
} from '../src/app-startup.js'
import { emptyDashboardLocalState } from '../src/extension/dashboard-local-state.js'

test('app startup publishes snapshot, local state, and history range through one update', () => {
  let notifications = 0
  const unsubscribe = subscribeAppStartup(() => { notifications += 1 })
  const startup = {
    historyRange: 'off',
    localState: emptyDashboardLocalState(true),
    snapshot: null
  }

  applyAppStartup(startup)
  unsubscribe()

  assert.equal(notifications, 1)
  assert.equal(readAppStartup(), startup)
  assert.equal(readBuildTimeAppStartup(), null)
})
