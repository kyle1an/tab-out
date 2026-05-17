import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DomainCard } from '../src/components/DomainCard.js'
import { DomainCardProvider, type DomainCardContextValue } from '../src/components/DomainCardContext.js'
import { FlatSection } from '../src/components/FlatSection.js'
import { PageChip } from '../src/components/PageChip.js'
import { PathgroupSection } from '../src/components/PathgroupSection.js'
import { TabHistoryPanel } from '../src/components/TabHistoryPanel.js'
import { WebsitePathSection } from '../src/components/WebsitePathSection.js'
import type { TitleSuppressionTone } from '../src/components/title-suppression.js'
import type { DashboardCardVM, DashboardChipData, DomainGroup, TabHistorySnapshot } from '../src/extension/types'

function makeChip(overrides: Partial<DashboardChipData> = {}): DashboardChipData {
  return {
    tabUrl: 'https://openai.com/docs',
    rawUrl: 'https://openai.com/docs',
    sourceType: 'bookmark',
    leadPrefix: '',
    pathGroupLabel: '',
    displaySegments: ['OpenAI Docs'],
    suppressedTitleParts: [],
    pathSuffix: '',
    tooltip: 'OpenAI Docs',
    dupeCount: 1,
    faviconUrl: '',
    isGrouped: false,
    groupDotColor: null,
    isApp: false,
    envs: null,
    ...overrides
  }
}

function renderWithDomainCardContext(element: React.ReactElement, overrides: Partial<DomainCardContextValue> = {}) {
  const value: DomainCardContextValue = {
    activeSuppressedTitle: overrides.activeSuppressedTitle ?? '',
    setActiveSuppressedTitle: overrides.setActiveSuppressedTitle ?? (() => {}),
    dedupeBadgesClosing: overrides.dedupeBadgesClosing ?? false,
    onHoverUrlChange: overrides.onHoverUrlChange ?? null,
    activeHoverUrl: overrides.activeHoverUrl ?? '',
    activeHoverSource: overrides.activeHoverSource ?? null,
    onLayoutChange: overrides.onLayoutChange ?? null
  }

  return renderToStaticMarkup(React.createElement(DomainCardProvider, { value }, element))
}

function makeHistorySnapshot(overrides: Partial<TabHistorySnapshot> = {}): TabHistorySnapshot {
  return {
    stackSize: 1,
    maxSize: 40,
    cursorIndex: 0,
    currentIndex: 0,
    previousIndex: -1,
    nextIndex: -1,
    activeTabId: 101,
    activeWindowId: 1,
    activeWasInserted: false,
    entries: [
      {
        index: 0,
        tabId: 101,
        windowId: 1,
        exists: true,
        active: true,
        activeInOtherWindow: false,
        pinned: false,
        discarded: false,
        cursor: true,
        current: true,
        previousTarget: false,
        nextTarget: false,
        title: 'Example Docs',
        url: 'https://example.com/docs',
        displayUrl: 'example.com/docs',
        favIconUrl: ''
      }
    ],
    ...overrides
  }
}

test('PageChip highlights matched filter keywords inside visible chip text', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip(),
      filter: 'openai'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*">OpenAI<\/mark> Docs/)
  assert.match(html, /chip-filter-match\b[^"]*bg-\[rgba\(234,179,8,0\.42\)\][^"]*text-tab-ink[^"]*\[font:inherit\]/)
  assert.match(html, /chip-text\b[^"]*text-\[color-mix\(in_srgb,var\(--ink\)_72%,var\(--muted\)\)\]/)
  assert.doesNotMatch(html, /\bpx-0\.5\b/)
  assert.doesNotMatch(html, /chip-filter-match\b[^"]*font-semibold/)
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[1], /\bclickable\b/)
  assert.match(chipMatch[1], /\bcursor-default\b/)
  assert.doesNotMatch(chipMatch[1], /\bcursor-pointer\b/)
})

test('PageChip highlights each parsed filter token in visible chip text', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip(),
      filter: 'docs openai'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*">OpenAI<\/mark> <mark class="chip-filter-match\b[^"]*">Docs<\/mark>/)
})

test('PageChip renders the current active chip frame without the other-window label', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ activeChipFrame: true })
    })
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const frameMatch = html.match(/<span class="([^"]*\bactive-chip-frame\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(frameMatch, 'active chip frame should render')
  assert.match(chipMatch[1], /current-active-chip\b/)
  assert.match(chipMatch[1], /\bbg-neutral-100\b/)
  assert.match(chipMatch[1], /\bring-neutral-400\b/)
  assert.doesNotMatch(chipMatch[1], /\bhover:bg/)
  assert.doesNotMatch(chipMatch[1], /hover::after/)
  assert.doesNotMatch(chipMatch[1], /\bbefore:bg-neutral-700\b/)
  assert.doesNotMatch(chipMatch[1], /\bbefore:w-1\b/)
  assert.match(frameMatch[1], /current-active-chip-frame\b/)
  assert.match(html, /active-chip-frame\b/)
  assert.doesNotMatch(html, /Active in another window/)
})

test('PageChip keeps the other-window active chip style separate from the current active style', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ activeChipFrame: true, activeInOtherWindow: true })
    })
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const frameMatch = html.match(/<span class="([^"]*\bactive-chip-frame\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(frameMatch, 'active chip frame should render')
  assert.match(html, /Active in another window/)
  assert.match(chipMatch[1], /\bhover:bg/)
  assert.match(chipMatch[1], /hover::after/)
  assert.doesNotMatch(chipMatch[1], /current-active-chip\b/)
  assert.doesNotMatch(chipMatch[1], /\bring-neutral-400\b/)
  assert.doesNotMatch(frameMatch[1], /current-active-chip-frame\b/)
})

test('PageChip hover fade appears and clears without its own transition lag', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab' })
    })
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[1], /\bhover:bg-\[rgba\(82,82,82,0\.13\)\]/)
  assert.match(chipMatch[1], /:has\(\.chip-actions\):hover::after\]:opacity-100/)
  assert.doesNotMatch(chipMatch[1], /\bafter:transition-/)
  assert.doesNotMatch(chipMatch[1], /\bafter:duration-/)
  assert.doesNotMatch(chipMatch[1], /\bafter:ease-/)
})

