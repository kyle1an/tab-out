import assert from 'node:assert/strict'
import test from 'node:test'

import { makeHistoryEntry, normalizeTabHistorySnapshot } from '../src/extension/tab-history.js'

const SUSPENDER_RAW = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/suspended.html#ttl=T&uri=https://real.example/page'

function coreFields(overrides: Partial<Parameters<typeof makeHistoryEntry>[0]> = {}) {
  return {
    tabId: 5,
    windowId: 2,
    title: 'Example Page',
    url: 'https://real.example/page',
    rawUrl: 'https://real.example/page',
    displayUrl: 'real.example/page',
    favIconUrl: '',
    ...overrides
  }
}

test('makeHistoryEntry: fills synthesized-row defaults', () => {
  const entry = makeHistoryEntry(coreFields())
  assert.equal(entry.index, -1)
  assert.equal(entry.exists, false)
  assert.equal(entry.active, false)
  assert.equal(entry.cursor, false)
  assert.equal(entry.current, false)
  assert.equal(entry.previousTarget, false)
  assert.equal(entry.nextTarget, false)
  assert.equal(entry.suspended, false)
  assert.equal(entry.lastActivatedAt, null)
})

test('makeHistoryEntry: derives suspended from the url pair unless overridden', () => {
  const derived = makeHistoryEntry(coreFields({ rawUrl: SUSPENDER_RAW }))
  assert.equal(derived.suspended, true)
  const overridden = makeHistoryEntry(coreFields({ rawUrl: SUSPENDER_RAW, suspended: false }))
  assert.equal(overridden.suspended, false)
})

test('makeHistoryEntry: explicit fields win over defaults', () => {
  const entry = makeHistoryEntry(coreFields({ exists: true, current: true, lastActivatedAt: 1234 }))
  assert.equal(entry.exists, true)
  assert.equal(entry.current, true)
  assert.equal(entry.lastActivatedAt, 1234)
})

test('normalizeTabHistorySnapshot: live rows keep Chrome tab favIconUrl', () => {
  const snapshot = normalizeTabHistorySnapshot({
    entries: [
      makeHistoryEntry(coreFields({
        favIconUrl: 'https://site.example/icon.png'
      }))
    ]
  })

  assert.equal(snapshot.entries[0]?.favIconUrl, 'https://site.example/icon.png')
})
