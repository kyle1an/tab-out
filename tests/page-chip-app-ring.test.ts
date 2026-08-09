import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PageChip } from '../src/components/PageChip.js'
import type { DashboardChipData } from '../src/extension/types'

function makeChip(overrides: Partial<DashboardChipData> = {}): DashboardChipData {
  return {
    tabUrl: 'https://mail.example.com/inbox',
    rawUrl: 'https://mail.example.com/inbox',
    sourceType: 'tab',
    leadPrefix: '',
    pathGroupLabel: '',
    displaySegments: ['Inbox - Mail'],
    suppressedTitleParts: [],
    pathSuffix: '',
    tooltip: 'Inbox - Mail',
    dupeCount: 1,
    faviconUrl: 'https://mail.example.com/icon.png',
    isGrouped: false,
    groupDotColor: null,
    isApp: false,
    envs: null,
    ...overrides,
  }
}

function renderChip(overrides: Partial<DashboardChipData> = {}): string {
  return renderToStaticMarkup(React.createElement(PageChip, { chip: makeChip(overrides) }))
}

test('a titled app chip rings its favicon like the history app rows', () => {
  const html = renderChip({ isApp: true })
  assert.match(html, /chip-app-favicon-ring/)
  assert.match(html, /border-\[rgba\(115,115,115,0\.32\)\]/)
})

test('a regular page chip draws no favicon ring', () => {
  const html = renderChip()
  assert.doesNotMatch(html, /chip-app-favicon-ring/)
})

test('an icon-only app chip keeps its chip-level frame instead of the favicon ring', () => {
  const html = renderChip({ isApp: true, iconOnly: true })
  assert.doesNotMatch(html, /chip-app-favicon-ring/)
})