test('PageChip outlines matching live chips only when history hover owns the match', () => {
  const chip = makeChip({
    tabUrl: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs'
  })
  const matchedHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'history' } as Partial<DomainCardContextValue>
  )
  const selfHoverHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'chip' } as Partial<DomainCardContextValue>
  )
  const chipMatch = matchedHtml.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(selfHoverMatch, 'self-hover page chip should render')
  assert.match(chipMatch[1], /\bpage-chip-hover-match\b/)
  assert.doesNotMatch(selfHoverMatch[1], /\bpage-chip-hover-match\b/)
})

test('TabHistoryPanel outlines matching history rows only when chip hover owns the match', () => {
  const snapshot = makeHistorySnapshot()
  const matchedHtml = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      activeHoverUrl: 'https://example.com/docs',
      activeHoverSource: 'chip'
    })
  )
  const selfHoverHtml = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      activeHoverUrl: 'https://example.com/docs',
      activeHoverSource: 'history'
    })
  )
  const entryMatch = matchedHtml.match(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)

  assert.ok(entryMatch, 'history entry should render')
  assert.ok(selfHoverMatch, 'self-hover history entry should render')
  assert.match(entryMatch[1], /\bhistory-entry-hover-match\b/)
  assert.doesNotMatch(selfHoverMatch[1], /\bhistory-entry-hover-match\b/)
})

test('TabHistoryPanel matches chip hover against raw tab URLs without changing the preview URL', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fdocs'
  const snapshot = makeHistorySnapshot({
    entries: [
      {
        ...makeHistorySnapshot().entries[0],
        url: rawUrl,
        displayUrl: 'example.com/docs'
      }
    ]
  })
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      activeHoverUrl: 'https://example.com/docs',
      activeHoverUrls: ['https://example.com/docs', rawUrl],
      activeHoverSource: 'chip'
    })
  )
  const entryMatch = html.match(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)

  assert.ok(entryMatch, 'history entry should render')
  assert.match(entryMatch[1], /\bhistory-entry-hover-match\b/)
})

test('TabHistoryPanel keeps the history entry surface on the default cursor', () => {
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot()
    })
  )
  const entryButtonMatch = html.match(/<button type="button" class="([^"]*\bw-full\b[^"]*\btext-left\b[^"]*)"/)

  assert.ok(entryButtonMatch, 'history entry button should render')
  assert.match(entryButtonMatch[1], /\bcursor-default\b/)
  assert.doesNotMatch(entryButtonMatch[1], /\bcursor-pointer\b/)
})

test('TabHistoryPanel borrows current PageChip surface styling for the current entry', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 202,
        currentIndex: 1,
        entries: [
          {
            ...baseEntry,
            index: 0,
            tabId: 101,
            active: false,
            activeInOtherWindow: false,
            cursor: false,
            current: false,
            title: 'Default Entry',
            url: 'https://example.com/default',
            displayUrl: 'example.com/default'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            title: 'Current Entry',
            activeInOtherWindow: false,
            url: 'https://example.com/current',
            displayUrl: 'example.com/current'
          }
        ]
      })
    })
  )
  const entryClasses = Array.from(html.matchAll(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/g), (match) => match[1])
  const currentEntry = entryClasses.find((className) => /\bis-current\b/.test(className))
  const defaultEntry = entryClasses.find((className) => !/\bis-current\b/.test(className))

  assert.ok(currentEntry, 'current history entry should render')
  assert.ok(defaultEntry, 'default history entry should render')
  assert.match(defaultEntry, /\bbg-tab-card\b/)
  assert.match(defaultEntry, /group-hover\/history-row:border-\[var\(--accent-amber\)\]/)
  assert.match(defaultEntry, /\bgroup-hover\/history-row:bg-tab-card\b/)
  assert.match(defaultEntry, /group-hover\/history-row:after:opacity-100/)
  assert.doesNotMatch(defaultEntry, /bg-\[rgba\(115,115,115,0\.04\)\]/)
  assert.match(currentEntry, /\bcurrent-active-history-entry\b/)
  assert.match(currentEntry, /\bborder-transparent\b/)
  assert.match(currentEntry, /\bbg-neutral-100\b/)
  assert.match(currentEntry, /\bring-neutral-400\b/)
  assert.doesNotMatch(currentEntry, /group-hover\/history-row:border-\[var\(--accent-amber\)\]/)
  assert.doesNotMatch(currentEntry, /\bgroup-hover\/history-row:bg-tab-card\b/)
  assert.doesNotMatch(currentEntry, /group-hover\/history-row:after:opacity-100/)
  assert.match(currentEntry, /shadow-\[0_1px_2px_rgba\(10,10,10,0\.07\)\]/)
  assert.doesNotMatch(currentEntry, /inset_0_0_0_1px_rgba\(82,82,82,0\.48\)/)
  assert.match(currentEntry, /\[--history-entry-fade-bg:var\(--color-neutral-100\)\]/)
  assert.match(html, /current-active-history-entry-frame\b[^"]*shadow-\[inset_0_0_0_1px_rgba\(82,82,82,0\.48\)\]/)
})

