import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRetainedPageActions,
  retainedPageActivationDisposition
} from '../src/extension/retained-page-actions.js'
import {
  RETAINED_PAGE_ACTIVATE_MESSAGE,
  RETAINED_PAGES_REMOVE_MESSAGE,
  parseRetainedPageActivateMessage,
  parseRetainedPageActivationResponse,
  parseRetainedPagesRemovalResponse,
  parseRetainedPagesRemoveMessage
} from '../src/extension/runtime-messages.js'

const target = {
  retainedPageIdentity: 'identity-example',
  retainedPageClosureToken: 'lifetime-example'
}

function actionHarness(response: unknown = { ok: true, outcome: 'activated' }) {
  const messages: unknown[] = []
  const notices: string[] = []
  const refreshOptions: unknown[] = []
  let refreshCalls = 0
  let rejectMessage = false
  let rejectRefresh = false

  const actions = createRetainedPageActions({
    sendMessage: async (message) => {
      messages.push(message)
      if (rejectMessage) throw new Error('worker unavailable')
      return response
    },
    refresh: async (options) => {
      refreshCalls += 1
      refreshOptions.push(options)
      if (rejectRefresh) throw new Error('refresh unavailable')
    },
    notify: (title) => {
      notices.push(title)
    }
  })

  return {
    actions,
    messages,
    notices,
    refreshOptions,
    rejectMessage() {
      rejectMessage = true
    },
    rejectRefresh() {
      rejectRefresh = true
    },
    get refreshCalls() {
      return refreshCalls
    }
  }
}

test('retained-page runtime messages require the exact snapshot fields', () => {
  const activation = {
    type: RETAINED_PAGE_ACTIVATE_MESSAGE,
    identityDigest: 'identity-example',
    closureToken: 'lifetime-example',
    disposition: 'background-tab'
  } as const
  const batchRemoval = {
    type: RETAINED_PAGES_REMOVE_MESSAGE,
    snapshots: [
      { identityDigest: 'identity-example', closureToken: 'lifetime-example' },
      { identityDigest: 'identity-second', closureToken: 'lifetime-second' }
    ]
  } as const

  assert.deepEqual(parseRetainedPageActivateMessage(activation), activation)
  assert.deepEqual(parseRetainedPagesRemoveMessage(batchRemoval), batchRemoval)
  assert.equal(parseRetainedPageActivateMessage({ ...activation, closureToken: '' }), null)
  assert.equal(parseRetainedPageActivateMessage({ ...activation, disposition: 'current-tab' }), null)
  assert.equal(parseRetainedPagesRemoveMessage({
    ...batchRemoval,
    snapshots: [{ identityDigest: '', closureToken: 'lifetime-example' }]
  }), null)
  assert.equal(parseRetainedPagesRemoveMessage({
    type: RETAINED_PAGES_REMOVE_MESSAGE,
    snapshots: []
  }), null)
  assert.equal(parseRetainedPagesRemoveMessage({
    type: RETAINED_PAGES_REMOVE_MESSAGE,
    snapshots: Array.from({ length: 501 }, (_, index) => ({
      identityDigest: `identity-${index}`,
      closureToken: `lifetime-${index}`
    }))
  }), null)
})

test('retained-page response parsers accept only known successful outcomes', () => {
  for (const outcome of [
    'activated',
    'activated-newer-retained',
    'activated-unconsumed',
    'stale',
    'failed'
  ] as const) {
    assert.deepEqual(
      parseRetainedPageActivationResponse({ ok: true, outcome }),
      { ok: true, outcome }
    )
  }
  assert.equal(parseRetainedPageActivationResponse({ ok: true, outcome: 'opened' }), null)
  assert.equal(parseRetainedPageActivationResponse({ ok: false, outcome: 'failed' }), null)
  assert.deepEqual(parseRetainedPagesRemovalResponse({
    ok: true,
    outcomes: ['removed', 'already-absent', 'stale']
  }), {
    ok: true,
    outcomes: ['removed', 'already-absent', 'stale']
  })
  assert.equal(parseRetainedPagesRemovalResponse({ ok: true, outcomes: [] }), null)
})

test('retained activation maps every existing Page Chip gesture disposition', () => {
  assert.equal(retainedPageActivationDisposition('focus'), 'focus-tab')
  assert.equal(retainedPageActivationDisposition('open-window'), 'new-window')
  assert.equal(retainedPageActivationDisposition('bring-background'), 'background-tab')
  assert.equal(retainedPageActivationDisposition('bring-foreground'), 'foreground-tab')
})

