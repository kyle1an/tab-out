import assert from 'node:assert/strict'
import test from 'node:test'
import FakeTimers from '@sinonjs/fake-timers'

import {
  createDashboardPageRefreshScheduler,
  dashboardTabUpdateRefreshOptions
} from '../src/extension/dashboard-page-refresh.js'

test('Tab Out and native new-tab items refresh for every material tab update', () => {
  const runtimeId = 'tab-out-runtime'
  const dashboardUrl = `chrome-extension://${runtimeId}/index.html`

  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { status: 'complete' },
    { url: dashboardUrl },
    runtimeId
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { status: 'loading' },
    { pendingUrl: dashboardUrl, url: 'chrome://newtab/' },
    runtimeId
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { title: 'New Tab' },
    { url: 'chrome://newtab/' },
    runtimeId
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { favIconUrl: `chrome-extension://${runtimeId}/icons/icon16.png` },
    { url: 'chrome://newtab/' },
    runtimeId
  ), { animateCards: false })
  for (const changeInfo of [
    { audible: true },
    { mutedInfo: { muted: true } }
  ]) {
    assert.deepEqual(dashboardTabUpdateRefreshOptions(
      changeInfo,
      { url: dashboardUrl },
      runtimeId
    ), { animateCards: false })
  }
  for (const changeInfo of [
    { groupId: 7 },
    { pinned: true },
    { discarded: true }
  ]) {
    assert.deepEqual(dashboardTabUpdateRefreshOptions(
      changeInfo,
      { url: dashboardUrl },
      runtimeId
    ), { animateCards: true })
  }
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { url: dashboardUrl },
    { url: dashboardUrl },
    runtimeId
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { title: 'Example Article' },
    { url: 'https://example.test/article' },
    runtimeId
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { url: 'https://example.test/next' },
    { url: 'https://example.test/next' },
    runtimeId
  ), { animateCards: true })
  assert.equal(dashboardTabUpdateRefreshOptions(
    {},
    { url: dashboardUrl },
    runtimeId
  ), null)
})

test('hidden dashboard event bursts do no refresh work and catch up once when visible', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  let visible = false
  const refreshes: Array<{ animateCards?: boolean }> = []

  try {
    const scheduler = createDashboardPageRefreshScheduler({
      isVisible: () => visible,
      refresh: (options) => { refreshes.push(options) }
    })

    scheduler.schedule()
    scheduler.schedule({ animateCards: true })
    scheduler.schedule()
    assert.equal(clock.countTimers(), 0)

    await clock.tickAsync(10_000)
    assert.deepEqual(refreshes, [])

    visible = true
    scheduler.visibilityChanged()
    assert.deepEqual(refreshes, [{ animateCards: true }])

    await clock.tickAsync(10_000)
    assert.equal(refreshes.length, 1)
  } finally {
    clock.uninstall()
  }
})

test('a scheduled visible refresh becomes one pending catch-up if the page hides', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  let visible = true
  const refreshes: Array<{ animateCards?: boolean }> = []

  try {
    const scheduler = createDashboardPageRefreshScheduler({
      isVisible: () => visible,
      refresh: (options) => { refreshes.push(options) }
    })

    scheduler.schedule({ animateCards: true })
    visible = false
    scheduler.visibilityChanged()
    await clock.tickAsync(1000)
    assert.deepEqual(refreshes, [])

    visible = true
    scheduler.visibilityChanged()
    assert.deepEqual(refreshes, [{ animateCards: true }])
  } finally {
    clock.uninstall()
  }
})
