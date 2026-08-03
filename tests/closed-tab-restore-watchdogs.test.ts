import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'
import { ManagedRuntime } from 'effect'

import { ClosedTabRestoreWatchdogs } from '../src/extension/closed-tab-restore-watchdogs.js'

test('closed-tab restore watchdogs replace by id and stop with the app runtime', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const runtime = ManagedRuntime.make(ClosedTabRestoreWatchdogs.layer)
  const calls: string[] = []
  let disposed = false

  try {
    const watchdogs = runtime.runSync(ClosedTabRestoreWatchdogs)
    runtime.runSync(watchdogs.schedule('restore-alpha', 100, () => calls.push('overtaken')))
    runtime.runSync(watchdogs.schedule('restore-alpha', 100, () => calls.push('latest')))

    assert.equal(clock.countTimers(), 1)
    await clock.tickAsync(100)
    assert.deepEqual(calls, ['latest'])

    runtime.runSync(watchdogs.schedule('restore-beta', 100, () => calls.push('disposed')))
    await runtime.dispose()
    disposed = true
    assert.equal(clock.countTimers(), 0)

    await clock.tickAsync(100)
    assert.deepEqual(calls, ['latest'])
  } finally {
    if (!disposed) await runtime.dispose()
    clock.uninstall()
  }
})
