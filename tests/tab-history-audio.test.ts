import assert from 'node:assert/strict'
import test from 'node:test'

import type { TabHistoryEntry } from '../src/extension/types.js'
import { normalizeTabHistorySnapshot } from '../src/extension/tab-history.js'

type PartialEntry = Partial<TabHistoryEntry>

test('normalizeTabHistorySnapshot copies audible independently of muted', () => {
  const snap = normalizeTabHistorySnapshot({
    entries: [{ index: 0, tabId: 1, url: 'https://example.com/', audible: true, muted: false } as TabHistoryEntry]
  })
  assert.equal(snap.entries[0].audible, true)
  assert.equal(snap.entries[0].muted, false)
})

test('normalizeTabHistorySnapshot copies muted independently of audible', () => {
  const snap = normalizeTabHistorySnapshot({
    entries: [{ index: 0, tabId: 2, url: 'https://example.com/', audible: false, muted: true } as TabHistoryEntry]
  })
  assert.equal(snap.entries[0].audible, false)
  assert.equal(snap.entries[0].muted, true)
})

test('normalizeTabHistorySnapshot defaults audio flags to false', () => {
  const entry: PartialEntry = { index: 0, tabId: 1, url: 'https://example.com/' }
  const snap = normalizeTabHistorySnapshot({ entries: [entry as TabHistoryEntry] })
  assert.equal(snap.entries[0].audible, false)
  assert.equal(snap.entries[0].muted, false)
})
