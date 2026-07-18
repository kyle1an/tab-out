import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TabHistoryPanel } from '../src/components/TabHistoryPanel.js'
import { historyEntryFromWorkingSetItem } from '../src/extension/tab-history.js'
import type { TabHistoryEntry, TabHistorySnapshot, WorkingSetItem } from '../src/extension/types'

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

function makeSnapshot(entries: TabHistoryEntry[]): TabHistorySnapshot {
  return {
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
}

function renderPanel(entries: TabHistoryEntry[]): string {
  return renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<{ snapshot: TabHistorySnapshot }>, {
      snapshot: makeSnapshot(entries)
    })
  )
}

test('a live history row keeps its favicon at full strength', () => {
  const html = renderPanel([makeEntry()])
  assert.match(html, /history-entry-favicon-frame/)
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('a loading live history row replaces its favicon with Chrome’s loading indicator color', () => {
  const html = renderPanel([makeEntry({ loading: true })])
  assert.match(html, /data-tabout-part="loading-indicator"/)
  assert.match(html, /style="color:#0b57d0"/)
  assert.match(html, /aria-busy="true"/)
  assert.doesNotMatch(html, /<img/)
})

test('a suspended history row dims its favicon', () => {
  const html = renderPanel([makeEntry({ suspended: true })])
  assert.match(html, /chip-favicon-dimmed/)
})

test('a closed history row dims its favicon', () => {
  const html = renderPanel([makeEntry({ exists: false, tabId: -1 })])
  assert.match(html, /chip-favicon-dimmed/)
})

test('rows dim independently within one panel', () => {
  const html = renderPanel([
    makeEntry({ index: 0, tabId: 101, url: 'https://example.com/a', rawUrl: 'https://example.com/a' }),
    makeEntry({ index: 1, tabId: 102, cursor: false, url: 'https://example.com/b', rawUrl: 'https://example.com/b', suspended: true })
  ])
  assert.equal((html.match(/chip-favicon-dimmed/g) || []).length, 1)
})

test('an open-ghost entry derives suspension from the suspender url', () => {
  const item: WorkingSetItem = {
    key: 'real.example/docs',
    tabId: 7,
    windowId: 1,
    tabUrl: 'https://real.example/docs',
    rawUrl: 'chrome-extension://suspenderid/suspended.html#ttl=Docs&uri=https%3A%2F%2Freal.example%2Fdocs',
    title: 'Docs',
    displayUrl: 'real.example/docs',
    faviconUrl: '',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    score: 10,
    lastActivatedAt: 0
  }
  const entry = historyEntryFromWorkingSetItem(item)
  assert.equal(entry.exists, true)
  assert.equal(entry.suspended, true)
})

test('an open-ghost entry carries its Working Set loading state into history', () => {
  const item: WorkingSetItem = {
    key: 'https://example.test/docs',
    tabId: 8,
    windowId: 1,
    tabUrl: 'https://example.test/docs',
    rawUrl: 'https://example.test/docs',
    title: 'Example Docs',
    displayUrl: 'example.test/docs',
    faviconUrl: 'https://example.test/icon.png',
    dupeCount: 1,
    active: false,
    activeInOtherWindow: false,
    loading: true,
    score: 10,
    lastActivatedAt: 0
  }
  const entry = historyEntryFromWorkingSetItem(item)
  assert.equal(entry.loading, true)
})
