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

function titleSpanClass(html: string): string {
  const match = html.match(/class="(history-entry-title [^"]*)"/)
  assert.ok(match, 'history entry title should render')
  return match[1]
}

test('a closed history row mutes its title like a closed saved page chip', () => {
  const html = renderPanel([makeEntry({ exists: false, tabId: -1 })])
  assert.match(html, /history-entry-closed/)
  assert.match(titleSpanClass(html), /\btext-tab-muted\b/)
  assert.doesNotMatch(titleSpanClass(html), /\btext-tab-ink\b/)
})

test('a closed history row hovers with the closed-saved chip treatment', () => {
  const html = renderPanel([makeEntry({ exists: false, tabId: -1 })])
  const rowMatch = html.match(/class="([^"]*\bhistory-entry-closed\b[^"]*)"/)
  assert.ok(rowMatch)
  assert.match(rowMatch[1], /group-hover\/history-row:outline\b/)
})

test('a live history row keeps ink title and no closed treatment', () => {
  const html = renderPanel([makeEntry()])
  assert.doesNotMatch(html, /history-entry-closed/)
  assert.match(titleSpanClass(html), /\btext-tab-ink\b/)
})

test('a suspended open row dims only the favicon, not the title', () => {
  const html = renderPanel([makeEntry({ suspended: true })])
  assert.doesNotMatch(html, /history-entry-closed/)
  assert.match(html, /chip-favicon-dimmed/)
  assert.match(titleSpanClass(html), /\btext-tab-ink\b/)
})
