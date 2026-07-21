import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { TabHistoryPanel } from '../../src/components/TabHistoryPanel.js'
import type {
  TabHistoryEntry,
  TabHistorySnapshot
} from '../../src/extension/types'

export function makeHistoryEntry(
  overrides: Partial<TabHistoryEntry> = {}
): TabHistoryEntry {
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

function makeHistorySnapshot(
  entries: TabHistoryEntry[]
): TabHistorySnapshot {
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

export function renderHistoryPanel(entries: TabHistoryEntry[]): string {
  return renderToStaticMarkup(
    React.createElement(
      TabHistoryPanel as React.ComponentType<{ snapshot: TabHistorySnapshot }>,
      { snapshot: makeHistorySnapshot(entries) }
    )
  )
}
