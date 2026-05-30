import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { HeaderStats } from '../src/components/HeaderStats.js'
import type { DashboardStats } from '../src/extension/types'

function makeStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    totalTabs: 0,
    activeTabs: 0,
    visibleTabs: 0,
    totalWindows: 0,
    visibleWindows: 0,
    totalDomains: 0,
    visibleDomains: 0,
    dedupCount: 0,
    filteredCloseCount: 0,
    hasCards: false,
    filtering: false,
    ...overrides
  }
}

function renderHeaderStats(stats: DashboardStats): string {
  return renderToStaticMarkup(
    React.createElement(HeaderStats, {
      ...stats,
      onDedupAll: () => {},
      onCloseFiltered: () => {}
    })
  )
}

test('HeaderStats shows the active count when some tabs are suspended', () => {
  const html = renderHeaderStats(makeStats({ totalTabs: 200, activeTabs: 30 }))

  assert.match(html, /200 tabs/)
  assert.match(html, /\(30 active\)/)
})

test('HeaderStats hides the active count when no tabs are suspended', () => {
  const html = renderHeaderStats(makeStats({ totalTabs: 200, activeTabs: 200 }))

  assert.match(html, /200 tabs/)
  assert.doesNotMatch(html, /active/)
})
