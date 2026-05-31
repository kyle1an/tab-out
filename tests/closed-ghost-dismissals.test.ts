import assert from 'node:assert/strict'
import test from 'node:test'

import {
  closedGhostDismissalKey,
  isClosedGhostDismissed,
  normalizeClosedGhostDismissals
} from '../src/extension/closed-ghost-dismissals.js'

test('closedGhostDismissalKey is stable for the same effective page', () => {
  const a = closedGhostDismissalKey({ url: 'https://example.com/article' })
  const b = closedGhostDismissalKey({ url: 'https://example.com/article' })
  assert.equal(a, b)
  assert.ok(a.length > 0)
})

test('isClosedGhostDismissed hides entries dismissed at or after their close time', () => {
  const entry = { url: 'https://example.com/a', lastClosedAt: 1000 }
  const key = closedGhostDismissalKey(entry)
  assert.equal(isClosedGhostDismissed(new Map([[key, 1000]]), entry), true)
  assert.equal(isClosedGhostDismissed(new Map([[key, 1500]]), entry), true)
})

test('isClosedGhostDismissed shows entries re-closed after the dismissal', () => {
  const entry = { url: 'https://example.com/a', lastClosedAt: 2000 }
  const key = closedGhostDismissalKey(entry)
  assert.equal(isClosedGhostDismissed(new Map([[key, 1000]]), entry), false)
})

test('isClosedGhostDismissed tolerates empty or missing dismissals', () => {
  const entry = { url: 'https://example.com/a', lastClosedAt: 1000 }
  assert.equal(isClosedGhostDismissed(null, entry), false)
  assert.equal(isClosedGhostDismissed(undefined, entry), false)
  assert.equal(isClosedGhostDismissed(new Map(), entry), false)
})

test('normalizeClosedGhostDismissals drops invalid and expired records', () => {
  const now = 1_700_000_000_000
  const normalized = normalizeClosedGhostDismissals(
    {
      keep: now - 1000,
      expired: now - 8 * 24 * 60 * 60 * 1000,
      bad: 'nope'
    },
    now
  )

  assert.equal(normalized.get('keep'), now - 1000)
  assert.equal(normalized.has('expired'), false)
  assert.equal(normalized.has('bad'), false)
})
