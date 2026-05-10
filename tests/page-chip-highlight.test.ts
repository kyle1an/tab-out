import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DomainCard } from '../src/components/DomainCard.js'
import { FlatSection } from '../src/components/FlatSection.js'
import { PageChip } from '../src/components/PageChip.js'
import { PathgroupSection } from '../src/components/PathgroupSection.js'
import type { TitleSuppressionTone } from '../src/components/title-suppression.js'
import type { DashboardCardVM, DashboardChipData, DomainGroup } from '../src/extension/types'

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
  assert.match(html, />~<\/span>/)
  assert.match(html, /Suppressed title text: Example Workspace/)
  assert.doesNotMatch(html, /chip-title-suppression-marker[^>]* title=/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)
  assert.ok(markerMatch, 'title suppression marker should render')
  assert.match(markerMatch[1], /\btext-xs\b/)
  assert.match(markerMatch[1], /\bfont-medium\b/)
  assert.doesNotMatch(markerMatch[1], /\bfont-semibold\b/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /className="title-suppression-marker-tooltip text-\[13px\] leading-4"/)
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
  assert.match(markerClasses[0], /bg-\[#fff7ed\]/)
  assert.doesNotMatch(markerClasses[0], /bg-\[rgba\(217,119,6,/)
  assert.doesNotMatch(markerClasses[0], /\bhover:/)
  assert.doesNotMatch(markerClasses[0], /\bfocus-visible:/)
  assert.match(markerClasses[1], /title-suppression-token-tone-teal/)
  assert.match(markerClasses[1], /bg-\[#f0fdfa\]/)
  assert.doesNotMatch(markerClasses[1], /bg-\[rgba\(20,184,166,/)
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
  assert.match(html, /Alpha channel — [\s\S]*chip-title-suppression-marker[\s\S]*>~<\/span>[\s\S]* — [\s\S]*chip-strip-indicator[\s\S]*>\/<\/span>/)
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

test('PageChip marks chips affected by the active suppressed title text', () => {
  const defaultHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      }),
      activeSuppressedTitle: 'Example Workspace'
    })
  )
  const tealHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Alpha channel'],
        suppressedTitleParts: ['Example Workspace']
      }),
      activeSuppressedTitle: 'Example Workspace',
      activeSuppressionTone: 'teal'
    })
  )

  assert.match(defaultHtml, /page-chip\b[^"]*page-chip-suppression-highlighted/)
  assert.match(defaultHtml, /bg-\[rgba\(234,179,8,0\.12\)\]/)
  assert.match(defaultHtml, /chip-title-suppression-marker\b[^"]*bg-\[rgba\(234,179,8,0\.14\)\]/)
  assert.match(tealHtml, /page-chip\b[^"]*page-chip-suppression-highlighted/)
  assert.match(tealHtml, /bg-\[#f0fdfa\]/)
  assert.match(tealHtml, /chip-title-suppression-marker\b[^"]*bg-\[#ccfbf1\]/)
  assert.doesNotMatch(tealHtml, /bg-\[rgba\(234,179,8,0\.12\)\]/)
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
  const flatHtml = renderToStaticMarkup(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      activeSuppressedTitle: 'Example Workspace',
      activeSuppressionTone: 'teal'
    })
  )
  const pathgroupHtml = renderToStaticMarkup(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      activeSuppressedTitle: 'Example Workspace',
      activeSuppressionTone: 'teal'
    })
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.doesNotMatch(overflowButtonMatch[1], /\bpage-chip-overflow-suppression-highlighted\b/)
    assert.doesNotMatch(overflowButtonMatch[1], /bg-\[rgba\(20,184,166,0\.08\)\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /bg-\[rgba\(20,184,166,0\.12\)\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /bg-\[#f0fdfa\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /shadow-\[inset_0_0_0_1px_rgba\(20,184,166,0\.24\)\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /shadow-\[inset_0_0_0_1px_rgba\(20,184,166,0\.32\)\]/)
    assert.match(html, /page-chip-overflow-suppression-badge[^"]*border[^"]*border-\[#5eead4\][^"]*bg-\[#ccfbf1\][\s\S]*>~1<\/span>/)
    assert.doesNotMatch(overflowButtonMatch[1], /bg-\[rgba\(234,179,8,0\.08\)\]/)
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
  const flatHtml = renderToStaticMarkup(
    React.createElement(FlatSection, {
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      activeSuppressedTitle: 'Example Workspace',
      activeSuppressionTone: 'teal'
    })
  )
  const pathgroupHtml = renderToStaticMarkup(
    React.createElement(PathgroupSection, {
      label: 'openai/docs',
      isPR: false,
      count: 2,
      closableUrls: [],
      visibleChips: [],
      hiddenChips,
      hiddenCount: hiddenChips.length,
      activeSuppressedTitle: 'Example Workspace',
      activeSuppressionTone: 'teal'
    })
  )

  for (const html of [flatHtml, pathgroupHtml]) {
    const overflowButtonMatch = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(overflowButtonMatch, 'overflow expander button should render')
    assert.match(overflowButtonMatch[1], /\bpage-chip-overflow-suppression-highlighted\b/)
    assert.match(overflowButtonMatch[1], /bg-\[#f0fdfa\]/)
    assert.match(overflowButtonMatch[1], /shadow-\[inset_0_0_0_1px_#5eead4\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /bg-\[rgba\(20,184,166,0\.08\)\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /bg-\[rgba\(20,184,166,0\.12\)\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /shadow-\[inset_0_0_0_1px_rgba\(20,184,166,0\.24\)\]/)
    assert.doesNotMatch(overflowButtonMatch[1], /shadow-\[inset_0_0_0_1px_rgba\(20,184,166,0\.32\)\]/)
    assert.match(html, /page-chip-overflow-suppression-badge[^"]*border[^"]*border-\[#5eead4\][^"]*bg-\[#ccfbf1\][\s\S]*>~2<\/span>/)
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
        clusters: []
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
  const tokenClasses = [...html.matchAll(/<button[^>]*class="([^"]*\btitle-suppression-token\b[^"]*)"/g)].map((match) => match[1])
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])

  assert.equal(tokenClasses.length, 2)
  assert.match(tokenClasses[0], /title-suppression-token-tone-amber/)
  assert.match(tokenClasses[1], /title-suppression-token-tone-teal/)
  assert.equal(markerClasses.length, 2)
  assert.match(markerClasses[0], /title-suppression-token-tone-amber/)
  assert.match(markerClasses[1], /title-suppression-token-tone-teal/)
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
        clusters: []
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
  assert.match(tokenClasses[0], /title-suppression-token-tone-amber/)
  assert.match(tokenClasses[1], /title-suppression-token-tone-teal/)
  assert.match(tokenClasses[2], /title-suppression-token-tone-sky/)
  assert.notEqual(tokenClasses[0], tokenClasses[1])
  const markerClasses = [...html.matchAll(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/g)].map((match) => match[1])
  assert.equal(markerClasses.length, 2)
  assert.match(markerClasses[0], /title-suppression-token-tone-teal/)
  assert.match(markerClasses[1], /title-suppression-token-tone-sky/)
})