test('TabHistoryPanel borrows other-window PageChip surface styling for active non-current entries', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 202,
        activeWindowId: 2,
        currentIndex: 0,
        entries: [
          {
            ...baseEntry,
            index: 0,
            tabId: 101,
            active: false,
            activeInOtherWindow: false,
            title: 'Current Entry',
            url: 'https://example.com/current',
            displayUrl: 'example.com/current'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            windowId: 2,
            active: false,
            activeInOtherWindow: true,
            cursor: false,
            current: false,
            title: 'Open Elsewhere',
            url: 'https://example.com/elsewhere',
            displayUrl: 'example.com/elsewhere'
          }
        ]
      })
    })
  )
  const entryClasses = Array.from(html.matchAll(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/g), (match) => match[1])
  const activeOtherEntry = entryClasses.find((className) => /\bis-active\b/.test(className) && !/\bis-current\b/.test(className))

  assert.ok(activeOtherEntry, 'active non-current history entry should render')
  assert.doesNotMatch(html, />Active<\/span>/)
  assert.match(activeOtherEntry, /\bactive-in-other-window-history-entry\b/)
  assert.match(activeOtherEntry, /\bborder-\[rgba\(115,115,115,0\.2\)\]/)
  assert.doesNotMatch(activeOtherEntry, /\bborder-transparent\b/)
  assert.match(activeOtherEntry, /\bbg-\[rgba\(82,82,82,0\.075\)\]/)
  assert.match(activeOtherEntry, /shadow-\[0_1px_2px_rgba\(10,10,10,0\.04\)\]/)
  assert.match(activeOtherEntry, /group-hover\/history-row:bg-\[rgba\(82,82,82,0\.18\)\]/)
  assert.match(activeOtherEntry, /\[--history-entry-fade-bg:color-mix\(in_srgb,var\(--card-bg\)_82%,rgb\(82_82_82\)\)\]/)
  assert.doesNotMatch(activeOtherEntry, /\bcurrent-active-history-entry\b/)
  assert.doesNotMatch(activeOtherEntry, /\bring-neutral-400\b/)
  assert.doesNotMatch(html, /active-in-other-window-history-entry-frame/)
})

test('TabHistoryPanel keeps previous and next history targets visually neutral', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        currentIndex: 1,
        previousIndex: 0,
        nextIndex: 2,
        entries: [
          {
            ...baseEntry,
            index: 0,
            tabId: 101,
            active: false,
            cursor: false,
            current: false,
            previousTarget: true,
            title: 'Previous Entry',
            url: 'https://example.com/previous',
            displayUrl: 'example.com/previous'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            title: 'Current Entry',
            url: 'https://example.com/current',
            displayUrl: 'example.com/current'
          },
          {
            ...baseEntry,
            index: 2,
            tabId: 303,
            active: false,
            cursor: false,
            current: false,
            nextTarget: true,
            title: 'Next Entry',
            url: 'https://example.com/next',
            displayUrl: 'example.com/next'
          }
        ]
      })
    })
  )
  const entryClasses = Array.from(html.matchAll(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/g), (match) => match[1])
  const previousEntry = entryClasses.find((className) => /\bis-previous-target\b/.test(className))
  const nextEntry = entryClasses.find((className) => /\bis-next-target\b/.test(className))

  assert.ok(previousEntry, 'previous target history entry should render')
  assert.ok(nextEntry, 'next target history entry should render')
  assert.doesNotMatch(previousEntry, /border-\[rgba\(22,163,74,0\.45\)\]/)
  assert.doesNotMatch(nextEntry, /border-\[rgba\(37,99,235,0\.42\)\]/)
})

test('cross-surface hover match styling is outline-only', () => {
  const styleSource = readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8')
  const match = styleSource.match(/\.page-chip\.page-chip-hover-match,\n\.history-entry\.history-entry-hover-match\s*\{([^}]*)\}/)

  assert.ok(match, 'cross-surface hover match rule should exist')
  assert.match(match[1], /outline:\s*1px solid var\(--accent-amber\);/)
  assert.match(match[1], /outline-offset:\s*1px;/)
  assert.doesNotMatch(match[1], /\b(?:background|box-shadow|border):/)
})

test('PageChip highlights quoted filter phrases as one contiguous match', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip(),
      filter: '"OpenAI Docs"'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*">OpenAI Docs<\/mark>/)
})

test('PageChip highlights token aliases in visible chip text', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Pull Request review'],
        tooltip: 'Pull Request review'
      }),
      filter: 'pr'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*">Pull Request<\/mark> review/)
})

test('PageChip keeps history highlighting on legacy raw filter text for this pass', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'history' }),
      filter: 'docs openai'
    })
  )

  assert.doesNotMatch(html, /chip-filter-match/)
})

test('PageChip renders a title suppression marker when common title text is suppressed', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      })
    })
  )

  assert.match(html, /chip-title-suppression-marker\b/)
  assert.match(html, />˷<\/span>/)
  assert.match(html, /Suppressed title text: Example Workspace/)
  assert.doesNotMatch(html, /chip-title-suppression-marker[^>]* title=/)
  const chipMatch = html.match(/<div class="[^"]*\bpage-chip\b[^"]*"[^>]*>/)
  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[0], /data-slot="tooltip-trigger"/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)
  assert.ok(markerMatch, 'title suppression marker should render')
  assert.match(markerMatch[1], /\btext-xs\b/)
  assert.match(markerMatch[1], /\bfont-medium\b/)
  assert.doesNotMatch(markerMatch[1], /\bfont-semibold\b/)
  const markerElementMatch = html.match(/<span class="[^"]*\bchip-title-suppression-marker\b[^"]*"[^>]*>/)
  assert.ok(markerElementMatch, 'title suppression marker element should render')
  assert.doesNotMatch(markerElementMatch[0], /data-slot="tooltip-trigger"/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /const shouldShowChipTooltip = chip\.iconOnly \|\| isTextTruncated \|\| hasTitleSuppressionMarkers \|\| hasStructuralPlaceholders/)
  assert.match(pageChipSource, /mode === 'tooltip'[\s\S]*chip-title-suppression-marker inline-flex min-h-4/)
  assert.match(pageChipSource, /renderHighlightedText\(part, highlightTerms/)
  assert.doesNotMatch(pageChipSource, /title-suppression-marker-tooltip/)
})

test('PageChip tooltip keeps selectable whitespace before trailing suppression labels', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /const markerSpacingClass = mode === 'chip' \? \(index === 0 \? 'ml-1' : 'ml-0\.5'\) : ''/)
  assert.match(pageChipSource, /if \(mode === 'tooltip'\) \{[\s\S]*\{\s*' '\s*\}[\s\S]*\{marker\}/)
})

