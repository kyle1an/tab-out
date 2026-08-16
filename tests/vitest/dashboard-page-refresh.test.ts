import assert from 'node:assert/strict'
import { afterEach, it, vi } from '@effect/vitest'

import {
  createDashboardPageRefreshScheduler,
  dashboardTabUpdateRefreshOptions,
} from '../../src/extension/dashboard-page-refresh.js'

afterEach(() => vi.useRealTimers())

it('Tab Out and native new-tab items refresh for every material tab update', () => {
  const runtimeId = 'tab-out-runtime'
  const dashboardUrl = `chrome-extension://${runtimeId}/index.html`

  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { status: 'complete' },
    { url: dashboardUrl },
    runtimeId,
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { status: 'loading' },
    { pendingUrl: dashboardUrl, url: 'chrome://newtab/' },
    runtimeId,
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { title: 'New Tab' },
    { url: 'chrome://newtab/' },
    runtimeId,
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { favIconUrl: `chrome-extension://${runtimeId}/icons/icon16.png` },
    { url: 'chrome://newtab/' },
    runtimeId,
  ), { animateCards: false })
  for (const changeInfo of [
    { audible: true },
    { mutedInfo: { muted: true } },
  ]) {
    assert.deepEqual(dashboardTabUpdateRefreshOptions(
      changeInfo,
      { url: dashboardUrl },
      runtimeId,
    ), { animateCards: false })
  }
  for (const changeInfo of [
    { groupId: 7 },
    { pinned: true },
    { discarded: true },
  ]) {
    assert.deepEqual(dashboardTabUpdateRefreshOptions(
      changeInfo,
      { url: dashboardUrl },
      runtimeId,
    ), { animateCards: true })
  }
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { url: dashboardUrl },
    { url: dashboardUrl },
    runtimeId,
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { title: 'Example Article' },
    { url: 'https://example.test/article' },
    runtimeId,
  ), { animateCards: false })
  assert.deepEqual(dashboardTabUpdateRefreshOptions(
    { url: 'https://example.test/next' },
    { url: 'https://example.test/next' },
    runtimeId,
  ), { animateCards: true })
  assert.equal(dashboardTabUpdateRefreshOptions(
    {},
    { url: dashboardUrl },
    runtimeId,
  ), null)
})

it('hidden dashboard event bursts do no refresh work and catch up once when visible', async () => {
  vi.useFakeTimers()
  let visible = false
  const refreshes: Array<{ animateCards?: boolean }> = []

  const scheduler = createDashboardPageRefreshScheduler({
    isVisible: () => visible,
    refresh: (options) => { refreshes.push(options) },
  })

  scheduler.schedule()
  scheduler.schedule({ animateCards: true })
  scheduler.schedule()
  assert.equal(vi.getTimerCount(), 0)

  await vi.advanceTimersByTimeAsync(10_000)
  assert.deepEqual(refreshes, [])

  visible = true
  scheduler.visibilityChanged()
  assert.deepEqual(refreshes, [{ animateCards: true }])

  await vi.advanceTimersByTimeAsync(10_000)
  assert.equal(refreshes.length, 1)
})

it('a scheduled visible refresh becomes one pending catch-up if the page hides', async () => {
  vi.useFakeTimers()
  let visible = true
  const refreshes: Array<{ animateCards?: boolean }> = []

  const scheduler = createDashboardPageRefreshScheduler({
    isVisible: () => visible,
    refresh: (options) => { refreshes.push(options) },
  })

  scheduler.schedule({ animateCards: true })
  visible = false
  scheduler.visibilityChanged()
  await vi.advanceTimersByTimeAsync(1000)
  assert.deepEqual(refreshes, [])

  visible = true
  scheduler.visibilityChanged()
  assert.deepEqual(refreshes, [{ animateCards: true }])
})
