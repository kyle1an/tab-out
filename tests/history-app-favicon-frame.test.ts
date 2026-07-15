import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TabHistoryPanel } from '../src/components/TabHistoryPanel.js'
import type { TabHistoryEntry, TabHistorySnapshot } from '../src/extension/types'

function makeEntry(overrides: Partial<TabHistoryEntry> = {}): TabHistoryEntry {
  return {
    index: 0,
    tabId: 101,
    windowId: 1,
    exists: true,
    active: false,
    activeInOtherWindow: false,
    isApp: false,
    pinned: false,
    discarded: false,
    suspended: false,
    cursor: true,
    current: false,
    previousTarget: false,
    nextTarget: false,
    title: 'Example Docs',
    url: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs',
    displayUrl: 'example.com/docs',
    favIconUrl: 'https://example.com/icon.png',
    lastActivatedAt: null,
    ...overrides
  }
}

function renderPanel(entries: TabHistoryEntry[]): string {
  const snapshot: TabHistorySnapshot = {
    stackSize: entries.length,
    maxSize: 40,
    cursorIndex: 0,
    currentIndex: 0,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: 101,
    activeWindowId: 1,
    activeWasInserted: false,
    entries
  }
  return renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<{ snapshot: TabHistorySnapshot }>, { snapshot })
  )
}

test('a standalone app history row frames its favicon like the Apps chip', () => {
  const html = renderPanel([makeEntry({ title: 'Standalone App', url: 'https://app.example.com/', displayUrl: 'app.example.com', isApp: true })])
  assert.match(html, /history-entry-app-favicon/)
  assert.match(html, /border-\[rgba\(115,115,115,0\.32\)\]/)
})

test('a regular history row draws no app frame', () => {
  const html = renderPanel([makeEntry()])
  assert.doesNotMatch(html, /history-entry-app-favicon/)
})

test('a closed app row keeps the frame at full strength while the icon dims', () => {
  const html = renderPanel([makeEntry({ title: 'Standalone App', url: 'https://app.example.com/', displayUrl: 'app.example.com', isApp: true, exists: false, tabId: -1 })])
  assert.match(html, /history-entry-app-favicon/)
  assert.match(html, /chip-favicon-dimmed/)
  const frameClassMatch = html.match(/class="([^"]*\bhistory-entry-app-favicon\b[^"]*)"/)
  assert.ok(frameClassMatch)
  assert.doesNotMatch(frameClassMatch[1], /chip-favicon-dimmed/)
})