test('PageChip colors title suppression markers from token tones before hover', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace', 'JIRA']
      }),
      suppressedTitleToneByText: new Map<string, TitleSuppressionTone | ''>([
        ['example workspace', 'amber'],
        ['jira', 'teal']
      ])
    })
  )
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.equal(markerClasses.length, 2)
  assert.match(markerClasses[0], /title-suppression-token-tone-amber/)
  assert.match(markerClasses[0], /\bbg-yellow-50\b/)
  assert.doesNotMatch(markerClasses[0], /bg-\[#fff7ed\]/)
  assert.doesNotMatch(markerClasses[0], /bg-\[rgba/)
  assert.doesNotMatch(markerClasses[0], /\bhover:/)
  assert.doesNotMatch(markerClasses[0], /\bfocus-visible:/)
  assert.match(markerClasses[1], /title-suppression-token-tone-teal/)
  assert.match(markerClasses[1], /\bbg-teal-50\b/)
  assert.doesNotMatch(markerClasses[1], /bg-\[#f0fdfa\]/)
  assert.doesNotMatch(markerClasses[1], /bg-\[rgba/)
  assert.doesNotMatch(markerClasses[1], /\bhover:/)
  assert.doesNotMatch(markerClasses[1], /\bfocus-visible:/)
})

test('PageChip can render a title suppression marker inline before structural placeholders', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel — ', { titleSuppression: 'Example Workspace' }, ' — ', { placeholder: true }],
        suppressedTitleParts: ['Example Workspace']
      })
    })
  )
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.equal(markerClasses.length, 1)
  assert.match(html, /Alpha channel — [\s\S]*chip-title-suppression-marker[\s\S]*>˷<\/span>[\s\S]* — [\s\S]*chip-strip-indicator[\s\S]*>\/<\/span>/)
})

test('PageChip uses a path-style placeholder for stripped structural labels', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha ', { placeholder: true }, ' Beta']
      })
    })
  )

  const stripMatch = html.match(/<span class="([^"]*\bchip-strip-indicator\b[^"]*)" aria-hidden="true">([^<]+)<\/span>/)
  assert.ok(stripMatch, 'structural strip indicator should render')
  assert.equal(stripMatch[2], '/')
  assert.doesNotMatch(html, /chip-title-suppression-marker\b/)
})

test('PageChip labels stripped path-group placeholders with the pathgroup value', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha ', { placeholder: true, label: 'openai/docs' }, ' Beta']
      })
    })
  )

  assert.match(html, /chip-strip-indicator\b[^>]*aria-label="openai\/docs"[^>]*>\/<\/span>/)
  const markerElementMatch = html.match(/<span class="[^"]*\bchip-strip-indicator\b[^"]*"[^>]*>/)
  assert.ok(markerElementMatch, 'strip indicator element should render')
  assert.doesNotMatch(markerElementMatch[0], /data-slot="tooltip-trigger"/)
  const chipMatch = html.match(/<div class="[^"]*\bpage-chip\b[^"]*"[^>]*>/)
  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[0], /data-slot="tooltip-trigger"/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /mode === 'tooltip' && hiddenLabel/)
  assert.match(pageChipSource, /chip-strip-indicator inline-block max-w-full/)
  assert.match(pageChipSource, /renderHighlightedText\(hiddenLabel, highlightTerms/)
  assert.doesNotMatch(pageChipSource, /chip-strip-indicator-tooltip/)
})

test('PageChip marks chips affected by the active suppressed title text', () => {
  const defaultHtml = renderWithDomainCardContext(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      })
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )
  const tealHtml = renderWithDomainCardContext(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      }),
      suppressedTitleToneByText: new Map<string, TitleSuppressionTone | ''>([
        ['example workspace', 'teal']
      ])
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )

  assert.match(defaultHtml, /page-chip\b[^"]*page-chip-suppression-highlighted/)
  assert.match(defaultHtml, /\bbg-yellow-50\b/)
  assert.match(defaultHtml, /chip-title-suppression-marker\b[^"]*\bbg-yellow-50\b/)
  assert.match(tealHtml, /page-chip\b[^"]*page-chip-suppression-highlighted/)
  assert.match(tealHtml, /\bbg-teal-50\b/)
  assert.match(tealHtml, /chip-title-suppression-marker\b[^"]*\bbg-teal-50\b/)
  assert.doesNotMatch(tealHtml, /\bbg-yellow-50\b/)
})

test('PageChip renders path-group pills with a slash prefix', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        pathGroupLabel: 'openai/docs'
      })
    })
  )

  assert.match(html, /chip-pathgroup\b[^>]*>\/openai\/docs<\/span>/)
})

test('PageChip renders path suffixes without a left margin utility', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        pathSuffix: '/docs/reference'
      })
    })
  )

  const pathMatch = html.match(/<span class="([^"]*\bchip-path\b[^"]*)">/)
  assert.ok(pathMatch, 'chip path suffix should render')
  assert.doesNotMatch(pathMatch[1], /\bml-/)
  assert.match(html, /OpenAI Docs\s+<span class="[^"]*\bchip-path\b[^"]*">\/docs\/reference<\/span>/)
})

