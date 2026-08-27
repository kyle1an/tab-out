import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import type { ChromeApi } from '../../src/extension/background/chrome-api.js'
import { handoffDesktopWindowMergeToWindowEffect } from '../../src/extension/background/desktop-window-merge-handoff.js'

const DASHBOARD_URL = 'chrome-extension://tab-out/index.html'
const START_CONFIRM_MESSAGE = { type: 'tab-out:start-desktop-window-merge-confirm', previewId: 'preview-test' }

type HandoffApiCalls = {
  tabCreate: chrome.tabs.CreateProperties[]
  tabUpdate: Array<{ tabId: number, updateProperties: chrome.tabs.UpdateProperties }>
  sentMessages: Array<{ tabId: number, message: unknown }>
}

function createHandoffApi(options: {
  tabs?: chrome.tabs.Tab[]
  createdTabId?: number
  failWindowedCreate?: boolean
  acknowledgeFromAttempt?: number
}) {
  const {
    tabs = [],
    createdTabId = 90,
    failWindowedCreate = false,
    acknowledgeFromAttempt = 1,
  } = options
  const calls: HandoffApiCalls = {
    tabCreate: [],
    tabUpdate: [],
    sentMessages: [],
  }
  const chromeApi = {
    runtime: { id: 'tab-out' },
    tabs: {
      query: async () => tabs,
      update: async (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => {
        calls.tabUpdate.push({ tabId, updateProperties })
        return { id: tabId } as chrome.tabs.Tab
      },
      create: async (createProperties: chrome.tabs.CreateProperties) => {
        if (failWindowedCreate && createProperties.windowId !== undefined) {
          throw new Error('window closed before tab creation')
        }
        calls.tabCreate.push(createProperties)
        return { id: createdTabId, windowId: createProperties.windowId ?? 2 } as chrome.tabs.Tab
      },
      sendMessage: async (tabId: number, message: unknown) => {
        calls.sentMessages.push({ tabId, message })
        if (calls.sentMessages.length < acknowledgeFromAttempt) {
          throw new Error('Receiving end does not exist')
        }
        return { ok: true }
      },
    },
  } as unknown as ChromeApi

  return { calls, chromeApi }
}

function dashboardTab(overrides: Partial<chrome.tabs.Tab>): chrome.tabs.Tab {
  return {
    id: 1,
    windowId: 7,
    url: DASHBOARD_URL,
    active: false,
    pinned: false,
    ...overrides,
  } as chrome.tabs.Tab
}

it.effect('handoff focuses the active dashboard tab and delivers the start-confirm intent', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 11, pinned: true }),
      dashboardTab({ id: 12, active: true }),
      { id: 13, windowId: 7, url: 'https://example.test/', active: false, pinned: false } as chrome.tabs.Tab,
    ],
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabUpdate, [{ tabId: 12, updateProperties: { active: true } }])
  assert.deepEqual(calls.tabCreate, [])
  assert.deepEqual(calls.sentMessages, [{ tabId: 12, message: START_CONFIRM_MESSAGE }])
}))

it.effect('handoff prefers a pinned dashboard tab when none is active', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      dashboardTab({ id: 21 }),
      dashboardTab({ id: 22, pinned: true, url: 'chrome://newtab/' }),
    ],
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabUpdate, [{ tabId: 22, updateProperties: { active: true } }])
}))

it.effect('handoff creates a dashboard tab and retries delivery until the page listener hydrates', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    tabs: [
      { id: 31, windowId: 7, url: 'https://example.test/', active: true, pinned: false } as chrome.tabs.Tab,
    ],
    createdTabId: 32,
    acknowledgeFromAttempt: 3,
  })

  const fiber = yield* Effect.forkChild(
    handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test', { retryDelayMillis: 250 }),
  )
  yield* TestClock.adjust(500)
  const delivered = yield* Fiber.join(fiber)

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabCreate, [{ windowId: 7, url: DASHBOARD_URL, active: true }])
  assert.deepEqual(calls.tabUpdate, [])
  assert.equal(calls.sentMessages.length, 3)
  assert.ok(calls.sentMessages.every((sent) => sent.tabId === 32))
}))

it.effect('handoff falls back to a windowless create when the invoking window is gone', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    failWindowedCreate: true,
    createdTabId: 41,
  })

  const delivered = yield* handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test')

  assert.equal(delivered, true)
  assert.deepEqual(calls.tabCreate, [{ url: DASHBOARD_URL, active: true }])
  assert.deepEqual(calls.sentMessages, [{ tabId: 41, message: START_CONFIRM_MESSAGE }])
}))

it.effect('handoff reports failure after the bounded delivery window closes', () => Effect.gen(function* () {
  const { calls, chromeApi } = createHandoffApi({
    createdTabId: 51,
    acknowledgeFromAttempt: Number.POSITIVE_INFINITY,
  })

  const fiber = yield* Effect.forkChild(handoffDesktopWindowMergeToWindowEffect(chromeApi, 7, 'preview-test', {
    deliveryAttempts: 3,
    retryDelayMillis: 250,
  }))
  yield* TestClock.adjust(1_000)
  const delivered = yield* Fiber.join(fiber)

  assert.equal(delivered, false)
  assert.equal(calls.sentMessages.length, 3)
}))
