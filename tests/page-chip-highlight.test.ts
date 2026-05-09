import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DomainCard } from '../src/components/DomainCard.js'
import { FlatSection } from '../src/components/FlatSection.js'
import { PageChip } from '../src/components/PageChip.js'
import { PathgroupSection } from '../src/components/PathgroupSection.js'
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
  assert.match(tealHtml, /page-chip\b[^"]*page-chip-suppression-highlighted/)
  assert.match(tealHtml, /bg-\[rgba\(20,184,166,0\.12\)\]/)
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

test('Overflow expanders highlight hidden chips that match active suppressed title text', () => {
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
    assert.match(overflowButtonMatch[1], /\bpage-chip-overflow-suppression-highlighted\b/)
    assert.match(overflowButtonMatch[1], /bg-\[rgba\(20,184,166,0\.08\)\]/)
    assert.match(overflowButtonMatch[1], /shadow-\[inset_0_0_0_1px_rgba\(20,184,166,0\.24\)\]/)
    assert.match(html, /page-chip-overflow-suppression-badge[^"]*bg-\[rgba\(20,184,166,0\.16\)\][\s\S]*>~1<\/span>/)
    assert.doesNotMatch(overflowButtonMatch[1], /bg-\[rgba\(234,179,8,0\.08\)\]/)
    assert.doesNotMatch(html, /hidden title suppresses/)
    assert.doesNotMatch(html, /Click to show/)
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
  assert.doesNotMatch(tokenMatch[1], /title-suppression-token-tone-/)
  assert.match(html, /Example Workspace/)
  assert.match(html, /Suppressed in 2 titles: Example Workspace/)
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  assert.match(domainCardSource, /className="title-suppression-tooltip text-\[13px\] leading-4"/)
  assert.doesNotMatch(html, /title-suppression-summary-label\b/)
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
    sections: []
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
})
