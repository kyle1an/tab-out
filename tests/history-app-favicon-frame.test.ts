import assert from 'node:assert/strict'
import test from 'node:test'

import { makeHistoryEntry, renderHistoryPanel } from './helpers/history-panel.js'

test('a standalone app history row frames its favicon like the Apps chip', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ title: 'Standalone App', url: 'https://app.example.com/', displayUrl: 'app.example.com', isApp: true })])
  assert.match(html, /history-entry-app-favicon/)
  assert.match(html, /border-\[rgba\(115,115,115,0\.32\)\]/)
})

test('a regular history row draws no app frame', () => {
  const html = renderHistoryPanel([makeHistoryEntry()])
  assert.doesNotMatch(html, /history-entry-app-favicon/)
})

test('a closed app row keeps the frame at full strength while the icon dims', () => {
  const html = renderHistoryPanel([makeHistoryEntry({ title: 'Standalone App', url: 'https://app.example.com/', displayUrl: 'app.example.com', isApp: true, exists: false, tabId: -1 })])
  assert.match(html, /history-entry-app-favicon/)
  assert.match(html, /chip-favicon-dimmed/)
  const frameClassMatch = html.match(/class="([^"]*\bhistory-entry-app-favicon\b[^"]*)"/)
  assert.ok(frameClassMatch)
  const frameClasses = frameClassMatch[1]
  assert.ok(frameClasses)
  assert.doesNotMatch(frameClasses, /chip-favicon-dimmed/)
})