test('retained activation sends only the exact snapshot and requested disposition', async () => {
  const harness = actionHarness()

  const targetDisappears = await harness.actions.activateRetainedPageTarget(target, 'bring-background')

  assert.deepEqual(harness.messages, [{
    type: RETAINED_PAGE_ACTIVATE_MESSAGE,
    identityDigest: 'identity-example',
    closureToken: 'lifetime-example',
    disposition: 'background-tab'
  }])
  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.refreshOptions, [{ animateCards: true }])
  assert.deepEqual(harness.notices, [])
  assert.equal(targetDisappears, true)
})

test('opening an older retained snapshot keeps a newer snapshot visible without warning', async () => {
  const harness = actionHarness({ ok: true, outcome: 'activated-newer-retained' })

  const targetDisappears = await harness.actions.activateRetainedPageTarget(target, 'focus')

  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.notices, [])
  assert.equal(targetDisappears, false)
})

test('retained activation reports partial success when the page opens but cannot be consumed', async () => {
  const harness = actionHarness({ ok: true, outcome: 'activated-unconsumed' })

  const targetDisappears = await harness.actions.activateRetainedPageTarget(target, 'focus')

  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.notices, ["Page opened, but Tabs couldn't be updated."])
  assert.equal(targetDisappears, false)
})

test('retained activation refreshes and reports stale and failed snapshots truthfully', async () => {
  const stale = actionHarness({ ok: true, outcome: 'stale' })
  await stale.actions.activateRetainedPageTarget(target, 'focus')
  assert.equal(stale.refreshCalls, 1)
  assert.deepEqual(stale.notices, ['This closed page is no longer available.'])

  const failed = actionHarness({ ok: true, outcome: 'failed' })
  await failed.actions.activateRetainedPageTarget(target, 'focus')
  assert.equal(failed.refreshCalls, 1)
  assert.deepEqual(failed.notices, ['Could not open page'])
})

test('retained activation treats a failed refresh after opening as partial success', async () => {
  const harness = actionHarness()
  harness.rejectRefresh()

  await assert.doesNotReject(harness.actions.activateRetainedPageTarget(target, 'focus'))

  assert.deepEqual(harness.notices, ["Page opened, but Tabs couldn't be updated."])
})

test('retained activation never retries an unavailable or malformed worker response', async () => {
  const unavailable = actionHarness()
  unavailable.rejectMessage()
  await assert.doesNotReject(unavailable.actions.activateRetainedPageTarget(target, 'focus'))
  assert.equal(unavailable.messages.length, 1)
  assert.equal(unavailable.refreshCalls, 1)
  assert.deepEqual(unavailable.notices, ['Could not open page'])

  const malformed = actionHarness({ ok: true, outcome: 'unexpected' })
  await malformed.actions.activateRetainedPageTarget(target, 'focus')
  assert.equal(malformed.messages.length, 1)
  assert.equal(malformed.refreshCalls, 1)
  assert.deepEqual(malformed.notices, ['Could not open page'])
})

test('single retained removal sends one exact snapshot through the batch boundary', async () => {
  for (const outcome of ['removed', 'already-absent'] as const) {
    const harness = actionHarness({ ok: true, outcomes: [outcome] })

    const targetDisappears = await harness.actions.removeRetainedPageTarget(target)

    assert.deepEqual(harness.messages, [{
      type: RETAINED_PAGES_REMOVE_MESSAGE,
      snapshots: [{
        identityDigest: 'identity-example',
        closureToken: 'lifetime-example'
      }]
    }])
    assert.equal(harness.refreshCalls, 1)
    assert.deepEqual(harness.notices, ['Removed from Tabs'])
    assert.equal(targetDisappears, true)
  }
})

test('retained removal never retries and uses one failure message for stale or unavailable state', async () => {
  const stale = actionHarness({ ok: true, outcomes: ['stale'] })
  const targetDisappears = await stale.actions.removeRetainedPageTarget(target)
  assert.equal(stale.messages.length, 1)
  assert.equal(stale.refreshCalls, 1)
  assert.deepEqual(stale.notices, ["Couldn’t remove from Tabs"])
  assert.equal(targetDisappears, false)

  const unavailable = actionHarness()
  unavailable.rejectMessage()
  await assert.doesNotReject(unavailable.actions.removeRetainedPageTarget(target))
  assert.equal(unavailable.messages.length, 1)
  assert.equal(unavailable.refreshCalls, 1)
  assert.deepEqual(unavailable.notices, ["Couldn’t remove from Tabs"])
})

test('retained removal preserves a durable success message when dashboard refresh fails', async () => {
  const harness = actionHarness({ ok: true, outcomes: ['removed'] })
  harness.rejectRefresh()

  await assert.doesNotReject(harness.actions.removeRetainedPageTarget(target))

  assert.equal(harness.messages.length, 1)
  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.notices, ['Removed from Tabs'])
})