test('PageChip renders folded titles before env controls', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Deployment History'],
        suppressedTitleParts: ['| Example Retail', '- DEV1'],
        envs: [
          { prefix: 'dev1us', tabUrl: 'https://dev1us.example.com/deployments', rawUrl: 'https://dev1us.example.com/deployments' },
          { prefix: 'dev2us', tabUrl: 'https://dev2us.example.com/deployments', rawUrl: 'https://dev2us.example.com/deployments' }
        ]
      })
    })
  )

  assert.match(html, /page-chip-folded\b/)
  assert.match(html, /chip-folded-content\b/)
  assert.match(html, /chip-title-row\b[^>]*>Deployment History[\s\S]*chip-env-row\b[^>]*>[\s\S]*dev1us[\s\S]*dev2us/)
  assert.equal([...html.matchAll(/chip-title-suppression-marker/g)].length, 2)
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  assert.ok(chipMatch, 'folded page chip should render')
  assert.match(chipMatch[1], /\bpage-chip-folded\b/)
  assert.match(chipMatch[1], /\bcursor-default\b/)
  assert.doesNotMatch(chipMatch[1], /\bclickable\b/)
  assert.doesNotMatch(chipMatch[1], /\bcursor-pointer\b/)
  assert.doesNotMatch(chipMatch[1], /\bhover:bg/)
  assert.doesNotMatch(chipMatch[1], /\bfocus-visible:outline/)
  assert.doesNotMatch(html, /\btabindex="0"/)
  const envRowMatch = html.match(/<span class="([^"]*\bchip-env-row\b[^"]*)">/)
  assert.ok(envRowMatch, 'folded env row should render')
  assert.doesNotMatch(envRowMatch[1], /\bmr-/)
  const envButtonMatch = html.match(/<button[^>]*class="([^"]*\bchip-env\b[^"]*)"/)
  assert.ok(envButtonMatch, 'folded env button should render')
  assert.match(envButtonMatch[1], /\bh-6\b/)
  assert.match(envButtonMatch[1], /\bpx-2\b/)
  assert.match(envButtonMatch[1], /rounded-\[7px\]/)
  assert.match(envButtonMatch[1], /\bclickable\b/)
  assert.match(envButtonMatch[1], /\bcursor-pointer\b/)
  assert.match(envButtonMatch[1], /\bhover:bg/)
  assert.match(envButtonMatch[1], /\bfocus-visible:outline/)
})

test('PathgroupSection renders header path-group pills with a slash prefix', () => {
  const html = renderToStaticMarkup(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 1,
      closableUrls: [],
      visibleChips: [],
      hiddenChips: [],
      hiddenCount: 0
    })
  )

  assert.match(html, /chip-pathgroup\b[^>]*>\/openai\/docs<\/span>/)
})

test('WebsitePathSection renders raw path labels and keeps suppression summary on the section rail', () => {
  const html = renderToStaticMarkup(
    React.createElement(WebsitePathSection, {
      label: '/wiki',
      sectionCount: 3,
      sectionClosableUrls: [],
      hasFlat: true,
      flatVisibleChips: [
        makeChip({
          rawUrl: 'https://example.atlassian.net/wiki/home',
          tabUrl: 'https://example.atlassian.net/wiki/home',
          displaySegments: ['Wiki home'],
          suppressedTitleParts: ['- Example-Site - Confluence']
        })
      ],
      flatHiddenChips: [],
      flatHiddenCount: 0,
      suppressedTitleParts: [{ text: '- Example-Site - Confluence', count: 3, spansRenderedChildGroups: true }],
      clusters: [
        {
          key: 'wiki:KB',
          label: 'KB',
          isPR: false,
          count: 2,
          closableUrls: [],
          suppressedTitleParts: [],
          visibleChips: [
            makeChip({
              rawUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
              tabUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
              displaySegments: ['Alpha guide'],
              suppressedTitleParts: ['- Example-Site - Confluence']
            })
          ],
          hiddenChips: [],
          hiddenCount: 0
        }
      ]
    })
  )

  assert.match(html, /website-path-section\b/)
  const websitePathLabelMatch = html.match(/<span class="([^"]*\bwebsite-path-section-label\b[^"]*)"[^>]*>\/wiki<\/span>/)
  assert.ok(websitePathLabelMatch, 'website path section label should render')
  assert.doesNotMatch(websitePathLabelMatch[1], /\bchip-pathgroup\b/)
  assert.doesNotMatch(websitePathLabelMatch[1], /\bbg-\[/)
  assert.doesNotMatch(websitePathLabelMatch[1], /\brounded/)
  assert.doesNotMatch(websitePathLabelMatch[1], /\bpx-/)
  assert.match(websitePathLabelMatch[1], /\bfont-semibold\b/)
  assert.match(websitePathLabelMatch[1], /\btracking-wide\b/)
  assert.match(html, /chip-pathgroup\b[^>]*>\/KB<\/span>/)
  assert.doesNotMatch(html, /Confluence space|Jira|Google Docs/)
  const summaryMatch = html.match(/<div class="([^"]*\btitle-suppression-summary\b[^"]*)">/)
  assert.ok(summaryMatch, 'website-path suppression summary should render')
  assert.doesNotMatch(summaryMatch[1], /\b(?:pl|ml|px)-/)
  assert.match(html, /Suppressed in 3 titles: - Example-Site - Confluence/)
})

test('DomainCard renders docs.google.com website path sections through WebsitePathSection', () => {
  const group: DomainGroup = {
    domain: 'google.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-google-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    sections: [
      {
        key: 'docs',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [],
        websitePathSections: [
          {
            key: '/document',
            label: '/document',
            sectionCount: 1,
            sectionClosableUrls: [],
            hasFlat: true,
            flatVisibleChips: [
              makeChip({
                rawUrl: 'https://docs.google.com/document/d/doc-alpha/edit',
                tabUrl: 'https://docs.google.com/document/d/doc-alpha/edit',
                displaySegments: ['Example Spec']
              })
            ],
            flatHiddenChips: [],
            flatHiddenCount: 0,
            suppressedTitleParts: [],
            clusters: []
          },
          {
            key: '/spreadsheets',
            label: '/spreadsheets',
            sectionCount: 1,
            sectionClosableUrls: [],
            hasFlat: true,
            flatVisibleChips: [
              makeChip({
                rawUrl: 'https://docs.google.com/spreadsheets/d/sheet-alpha/edit',
                tabUrl: 'https://docs.google.com/spreadsheets/d/sheet-alpha/edit',
                displaySegments: ['Example Budget']
              })
            ],
            flatHiddenChips: [],
            flatHiddenCount: 0,
            suppressedTitleParts: [],
            clusters: []
          }
        ]
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )

  assert.match(html, /website-path-section-label\b[^>]*>\/document<\/span>[\s\S]*Example Spec/)
  assert.match(html, /website-path-section-label\b[^>]*>\/spreadsheets<\/span>[\s\S]*Example Budget/)
  assert.equal([...html.matchAll(/website-path-section\b/g)].length > 0, true)
})

test('Overflow expanders use one-line chip text and height metrics', () => {
  const flatHtml = renderToStaticMarkup(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips: [makeChip({ rawUrl: 'https://openai.com/hidden' })],
      hiddenCount: 1
    })
  )
  const pathgroupHtml = renderToStaticMarkup(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips: [makeChip({ rawUrl: 'https://openai.com/path-hidden' })],
      hiddenCount: 1
    })
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.match(overflowButtonMatch[1], /py-\[5px\]/)
    assert.match(overflowButtonMatch[1], /text-\[13px\]/)
    assert.match(overflowButtonMatch[1], /\bleading-tight\b/)
    assert.doesNotMatch(overflowButtonMatch[1], /\bafter:transition-/)
    assert.doesNotMatch(overflowButtonMatch[1], /\bafter:duration-/)
    assert.doesNotMatch(overflowButtonMatch[1], /\bafter:ease-/)
    assert.doesNotMatch(overflowButtonMatch[1], /\bpy-1\.5\b/)
    assert.doesNotMatch(overflowButtonMatch[1], /\btext-xs\b/)

    const moreTextMatch = html.match(/<span class="([^"]*\bchip-text\b[^"]*)">\+1 more<\/span>/)
    assert.ok(moreTextMatch, 'overflow more-count text should render')
    assert.match(moreTextMatch[1], /text-\[13px\]/)
  }
})

