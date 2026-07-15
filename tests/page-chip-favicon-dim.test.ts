import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { PageChip } from '../src/components/PageChip.js'
import type { DashboardChipData } from '../src/extension/types'

function makeChip(overrides: Partial<DashboardChipData> = {}): DashboardChipData {
  return {
    tabUrl: 'https://site.example/page',
    rawUrl: 'https://site.example/page',
    sourceType: 'tab',
    leadPrefix: '',
    pathGroupLabel: '',
    displaySegments: ['Example Page'],
    suppressedTitleParts: [],
    pathSuffix: '',
    tooltip: 'Example Page',
    dupeCount: 1,
    faviconUrl: 'https://site.example/icon.png',
    isGrouped: false,
    groupDotColor: null,
    isApp: false,
    envs: null,
    ...overrides
  }
}

function renderChip(overrides: Partial<DashboardChipData> = {}): string {
  return renderToStaticMarkup(React.createElement(PageChip, { chip: makeChip(overrides) }))
}

test('a live tab chip keeps its favicon at full strength', () => {
  const html = renderChip()
  assert.match(html, /chip-favicon /)
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('a suspended tab chip dims its favicon', () => {
  const html = renderChip({ suspended: true })
  assert.match(html, /chip-favicon-dimmed/)
})

test('a closed saved page chip dims its favicon', () => {
  const html = renderChip({ sourceType: 'saved-page', saved: true, closedSaved: true })
  assert.match(html, /chip-favicon-dimmed/)
})

test('a closed saved page chip dims its default favicon too', () => {
  const html = renderChip({ sourceType: 'saved-page', saved: true, closedSaved: true, faviconUrl: '' })
  assert.match(html, /default-favicon-image[^"]*chip-favicon-dimmed|chip-favicon-dimmed[^"]*default-favicon-image/)
})

test('a bookmark chip keeps its favicon at full strength', () => {
  const html = renderChip({ sourceType: 'bookmark' })
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})

test('a history chip keeps its favicon at full strength', () => {
  const html = renderChip({ sourceType: 'history' })
  assert.doesNotMatch(html, /chip-favicon-dimmed/)
})