test('retained batch removal sends exact snapshots once and reports one successful refresh', async () => {
  const harness = actionHarness({
    ok: true,
    outcomes: ['removed', 'already-absent']
  })

  const completedCount = await harness.actions.removeRetainedPageTargets([
    target,
    {
      retainedPageIdentity: 'identity-second',
      retainedPageClosureToken: 'lifetime-second'
    }
  ])

  assert.deepEqual(harness.messages, [{
    type: RETAINED_PAGES_REMOVE_MESSAGE,
    snapshots: [
      { identityDigest: 'identity-example', closureToken: 'lifetime-example' },
      { identityDigest: 'identity-second', closureToken: 'lifetime-second' }
    ]
  }])
  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.refreshOptions, [{ animateCards: true }])
  assert.deepEqual(harness.notices, ['Removed 2 from Tabs'])
  assert.equal(completedCount, 2)
})

test('retained batch removal reports partial stale completion truthfully', async () => {
  const harness = actionHarness({ ok: true, outcomes: ['removed', 'stale'] })

  const completedCount = await harness.actions.removeRetainedPageTargets([
    target,
    {
      retainedPageIdentity: 'identity-newer',
      retainedPageClosureToken: 'lifetime-stale'
    }
  ])

  assert.equal(harness.messages.length, 1)
  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.notices, ['Removed 1 of 2 from Tabs'])
  assert.equal(completedCount, 1)
})

test('retained batch removal rejects malformed targets before sending', async () => {
  const harness = actionHarness({ ok: true, outcomes: ['removed'] })

  const completedCount = await harness.actions.removeRetainedPageTargets([
    target,
    { retainedPageIdentity: 'identity-missing-token' }
  ])

  assert.deepEqual(harness.messages, [])
  assert.equal(harness.refreshCalls, 1)
  assert.deepEqual(harness.notices, ['Couldn’t remove from Tabs'])
  assert.equal(completedCount, 0)
})

test('retained batch removal contains worker and response-shape failures', async () => {
  const unavailable = actionHarness()
  unavailable.rejectMessage()
  await assert.doesNotReject(unavailable.actions.removeRetainedPageTargets([target]))
  assert.equal(unavailable.messages.length, 1)
  assert.equal(unavailable.refreshCalls, 1)
  assert.deepEqual(unavailable.notices, ['Couldn’t remove from Tabs'])

  const incomplete = actionHarness({ ok: true, outcomes: ['removed'] })
  const completedCount = await incomplete.actions.removeRetainedPageTargets([
    target,
    {
      retainedPageIdentity: 'identity-second',
      retainedPageClosureToken: 'lifetime-second'
    }
  ])
  assert.equal(incomplete.messages.length, 1)
  assert.equal(incomplete.refreshCalls, 1)
  assert.deepEqual(incomplete.notices, ['Couldn’t remove from Tabs'])
  assert.equal(completedCount, 0)
})

test('retained removal treats malformed and explicit failure responses as failures', async () => {
  for (const response of [
    { ok: true, outcomes: ['unexpected'] },
    { ok: false }
  ]) {
    const harness = actionHarness(response)

    await harness.actions.removeRetainedPageTarget(target)

    assert.equal(harness.messages.length, 1)
    assert.equal(harness.refreshCalls, 1)
    assert.deepEqual(harness.notices, ["Couldn’t remove from Tabs"])
  }
})

test('worker and refresh failures remain contained by the action boundary', async () => {
  const activation = actionHarness()
  activation.rejectMessage()
  activation.rejectRefresh()
  await assert.doesNotReject(activation.actions.activateRetainedPageTarget(target, 'focus'))
  assert.deepEqual(activation.notices, ['Could not open page'])

  const removal = actionHarness()
  removal.rejectMessage()
  removal.rejectRefresh()
  await assert.doesNotReject(removal.actions.removeRetainedPageTarget(target))
  assert.deepEqual(removal.notices, ["Couldn’t remove from Tabs"])
})

test('missing retained snapshot data refreshes the stale UI without sending a message', async () => {
  const activation = actionHarness()
  await activation.actions.activateRetainedPageTarget({
    retainedPageIdentity: 'identity-example'
  }, 'focus')
  assert.deepEqual(activation.messages, [])
  assert.equal(activation.refreshCalls, 1)
  assert.deepEqual(activation.notices, ['This closed page is no longer available.'])

  const removal = actionHarness()
  await removal.actions.removeRetainedPageTarget({
    retainedPageClosureToken: 'lifetime-example'
  })
  assert.deepEqual(removal.messages, [])
  assert.equal(removal.refreshCalls, 1)
  assert.deepEqual(removal.notices, ["Couldn’t remove from Tabs"])
})
