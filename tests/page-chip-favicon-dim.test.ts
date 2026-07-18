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

test('a loading live tab chip replaces its favicon with a loading indicator', () => {
  const html = renderChip({ loading: true })
  assert.match(html, /data-tabout-part="loading-indicator"/)
  assert.match(html, /style="color:#0b57d0"/)
  assert.doesNotMatch(html, /chip-favicon /)
  assert.match(html, /aria-label="Example Page · Loading"/)
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

test('a suspended current variant keeps a distinct fixed label color while a live variant does not', () => {
  const html = renderChip({
    titleVariantChips: [
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', suspended: true, activeChipFrame: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' })
    ]
  })
  assert.match(html, /chip-title-variant clickable[^"]*text-neutral-600/)
  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
  assert.match(html, /chip-variant-label-dimmed[^"]*text-neutral-500[^"]*opacity-85/)
})

test('a closed-saved variant row dims its label', () => {
  const html = renderChip({
    titleVariantChips: [
      makeChip({ tabUrl: 'https://site.example/a', rawUrl: 'https://site.example/a', pathSuffix: '/a', sourceType: 'saved-page', saved: true, closedSaved: true }),
      makeChip({ tabUrl: 'https://site.example/b', rawUrl: 'https://site.example/b', pathSuffix: '/b' })
    ]
  })
  assert.equal((html.match(/chip-variant-label-dimmed/g) || []).length, 1)
})
