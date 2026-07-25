import assert from 'node:assert/strict'
import test from 'node:test'

import { historyEntrySaveTarget, historyEntrySaved, isHistoryEntrySaveEligible } from '../src/extension/history-saved-page.js'
import type { TabHistoryEntry } from '../src/extension/types'

function makeEntry(overrides: Partial<TabHistoryEntry> & { url: string }): TabHistoryEntry {
  return {
    index: 0, tabId: 1, windowId: 1, exists: true, active: false, activeInOtherWindow: false,
    isApp: false, pinned: false, discarded: false, suspended: false, cursor: false, current: false,
    previousTarget: false, nextTarget: false,
    title: 'Title', rawUrl: overrides.url, displayUrl: overrides.url,
    favIconUrl: '', lastActivatedAt: null, ...overrides
  }
}

test('historyEntrySaveTarget maps entry fields to the save-page target shape', () => {
  const target = historyEntrySaveTarget(makeEntry({
    url: 'https://x.test/p', rawUrl: 'https://x.test/raw', title: 'X', favIconUrl: 'https://x.test/i.png', isApp: false
  }))
  assert.deepEqual(target, {
    url: 'https://x.test/p', rawUrl: 'https://x.test/raw', title: 'X', favIconUrl: 'https://x.test/i.png', isTabOut: false, isApp: false
  })
})

test('isHistoryEntrySaveEligible is false for utility-protocol URLs, true for http(s)', () => {
  assert.equal(isHistoryEntrySaveEligible(makeEntry({ url: 'chrome://extensions' })), false)
  assert.equal(isHistoryEntrySaveEligible(makeEntry({ url: 'https://ok.test/' })), true)
})

test('isHistoryEntrySaveEligible is false for app entries', () => {
  assert.equal(isHistoryEntrySaveEligible(makeEntry({ url: 'https://app.test/', isApp: true })), false)
})

test('historyEntrySaved matches by normalized saved key', () => {
  const saved = new Set(['https://ok.test/'])
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://ok.test/' }), saved), true)
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://nope.test/' }), saved), false)
  assert.equal(historyEntrySaved(makeEntry({ url: 'chrome://x' }), saved), false)
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://ok.test/' }), null), false)
  assert.equal(historyEntrySaved(makeEntry({ url: 'https://ok.test/' }), undefined), false)
})
