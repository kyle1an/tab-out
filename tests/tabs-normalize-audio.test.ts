import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeChromeOpenTabs } from '../src/extension/tabs.js'

function snapshot(tab: Record<string, unknown>) {
  return { tabs: [{ id: 1, url: 'https://example.com/', windowId: 1, ...tab }] as any, windows: [{ id: 1, type: 'normal' }] as any }
}

test('normalizeChromeOpenTabs copies audible independently of muted', () => {
  const [tab] = normalizeChromeOpenTabs(snapshot({ audible: true, mutedInfo: { muted: false } }))
  assert.ok(tab)
  assert.equal(tab.audible, true)
  assert.equal(tab.muted, false)
})

test('normalizeChromeOpenTabs copies muted independently of audible', () => {
  const [tab] = normalizeChromeOpenTabs(snapshot({ audible: false, mutedInfo: { muted: true } }))
  assert.ok(tab)
  assert.equal(tab.audible, false)
  assert.equal(tab.muted, true)
})

test('normalizeChromeOpenTabs defaults audio flags to false', () => {
  const [tab] = normalizeChromeOpenTabs(snapshot({}))
  assert.ok(tab)
  assert.equal(tab.audible, false)
  assert.equal(tab.muted, false)
})