test('Overflow expanders keep the row neutral when only some hidden chips match active suppressed title text', () => {
  const hiddenChips = [
    makeChip({
      rawUrl: 'https://openai.com/hidden-workspace',
      displaySegments: ['Hidden workspace page'],
      suppressedTitleParts: ['Example Workspace']
    }),
    makeChip({
      rawUrl: 'https://openai.com/hidden-other',
      displaySegments: ['Hidden other page'],
      suppressedTitleParts: ['Other Workspace']
    })
  ]
  const suppressedTitleToneByText = new Map<string, TitleSuppressionTone | ''>([
    ['example workspace', 'teal']
  ])
  const flatHtml = renderWithDomainCardContext(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )
  const pathgroupHtml = renderWithDomainCardContext(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.doesNotMatch(overflowButtonMatch[1], /\bpage-chip-overflow-suppression-highlighted\b/)
    assert.doesNotMatch(overflowButtonMatch[1], /\bbg-teal-50\b/)
    assert.doesNotMatch(overflowButtonMatch[1], /\bring-teal-50\b/)
    assert.match(html, /page-chip-overflow-suppression-badge[^"]*border[^"]*border-teal-50[^"]*bg-teal-50[\s\S]*>˷1<\/span>/)
    assert.doesNotMatch(overflowButtonMatch[1], /\bbg-yellow-50\b/)
    assert.doesNotMatch(html, /hidden title suppresses/)
    assert.doesNotMatch(html, /Click to show/)
  }
})

test('Overflow expanders use full chip color when all hidden chips match active suppressed title text', () => {
  const hiddenChips = [
    makeChip({
      rawUrl: 'https://openai.com/hidden-workspace',
      displaySegments: ['Hidden workspace page'],
      suppressedTitleParts: ['Example Workspace']
    }),
    makeChip({
      rawUrl: 'https://openai.com/hidden-workspace-2',
      displaySegments: ['Hidden workspace page 2'],
      suppressedTitleParts: ['Example Workspace']
    })
  ]
  const suppressedTitleToneByText = new Map<string, TitleSuppressionTone | ''>([
    ['example workspace', 'teal']
  ])
  const flatHtml = renderWithDomainCardContext(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )
  const pathgroupHtml = renderWithDomainCardContext(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      suppressedTitleToneByText
    }),
    { activeSuppressedTitle: 'Example Workspace' }
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.match(overflowButtonMatch[1], /\bpage-chip-overflow-suppression-highlighted\b/)
    assert.match(overflowButtonMatch[1], /\bbg-teal-50\b/)
    assert.match(overflowButtonMatch[1], /\bring-1\b/)
    assert.match(overflowButtonMatch[1], /\bring-inset\b/)
    assert.match(overflowButtonMatch[1], /\bring-teal-50\b/)
    assert.match(html, /page-chip-overflow-suppression-badge[^"]*border[^"]*border-teal-50[^"]*bg-teal-50[\s\S]*>˷2<\/span>/)
  }
})

test('DomainCard shows common suppressed title text above the chips without a summary label', () => {
  const group: DomainGroup = {
    domain: 'slack.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-slack-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [{ text: 'Example Workspace', count: 2 }],
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )

  const summaryMatch = html.match(/<div class="([^"]*title-suppression-summary[^"]*)">/)
  assert.ok(summaryMatch, 'suppression summary row should render')
  assert.doesNotMatch(summaryMatch[1], /\bpx-1\b/)
  assert.doesNotMatch(summaryMatch[1], /\bpy-0\.5\b/)
  const tokenMatch = html.match(/<button[^>]*class="([^"]*title-suppression-token[^"]*)"/)
  assert.ok(tokenMatch, 'suppression token button should render')
  assert.match(tokenMatch[1], /rounded-\[6px\]/)
  assert.doesNotMatch(tokenMatch[1], /\bcursor-(default|pointer)\b/)
  assert.doesNotMatch(tokenMatch[1], /title-suppression-token-tone-/)
  assert.match(html, /Example Workspace/)
  assert.match(html, /Suppressed in 2 titles: Example Workspace/)
  const summarySource = readFileSync(new URL('../src/components/TitleSuppressionSummary.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(summarySource, /TooltipAnchor/)
  assert.doesNotMatch(summarySource, /title-suppression-tooltip/)
  assert.doesNotMatch(html, /title-suppression-summary-label\b/)
})

test('DomainCard renders utility cards as explicitly pinnable instead of fixed', () => {
  const vm: DashboardCardVM = {
    stableId: 'domain---tab-out--',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    sections: []
  }

  const cards = [
    { domain: '__tab-out__', label: 'New tabs', stableId: 'domain---tab-out--', pinLabel: 'Pin New tabs' },
    { domain: '__standalone-apps__', label: 'Apps', stableId: 'domain---standalone-apps--', pinLabel: 'Pin Apps' }
  ]

  for (const card of cards) {
    const html = renderToStaticMarkup(
      React.createElement(DomainCard, {
        group: { domain: card.domain, label: card.label, tabs: [] },
        vm: { ...vm, stableId: card.stableId },
        onTogglePinnedDomain: () => {}
      })
    )

    assert.match(html, /\bdomain-pin-btn\b/)
    assert.match(html, new RegExp(`aria-label="${card.pinLabel}"`))
    assert.doesNotMatch(html, /\bdomain-fixed-indicator\b/)
    assert.doesNotMatch(html, /\bdomain-block-fixed\b/)
  }
})

test('DomainCard renders section-scoped single suppressed title text as neutral', () => {
  const group: DomainGroup = {
    domain: 'slack.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-slack-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [{ text: 'Example Workspace', count: 2 }],
    sections: [
      {
        key: 'app',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: true,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Alpha channel'],
            suppressedTitleParts: ['Example Workspace']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [{ text: 'Example Workspace', count: 2 }],
        clusters: [],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )

  assert.match(html, /subdomain-header[\s\S]*app[\s\S]*title-suppression-summary[\s\S]*Example Workspace/)
  assert.match(html, /chip-title-suppression-marker\b/)
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)
  assert.ok(tokenMatch, 'section-scoped suppression token should render')
  assert.ok(markerMatch, 'matching suppression marker should render')
  assert.doesNotMatch(tokenMatch[1], /title-suppression-token-tone-/)
  assert.doesNotMatch(markerMatch[1], /title-suppression-token-tone-/)
})

test('DomainCard colors section-scoped single suppressed title text when it spans rendered child groups', () => {
  const group: DomainGroup = {
    domain: 'atlassian.net',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-atlassian-net',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '3',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [{ text: '- JIRA', count: 3, spansRenderedChildGroups: true }],
    sections: [
      {
        key: '',
        sectionCount: 3,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Work item search'],
            suppressedTitleParts: ['- JIRA']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [{ text: '- JIRA', count: 3, spansRenderedChildGroups: true }],
        clusters: [
          {
            key: 'jira:CT',
            label: 'CT',
            isPR: false,
            count: 1,
            closableUrls: [],
            suppressedTitleParts: [],
            visibleChips: [
              makeChip({
                rawUrl: 'https://example.atlassian.net/browse/APP-1',
                tabUrl: 'https://example.atlassian.net/browse/APP-1',
                displaySegments: ['[APP-1] Account settings'],
                suppressedTitleParts: ['- JIRA']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.ok(tokenMatch, 'section-scoped suppression token should render')
  assert.match(tokenMatch[1], /title-suppression-token-tone-amber/)
  assert.equal(markerClasses.length, 2)
  assert.match(markerClasses[0], /title-suppression-token-tone-amber/)
  assert.match(markerClasses[1], /title-suppression-token-tone-amber/)
})

test('DomainCard keeps cross-child single suppressed title text neutral when it is the only card meaning', () => {
  const group: DomainGroup = {
    domain: 'example.test',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-example-test',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '4',
    suppressedTitleParts: [{ text: '| Example Retail', count: 4 }],
    allSuppressedTitleParts: [{ text: '| Example Retail', count: 4 }],
    sections: [
      {
        key: '',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: true,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Deployment History - ENV A'],
            suppressedTitleParts: ['| Example Retail']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [],
        websitePathSections: []
      },
      {
        key: 'env-a',
        sectionCount: 1,
        sectionClosableUrls: [],
        showHeader: true,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            rawUrl: 'https://env-a.example.test/order',
            tabUrl: 'https://env-a.example.test/order',
            displaySegments: ['Order Page'],
            suppressedTitleParts: ['| Example Retail']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.ok(tokenMatch, 'card-scoped suppression token should render')
  assert.doesNotMatch(tokenMatch[1], /title-suppression-token-tone-/)
  assert.equal(markerClasses.length, 2)
  assert.doesNotMatch(markerClasses[0], /title-suppression-token-tone-/)
  assert.doesNotMatch(markerClasses[1], /title-suppression-token-tone-/)
})

test('DomainCard renders pathgroup-scoped single suppressed title text as neutral', () => {
  const group: DomainGroup = {
    domain: 'contentful.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-contentful-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [
      { text: 'JIRA', count: 2 },
      { text: 'Content — Example Website', count: 2 }
    ],
    sections: [
      {
        key: 'app',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'dev2',
            label: 'dev2',
            isPR: false,
            count: 2,
            closableUrls: [],
            suppressedTitleParts: [{ text: 'Content — Example Website', count: 2 }],
            visibleChips: [
              makeChip({
                displaySegments: ['Example Article'],
                suppressedTitleParts: ['Content — Example Website']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )
  const tokenMatch = html.match(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)

  assert.ok(tokenMatch, 'pathgroup-scoped suppression token should render')
  assert.ok(markerMatch, 'matching suppression marker should render')
  assert.doesNotMatch(tokenMatch[1], /title-suppression-token-tone-/)
  assert.doesNotMatch(markerMatch[1], /title-suppression-token-tone-/)
})

test('DomainCard renders pathgroup-scoped multiple suppressed titles with local tones', () => {
  const group: DomainGroup = {
    domain: 'contentful.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-contentful-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '2',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [
      { text: 'Unrelated Card Token', count: 2 },
      { text: 'JIRA', count: 2 },
      { text: 'Content — Example Website', count: 2 }
    ],
    sections: [
      {
        key: 'app',
        sectionCount: 2,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'dev2',
            label: 'dev2',
            isPR: false,
            count: 2,
            closableUrls: [],
            suppressedTitleParts: [
              { text: 'JIRA', count: 2 },
              { text: 'Content — Example Website', count: 2 }
            ],
            visibleChips: [
              makeChip({
                displaySegments: ['Example Article'],
                suppressedTitleParts: ['JIRA', 'Content — Example Website']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )
  const tokenClasses = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/g)].map((match) => match[1])
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.equal(tokenClasses.length, 2)
  assert.match(tokenClasses[0], /title-suppression-token-tone-amber/)
  assert.match(tokenClasses[1], /title-suppression-token-tone-teal/)
  assert.equal(markerClasses.length, 2)
  assert.match(markerClasses[0], /title-suppression-token-tone-amber/)
  assert.match(markerClasses[1], /title-suppression-token-tone-teal/)
})

test('DomainCard displays suppression tokens in title order while coloring higher coverage tokens first', () => {
  const group: DomainGroup = {
    domain: 'contentful.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-contentful-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '17',
    suppressedTitleParts: [],
    allSuppressedTitleParts: [
      { text: '— Content — Example Website —', count: 6 },
      { text: '— Example Website —', count: 3 },
      { text: '— Contentful', count: 14 }
    ],
    sections: [
      {
        key: 'app',
        sectionCount: 17,
        sectionClosableUrls: [],
        showHeader: true,
        isShared: false,
        hasFlat: false,
        flatVisibleChips: [],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'dev2',
            label: 'dev2',
            isPR: false,
            count: 8,
            closableUrls: [],
            suppressedTitleParts: [
              { text: '— Content — Example Website —', count: 6 },
              { text: '— Example Website —', count: 3 },
              { text: '— Contentful', count: 14 }
            ],
            visibleChips: [
              makeChip({
                displaySegments: ['Example Article Beta'],
                suppressedTitleParts: ['— Content — Example Website —', '— Example Website —', '— Contentful']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )
  const tokenMatches = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"[^>]*aria-label="Suppressed in \d+ titles: ([^"]+)"/g)]
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.deepEqual(tokenMatches.map((match) => match[2]), [
    '— Content — Example Website —',
    '— Example Website —',
    '— Contentful'
  ])
  assert.match(tokenMatches[0][1], /title-suppression-token-tone-teal/)
  assert.match(tokenMatches[1][1], /title-suppression-token-tone-sky/)
  assert.match(tokenMatches[2][1], /title-suppression-token-tone-amber/)
  assert.equal(markerClasses.length, 3)
  assert.match(markerClasses[0], /title-suppression-token-tone-teal/)
  assert.match(markerClasses[1], /title-suppression-token-tone-sky/)
  assert.match(markerClasses[2], /title-suppression-token-tone-amber/)
})

test('DomainCard coordinates child title suppression tones with a colored ancestor scope', () => {
  const group: DomainGroup = {
    domain: 'atlassian.net',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-atlassian-net',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '5',
    suppressedTitleParts: [{ text: '- JIRA', count: 3, spansRenderedChildGroups: true }],
    allSuppressedTitleParts: [
      { text: '- JIRA', count: 3, spansRenderedChildGroups: true },
      { text: '- Example-Site', count: 2 },
      { text: '- Confluence', count: 2 }
    ],
    sections: [
      {
        key: '',
        sectionCount: 5,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Work item search'],
            suppressedTitleParts: ['- JIRA']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        suppressedTitleParts: [],
        clusters: [
          {
            key: 'wiki:KB',
            label: 'KB',
            isPR: false,
            count: 2,
            closableUrls: [],
            suppressedTitleParts: [
              { text: '- Example-Site', count: 2 },
              { text: '- Confluence', count: 2 }
            ],
            visibleChips: [
              makeChip({
                rawUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
                tabUrl: 'https://example.atlassian.net/wiki/spaces/KB/pages/page-alpha',
                displaySegments: ['Platform Architecture Notes'],
                suppressedTitleParts: ['- Example-Site', '- Confluence']
              })
            ],
            hiddenChips: [],
            hiddenCount: 0
          }
        ],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )
  const tokenClasses = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/g)].map((match) => match[1])
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.equal(tokenClasses.length, 3)
  assert.match(tokenClasses[0], /title-suppression-token-tone-amber/)
  assert.match(tokenClasses[1], /title-suppression-token-tone-teal/)
  assert.match(tokenClasses[2], /title-suppression-token-tone-sky/)
  assert.equal(markerClasses.length, 3)
  assert.match(markerClasses[0], /title-suppression-token-tone-amber/)
  assert.match(markerClasses[1], /title-suppression-token-tone-teal/)
  assert.match(markerClasses[2], /title-suppression-token-tone-sky/)
})

test('DomainCard assigns subtle tones when multiple suppressed title tokens render', () => {
  const group: DomainGroup = {
    domain: 'slack.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-slack-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '4',
    suppressedTitleParts: [
      { text: 'Example Workspace', count: 2 },
      { text: 'JIRA', count: 2 },
      { text: 'Content — Example Website', count: 3 }
    ],
    sections: [
      {
        key: '',
        sectionCount: 1,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: [
          makeChip({
            displaySegments: ['Alpha channel'],
            suppressedTitleParts: ['JIRA', 'Content — Example Website']
          })
        ],
        flatHiddenChips: [],
        flatHiddenCount: 0,
        clusters: [],
        websitePathSections: []
      }
    ]
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )
  const tokenClasses = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/g)].map((match) => match[1])

  assert.equal(tokenClasses.length, 3)
  assert.match(tokenClasses[0], /title-suppression-token-tone-teal/)
  assert.match(tokenClasses[1], /title-suppression-token-tone-sky/)
  assert.match(tokenClasses[2], /title-suppression-token-tone-amber/)
  assert.notEqual(tokenClasses[0], tokenClasses[1])
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])
  assert.equal(markerClasses.length, 2)
  assert.match(markerClasses[0], /title-suppression-token-tone-sky/)
  assert.match(markerClasses[1], /title-suppression-token-tone-amber/)
})
