import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { DomainCard } from '../src/components/DomainCard.js'
import { DomainCardProvider, type DomainCardContextValue } from '../src/components/DomainCardContext.js'
import { FlatSection } from '../src/components/FlatSection.js'
import { PageChip } from '../src/components/PageChip.js'
import { PAGE_CHIP_CLOSE_ANIMATION_MS, startPageChipCloseAnimation } from '../src/components/PageChipCloseAnimation.js'
import { PathgroupSection } from '../src/components/PathgroupSection.js'
import { TabHistoryPanel } from '../src/components/TabHistoryPanel.js'
import { WebsitePathSection } from '../src/components/WebsitePathSection.js'
import type { TitleSuppressionTone } from '../src/components/title-suppression.js'
import type { DashboardCardVM, DashboardChipData, DomainGroup, TabHistorySnapshot, WorkingSetSnapshot } from '../src/extension/types'

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
    activeHoverUrls: overrides.activeHoverUrls ?? [],
    activeHoverSource: overrides.activeHoverSource ?? null,
    onLayoutChange: overrides.onLayoutChange ?? null
  }

  return renderToStaticMarkup(React.createElement(DomainCardProvider, { value }, element))
}

function assertInstantActionClass(className: string) {
  assert.doesNotMatch(className, /(?:^|\s)(?:transition(?:-\S+)?|duration-\S+|delay-\S+|ease-\S+)(?:\s|$)/)
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
        isApp: false,
        pinned: false,
        discarded: false,
        cursor: true,
        current: true,
        previousTarget: false,
        nextTarget: false,
        title: 'Example Docs',
        url: 'https://example.com/docs',
        rawUrl: 'https://example.com/docs',
        displayUrl: 'example.com/docs',
        favIconUrl: ''
      }
    ],
    ...overrides
  }
}

function makeWorkingSetSnapshot(overrides: Partial<WorkingSetSnapshot> = {}): WorkingSetSnapshot {
  return {
    defaultLimit: 8,
    expandedLimit: 16,
    items: [
      {
        key: 'https://example.com/docs',
        tabId: 101,
        windowId: 1,
        tabUrl: 'https://example.com/docs',
        rawUrl: 'https://example.com/docs',
        title: 'Example Docs',
        displayUrl: 'example.com/docs',
        faviconUrl: '',
        dupeCount: 1,
        active: true,
        activeInOtherWindow: false,
        score: 100
      }
    ],
    ...overrides
  }
}

test('PageChip applies bionic reading emphasis to title text only', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['Example Article'],
        pathGroupLabel: 'openai/docs',
        pathSuffix: '/reference'
      })
    })
  )

  assert.match(html, /<span class="chip-title-fixation\b[^"]*\bfont-semibold\b[^"]*">Exa<\/span>mple <span class="chip-title-fixation\b[^"]*\bfont-semibold\b[^"]*">Art<\/span>icle/)
  const pathGroupMatch = html.match(/<span class="([^"]*\bchip-pathgroup\b[^"]*)"[^>]*>[\s\S]*?<\/span>/)
  const pathMatch = html.match(/<span class="([^"]*\bchip-path\b[^"]*)"[^>]*>[\s\S]*?<\/span>/)
  assert.ok(pathGroupMatch, 'path group should render')
  assert.ok(pathMatch, 'path suffix should render')
  assert.doesNotMatch(pathGroupMatch[0], /chip-title-fixation/)
  assert.doesNotMatch(pathMatch[0], /chip-title-fixation/)
})

test('PageChip skips bionic reading when title text is a URL', () => {
  const protocolUrlHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['https://example.com/docs/reference'],
        tooltip: 'https://example.com/docs/reference'
      }),
      filter: 'example'
    })
  )
  const hostUrlHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['example.com/docs/reference'],
        tooltip: 'example.com/docs/reference'
      })
    })
  )

  assert.match(protocolUrlHtml, /https:\/\/<mark class="chip-filter-match\b[^"]*">example<\/mark>\.com\/docs\/reference/)
  assert.doesNotMatch(protocolUrlHtml, /chip-title-fixation/)
  assert.match(hostUrlHtml, /example\.com\/docs\/reference/)
  assert.doesNotMatch(hostUrlHtml, /chip-title-fixation/)
})

test('PageChip skips bionic reading inside Jira ticket references', () => {
  const ticketOnlyHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['ICS2-308'],
        tooltip: 'ICS2-308'
      })
    })
  )
  const ticketTitleHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['CT-1569 Example Article'],
        tooltip: 'CT-1569 Example Article'
      })
    })
  )
  const filteredTicketTitleHtml = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['CT-1569 Example Article'],
        tooltip: 'CT-1569 Example Article'
      }),
      filter: '1569'
    })
  )

  assert.match(ticketOnlyHtml, /ICS2-308/)
  assert.doesNotMatch(ticketOnlyHtml, /chip-title-fixation/)
  assert.match(ticketTitleHtml, /CT-1569 <span class="chip-title-fixation\b[^"]*">Exa<\/span>mple <span class="chip-title-fixation\b[^"]*">Art<\/span>icle/)
  assert.doesNotMatch(ticketTitleHtml, /chip-title-fixation\b[^>]*>CT</)
  assert.doesNotMatch(ticketTitleHtml, /chip-title-fixation\b[^>]*>1569</)
  assert.match(filteredTicketTitleHtml, /CT-<mark class="chip-filter-match\b[^"]*">1569<\/mark> <span class="chip-title-fixation\b[^"]*">Exa<\/span>mple/)
  assert.doesNotMatch(filteredTicketTitleHtml, /chip-title-fixation\b[^>]*>CT</)
})

test('PageChip skips bionic reading for short function words and acronyms', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({
        displaySegments: ['The API and UX of New Checkout Flow'],
        tooltip: 'The API and UX of New Checkout Flow'
      })
    })
  )

  assert.match(html, /The API and UX of New <span class="chip-title-fixation\b[^"]*">Chec<\/span>kout <span class="chip-title-fixation\b[^"]*">Fl<\/span>ow/)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>The</)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>API</)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>and</)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>UX</)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>of</)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>New</)
})

test('PageChip highlights matched filter keywords inside visible chip text', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip(),
      filter: 'openai'
    })
  )

  assert.match(html, /<mark class="chip-filter-match\b[^"]*">OpenAI<\/mark> <span class="chip-title-fixation\b[^"]*">Do<\/span>cs/)
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
      chip: makeChip({ sourceType: 'bookmark', saved: true })
    })
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[1], /\bhover:bg-\[rgba\(82,82,82,0\.13\)\]/)
  assert.match(chipMatch[1], /:has\(\.chip-actions\):hover::after\]:opacity-100/)
  assert.match(chipMatch[1], /after:w-\[var\(--chip-hover-fade-width\)\]/)
  assert.match(chipMatch[1], /var\(--chip-hover-fade-bg\)_34%/)
  assert.doesNotMatch(chipMatch[1], /\bafter:transition-/)
  assert.doesNotMatch(chipMatch[1], /\bafter:duration-/)
  assert.doesNotMatch(chipMatch[1], /\bafter:ease-/)
  assert.match(html, /--chip-hover-fade-width:56px/)
})

test('PageChip renders a default favicon for live tabs without favIconUrl', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab', faviconUrl: '' })
    })
  )

  assert.match(html, /chip-favicon-frame/)
  assert.match(html, /default-favicon-image/)
  assert.match(html, /src="icons\/chrome-default-favicon-16\.png"/)
  assert.doesNotMatch(html, /<img class="chip-favicon\b/)
})

test('PageChip does not invent live-tab favicons for read-only chips', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'bookmark', faviconUrl: '' })
    })
  )

  assert.doesNotMatch(html, /default-favicon-image/)
})

test('PageChip exposes save action through a context menu for unsaved live tabs', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab' })
    })
  )

  assert.doesNotMatch(html, /chip-save/)
  assert.doesNotMatch(html, /icon-\[mingcute--star-line\]/)
  assert.doesNotMatch(html, /aria-label="Save page"/)
  assert.doesNotMatch(html, /aria-pressed="false"/)
  assert.doesNotMatch(html, /<div class="chip-actions\b/)
  assert.match(html, /--chip-hover-fade-width:0px/)
  assert.match(html, /aria-label="Close this tab"/)
})

test('PageChip renders the close action in the favicon slot', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab', faviconUrl: 'https://example.com/favicon.ico' })
    })
  )
  const faviconFrameMatch = html.match(/<span class="([^"]*\bchip-favicon-frame\b[^"]*)"/)
  const closeActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-close\b[^"]*)"/)

  assert.ok(faviconFrameMatch, 'favicon frame should render')
  assert.ok(closeActionMatch, 'close action should render')
  assert.match(html, /chip-favicon-frame[\s\S]*chip-close-favicon/)
  assert.match(faviconFrameMatch[1], /group\/favicon-frame/)
  assert.match(closeActionMatch[1], /\bchip-close-favicon\b/)
  assert.match(closeActionMatch[1], /\babsolute\b/)
  assert.match(closeActionMatch[1], /\bleft-1\/2\b/)
  assert.match(closeActionMatch[1], /group-hover\/favicon-frame:pointer-events-auto/)
  assert.match(closeActionMatch[1], /group-hover\/favicon-frame:opacity-100/)
  assert.doesNotMatch(closeActionMatch[1], /group-hover\/page-chip:opacity-100/)
  assert.doesNotMatch(closeActionMatch[1], /page-chip-context-menu-open/)
  assert.doesNotMatch(closeActionMatch[1], /page-chip-tooltip-open/)
  assert.match(html, /chip-favicon-content\b[^"]*group-hover\/favicon-frame:opacity-0/)
  assert.doesNotMatch(html, /chip-favicon-content\b[^"]*group-hover\/page-chip:opacity-0/)
  assert.doesNotMatch(html, /<div class="chip-actions\b/)

  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{closeActionLabel\}>/)
})

test('PageChip renders a favicon-slot close action without right-side actions', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'history', faviconUrl: '' })
    })
  )

  assert.match(html, /chip-favicon-frame[\s\S]*chip-close-favicon/)
  assert.match(html, /aria-label="Delete from history"/)
  assert.match(html, /--chip-hover-fade-width:0px/)
  assert.doesNotMatch(html, /<div class="chip-actions\b/)
})

test('PageChip renders saved open tabs with remove-saved in the context menu and close in the favicon slot', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'tab', saved: true, savedPageKey: 'https://openai.com/docs' })
    })
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const closeActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-close\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(closeActionMatch, 'close action should render')
  assert.match(html, /\bpage-chip-saved\b/)
  assertInstantActionClass(closeActionMatch[1])
  assert.doesNotMatch(html, /\bchip-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-pressed="true"/)
  assert.match(html, /aria-label="Close this tab"/)
})

test('PageChip renders saved bookmark chips as a read-only saved hint', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'bookmark', saved: true, savedPageKey: 'https://openai.com/docs' })
    })
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const savedHintMatch = html.match(/<span[^>]*class="([^"]*\bchip-saved-hint\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(savedHintMatch, 'read-only saved hint should render')
  assert.match(chipMatch[1], /\bpage-chip-saved\b/)
  assert.match(html, /icon-\[mingcute--star-fill\]/)
  assert.match(savedHintMatch[1], /group-hover\/page-chip:opacity-100/)
  assertInstantActionClass(savedHintMatch[1])
  assert.doesNotMatch(savedHintMatch[1], /(?:^|\s)pointer-events-auto(?:\s|$)/)
  assert.doesNotMatch(savedHintMatch[1], /(?:^|\s)opacity-100(?:\s|$)/)
  assert.doesNotMatch(html, /\bchip-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Close this tab"/)
})

test('PageChip renders closed saved pages muted with no close action', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageChip, {
      chip: makeChip({ sourceType: 'saved-page', saved: true, closedSaved: true, savedPageKey: 'https://openai.com/docs' })
    })
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[1], /\bpage-chip-saved\b/)
  assert.match(chipMatch[1], /\bpage-chip-saved-closed\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Close this tab"/)
  assert.match(html, /default-favicon-image/)
})

test('PageChip close animation collapses the measured row height', () => {
  const classNames = new Set<string>()
  const appendedNodes: Array<{ classList: { classes: string[] }; style: Record<string, string>; ariaHidden?: string }> = []
  const removedNodes: Array<unknown> = []
  const style = {
    maxHeight: '',
    overflow: '',
    paddingTop: '',
    paddingBottom: '',
    opacity: '',
    transformOrigin: '',
    transition: ''
  }
  let measured = 0
  let ghostMeasured = 0
  let layoutOptions: unknown = null
  let scheduledDelay = 0
  const chipEl = {
    classList: {
      add: (...names: string[]) => names.forEach((name) => classNames.add(name))
    },
    style,
    ownerDocument: {
      body: {
        appendChild: (node: { classList: { classes: string[] }; style: Record<string, string>; ariaHidden?: string }) => {
          appendedNodes.push(node)
        }
      }
    },
    cloneNode: () => ({
      classList: {
        classes: [] as string[],
        add(...names: string[]) {
          this.classes.push(...names)
        }
      },
      style: {} as Record<string, string>,
      getBoundingClientRect() {
        ghostMeasured += 1
      },
      setAttribute(name: string, value: string) {
        if (name === 'aria-hidden') this.ariaHidden = value
      },
      remove() {
        removedNodes.push(this)
      }
    }),
    getBoundingClientRect: () => {
      measured += 1
      return { left: 11.2, top: 22.8, width: 333.3, height: 37.4 }
    }
  }

  const started = startPageChipCloseAnimation(chipEl, (options) => {
    layoutOptions = options
  }, (handler, delay) => {
    scheduledDelay = delay
    handler()
    return 1
  })

  assert.equal(started, true)
  assert.equal(measured, 2)
  assert.equal(appendedNodes.length, 1)
  const [ghost] = appendedNodes
  assert.equal(ghostMeasured, 1)
  assert.equal(ghost?.ariaHidden, 'true')
  assert.equal(ghost?.style.position, 'fixed')
  assert.equal(ghost?.style.left, '11.2px')
  assert.equal(ghost?.style.top, '22.8px')
  assert.equal(ghost?.style.width, '333.3px')
  assert.equal(ghost?.style.height, '37.4px')
  assert.equal(ghost?.style.transformOrigin, 'top left')
  assert.match(ghost?.style.transition ?? '', new RegExp(`opacity ${PAGE_CHIP_CLOSE_ANIMATION_MS}ms`))
  assert.equal(ghost?.style.opacity, '0')
  assert.equal(ghost?.style.transform, 'scale(0.96)')
  assert.deepEqual(ghost?.classList.classes, ['page-chip-closing-ghost'])
  assert.equal(scheduledDelay, PAGE_CHIP_CLOSE_ANIMATION_MS + 80)
  assert.equal(removedNodes[0], ghost)
  assert.equal(style.maxHeight, '0px')
  assert.equal(style.overflow, 'hidden')
  assert.equal(style.paddingTop, '0px')
  assert.equal(style.paddingBottom, '0px')
  assert.equal(style.opacity, '0')
  assert.match(style.transition, new RegExp(`max-height ${PAGE_CHIP_CLOSE_ANIMATION_MS}ms`))
  assert.ok(classNames.has('closing'))
  assert.deepEqual(layoutOptions, { animate: true })
})

test('PageChip outlines matching live chips when an external row owns the match', () => {
  const chip = makeChip({
    tabUrl: 'https://example.com/docs',
    rawUrl: 'https://example.com/docs'
  })
  const historyHoverHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'history' } as Partial<DomainCardContextValue>
  )
  const workingSetHoverHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'working-set' } as Partial<DomainCardContextValue>
  )
  const selfHoverHtml = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    { activeHoverUrl: 'https://example.com/docs', activeHoverSource: 'chip' } as Partial<DomainCardContextValue>
  )
  const historyMatch = historyHoverHtml.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const workingSetMatch = workingSetHoverHtml.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)

  assert.ok(historyMatch, 'history-hover page chip should render')
  assert.ok(workingSetMatch, 'working-set-hover page chip should render')
  assert.ok(selfHoverMatch, 'self-hover page chip should render')
  assert.match(historyMatch[1], /\bpage-chip-hover-match\b/)
  assert.match(workingSetMatch[1], /\bpage-chip-hover-match\b/)
  assert.doesNotMatch(selfHoverMatch[1], /\bpage-chip-hover-match\b/)
})

test('PageChip renders same-title URL variants below one visible title', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"([^>]*)>/)
  const chipTextMatch = html.match(/<span class="([^"]*\bchip-text\b[^"]*)"/)
  const titleVariantShellMatch = html.match(/<span class="([^"]*\bchip-title-variant-shell\b[^"]*)"/)
  const titleVariantButtonMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant\b[^"]*)"/)
  const titleVariantActionsMatch = html.match(/<span class="([^"]*\bchip-title-variant-actions\b[^"]*)"/)
  const titleVariantActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant-action\b[^"]*)"/)
  assert.ok(chipMatch, 'page chip should render')
  assert.ok(chipTextMatch, 'chip text should render')
  assert.ok(titleVariantShellMatch, 'title variant shell should render')
  assert.ok(titleVariantButtonMatch, 'title variant button should render')
  assert.ok(titleVariantActionsMatch, 'title variant actions should render')
  assert.ok(titleVariantActionMatch, 'title variant action should render')
  assert.doesNotMatch(chipMatch[2], /tabIndex|tabindex/)
  assert.match(chipMatch[1], /hover:bg-\[rgba\(82,82,82,0\.05\)\]/)
  assert.doesNotMatch(chipMatch[1], /hover:bg-\[rgba\(82,82,82,0\.13\)\]/)
  assert.match(chipTextMatch[1], /\bmax-h-none\b/)
  assert.doesNotMatch(chipTextMatch[1], /max-h-\[calc\(4lh\)\]/)
  assert.match(html, /\bchip-title-variant-list\b/)
  assert.match(html, /\bchip-title-variant-list\b[^"]*\bw-full\b/)
  assert.match(html, /\bchip-title-variant-list\b[^"]*\bflex-col\b/)
  assert.match(html, /\bchip-title-variant-list\b[^"]*\bitems-stretch\b/)
  assert.doesNotMatch(html, /\bchip-title-variant-list\b[^"]*\bflex-wrap\b/)
  assert.match(titleVariantShellMatch[1], /\bw-full\b/)
  assert.match(titleVariantShellMatch[1], /pr-\[22px\]/)
  assert.doesNotMatch(titleVariantShellMatch[1], /pr-\[42px\]/)
  assert.match(titleVariantButtonMatch[1], /\bw-full\b/)
  assert.match(titleVariantActionsMatch[1], /\btop-0\b/)
  assert.match(titleVariantActionsMatch[1], /\bbottom-0\b/)
  assert.match(titleVariantActionsMatch[1], /\bmy-auto\b/)
  assert.match(titleVariantActionMatch[1], /size-\[19px\]/)
  assert.doesNotMatch(titleVariantActionMatch[1], /\bh-5\b/)
  assert.doesNotMatch(titleVariantActionMatch[1], /\bw-5\b/)
  assert.doesNotMatch(titleVariantActionMatch[1], /-translate-y-1\/2/)
  assert.match(titleVariantButtonMatch[1], /\bcursor-default\b/)
  assert.match(titleVariantButtonMatch[1], /group-hover\/page-chip:bg-\[rgba\(115,115,115,0\.1\)\]/)
  assert.match(titleVariantButtonMatch[1], /hover:bg-\[rgba\(82,82,82,0\.14\)\]/)
  assert.doesNotMatch(titleVariantButtonMatch[1], /\bcursor-pointer\b/)
  assert.doesNotMatch(html, /\bpage-chip-tooltip(?:\s|")/)
  assert.match(html, /…\?search_id=alpha/)
  assert.match(html, /…\?search_id=bravo/)
  assert.equal((html.match(/\bchip-title-row\b/g) || []).length, 1)
})

test('PageChip uses structured PageChip-style tooltips for same-title URL variants', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /function titleVariantChipTooltipContentNode\(\)/)
  assert.match(pageChipSource, /const titleVariantTitleTooltipTriggerElement = \(/)
  assert.match(pageChipSource, /const titleVariantChipTextContent = \(/)
  assert.match(pageChipSource, /isTitleVariantGroup\s*\?\s*titleVariantChipTooltipContentNode\(\)/)
  assert.match(pageChipSource, /if \(!isFolded && !isTitleVariantGroup\) return textEl/)
  assert.match(pageChipSource, /chipTooltipTextWidth && !isFolded && !isTitleVariantGroup && 'w-\[var\(--page-chip-tooltip-text-width\)\]'/)
  assert.match(pageChipSource, /isTitleVariantGroup \? titleVariantChipTextContent/)
  assert.doesNotMatch(pageChipSource, /function titleVariantTooltipContentNode/)
  assert.doesNotMatch(pageChipSource, /content=\{titleVariantTooltipContentNode\(variant, index\)\}/)
  assert.doesNotMatch(pageChipSource, /\bchip-title-variant-tooltip-url\b/)
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{titleVariantActionLabel\(variant\)\}>/)
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{variantLabel\}>/)
})

test('PageChip gives same-title URL variant groups a folded-style title tooltip trigger', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    suppressedTitleParts: ['Example Workspace'],
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const chipTextMatch = html.match(/<span class="([^"]*\bchip-text\b[^"]*)"[^>]*>/)
  const titleVariantContentMatch = html.match(/<span class="([^"]*\bchip-title-variant-content\b[^"]*)"/)
  const titleTooltipHitAreaMatch = html.match(/<span class="[^"]*\bchip-text-tooltip-hit-area\b[^"]*"[^>]*>/)
  const titleVariantButtonMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant\b[^"]*)"[^>]*>/)

  assert.ok(chipTextMatch, 'chip text should render')
  assert.ok(titleVariantContentMatch, 'title variant content should render')
  assert.ok(titleTooltipHitAreaMatch, 'title variant title tooltip trigger should render')
  assert.ok(titleVariantButtonMatch, 'title variant button should render')
  assert.doesNotMatch(chipTextMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(titleVariantContentMatch[1], /\bgap-0\.5\b/)
  assert.match(titleTooltipHitAreaMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(titleTooltipHitAreaMatch[0], /-my-\[5px\]/)
  assert.match(titleTooltipHitAreaMatch[0], /py-\[5px\]/)
  assert.doesNotMatch(titleVariantButtonMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(html, /chip-title-variant-content[\s\S]*chip-text-tooltip-hit-area[\s\S]*chip-title-row[\s\S]*chip-title-variant-list/)
})

test('PageChip tooltip popups click through to the matching chip target', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /async function onPageChipTooltipClick\(e: MouseEvent<HTMLDivElement>\) \{[\s\S]*await onFocus\(\)/)
  assert.match(pageChipSource, /onClick=\{parentInteractive \? onPageChipTooltipClick : undefined\}/)
  assert.match(pageChipSource, /onClick=\{onPageChipTooltipClick\}/)
  assert.doesNotMatch(pageChipSource, /onTitleVariantTooltipClick/)
  assert.match(pageChipSource, /page-chip-tooltip max-w-\[calc\(100vw-16px\)\] text-\[13px\] leading-tight \[overflow-wrap:break-word\] cursor-default select-none/)
})

test('PageChip routes saved-page mutation actions through Base UI context menus', () => {
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')

  assert.match(pageChipSource, /import \{\s*ContextMenu,\s*ContextMenuContent,\s*ContextMenuItem,\s*ContextMenuTrigger\s*\} from '\.\/ui\/context-menu'/)
  assert.match(pageChipSource, /function PageChipContextMenu\(/)
  assert.match(pageChipSource, /page-chip-context-menu-open/)
  assert.match(pageChipSource, /page-chip-tooltip-open/)
  assert.match(pageChipSource, /onOpenChange\?: \(open: boolean\) => void/)
  assert.match(pageChipSource, /PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS = 80/)
  assert.match(pageChipSource, /function handleOpenChange\(nextOpen: boolean\)/)
  assert.match(pageChipSource, /const \[visualOpen, setVisualOpen\] = useState\(false\)/)
  assert.match(pageChipSource, /window\.setTimeout\(\(\) => \{[\s\S]*setVisualOpen\(false\)[\s\S]*PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS/)
  assert.match(pageChipSource, /const trigger = visualOpen/)
  assert.match(pageChipSource, /<ContextMenu onOpenChange=\{handleOpenChange\}>/)
  assert.match(pageChipSource, /<ContextMenuTrigger render=\{trigger\} \/>/)
  assert.match(pageChipSource, /contextMenuOpenRef\.current/)
  assert.match(pageChipSource, /if \(contextMenuOpenRef\.current\) return/)
  assert.match(pageChipSource, /\[\&\.page-chip-context-menu-open\]:bg-\[rgba\(82,82,82,0\.13\)\]/)
  assert.match(pageChipSource, /\[\&\.page-chip-tooltip-open\]:bg-\[rgba\(82,82,82,0\.13\)\]/)
  assert.match(pageChipSource, /onOpenChange=\{setChipTooltipOpen\}/)
  assert.match(pageChipSource, /group-\[\.page-chip-context-menu-open\]\/page-chip:opacity-100/)
  assert.match(pageChipSource, /group-\[\.page-chip-tooltip-open\]\/page-chip:opacity-100/)
  assert.match(pageChipSource, /className="page-chip-save-menu-item"/)
  assert.match(pageChipSource, /className="page-chip-copy-title-menu-item"/)
  assert.match(pageChipSource, /SavedPageIcon saved=\{saved\} className="size-3\.5"/)
  assert.match(pageChipSource, /<svg className="icon-\[ooui--copy-ltr\] size-3\.5" aria-hidden="true" \/>/)
  assert.doesNotMatch(pageChipSource, /import \{ Copy, X \} from 'lucide-react'/)
  assert.match(pageChipSource, /Copy page title text/)
  assert.match(pageChipSource, /navigator\.clipboard\.writeText\(titleText\)/)
  assert.match(pageChipSource, /onClick=\{onSavedSelect\}/)
  assert.match(pageChipSource, /onClick=\{onCopyTitle\}/)
  assert.match(pageChipSource, /canToggleSavedEnv \? \([\s\S]*<PageChipContextMenu[\s\S]*onSavedSelect=\{\(e\) => onToggleSavedEnv\(e, env\)\}[\s\S]*titleText=\{envTitleText\}/)
  assert.match(pageChipSource, /variantCanToggleSaved \? \([\s\S]*<ContextMenu>[\s\S]*onSavedSelect=\{\(e\) => onToggleSavedTitleVariant\(e, variant\)\}[\s\S]*titleText=\{variantTitleText\}/)
  assert.match(pageChipSource, /canToggleSavedPage[\s\S]*<PageChipContextMenu[\s\S]*onSavedSelect=\{onToggleSavedPage\}[\s\S]*titleText=\{chipTitleText\}[\s\S]*onOpenChange=\{onChipContextMenuOpenChange\}/)
})

test('PageChip outlines same-title variant groups when external hover matches a variant URL', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    {
      activeHoverUrl: 'https://example.com/content/item?search_id=bravo',
      activeHoverSource: 'history'
    } as Partial<DomainCardContextValue>
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[1], /\bpage-chip-hover-match\b/)
})

test('PageChip keeps same-title URL variant saved-page actions in the context menu', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha',
        saved: true,
        savedPageKey: 'https://example.com/content/item?search_id=alpha'
      }),
      makeChip({
        sourceType: 'tab',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  const closeVariantActionMatch = html.match(/<button[^>]*class="([^"]*\bchip-title-variant-action\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.ok(closeVariantActionMatch, 'close title variant action should render')
  assert.doesNotMatch(chipMatch[1], /\bpage-chip-saved\b/)
  assert.equal((html.match(/\bchip-title-variant-save\b/g) || []).length, 0)
  assertInstantActionClass(closeVariantActionMatch[1])
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Save page"/)
  assert.equal((html.match(/\bchip-title-variant-action\b/g) || []).length, 2)
})

test('PageChip renders saved bookmark URL variants as read-only hints', () => {
  const chip = makeChip({
    sourceType: 'bookmark',
    tabUrl: 'https://example.com/content/item?search_id=alpha',
    rawUrl: 'https://example.com/content/item?search_id=alpha',
    displaySegments: ['Example content item'],
    tooltip: 'Example content item',
    titleVariantChips: [
      makeChip({
        sourceType: 'bookmark',
        tabUrl: 'https://example.com/content/item?search_id=alpha',
        rawUrl: 'https://example.com/content/item?search_id=alpha',
        pathSuffix: '…?search_id=alpha',
        tooltip: '…?search_id=alpha',
        saved: true,
        savedPageKey: 'https://example.com/content/item?search_id=alpha'
      }),
      makeChip({
        sourceType: 'bookmark',
        tabUrl: 'https://example.com/content/item?search_id=bravo',
        rawUrl: 'https://example.com/content/item?search_id=bravo',
        pathSuffix: '…?search_id=bravo',
        tooltip: '…?search_id=bravo'
      })
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const savedVariantHintMatch = html.match(/<span[^>]*class="([^"]*\bchip-title-variant-saved-hint\b[^"]*)"/)

  assert.ok(savedVariantHintMatch, 'read-only saved title variant hint should render')
  assertInstantActionClass(savedVariantHintMatch[1])
  assert.equal((html.match(/\bchip-title-variant-saved-hint\b/g) || []).length, 1)
  assert.doesNotMatch(html, /\bchip-title-variant-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /\bchip-title-variant-action\b/)
})

test('PageChip keeps folded env saved-page actions in the context menu', () => {
  const chip = makeChip({
    sourceType: 'tab',
    tabUrl: 'https://env-alpha.example.test/docs',
    rawUrl: 'https://env-alpha.example.test/docs',
    displaySegments: ['Example Docs'],
    tooltip: 'env-alpha · env-bravo · Example Docs',
    envs: [
      {
        prefix: 'env-alpha',
        tabUrl: 'https://env-alpha.example.test/docs',
        rawUrl: 'https://env-alpha.example.test/docs',
        sourceType: 'tab',
        saved: true,
        savedPageKey: 'https://env-alpha.example.test/docs',
        title: 'Example Docs',
        faviconUrl: ''
      },
      {
        prefix: 'env-bravo',
        tabUrl: 'https://env-bravo.example.test/docs',
        rawUrl: 'https://env-bravo.example.test/docs',
        sourceType: 'tab',
        title: 'Example Docs',
        faviconUrl: ''
      }
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))

  assert.equal((html.match(/\bchip-env-save\b/g) || []).length, 0)
  assert.match(html, /\bchip-env-shell\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /aria-label="Save page"/)
  assert.doesNotMatch(html, /\bchip-save\b/)
})

test('PageChip renders saved bookmark folded env pills as read-only hints', () => {
  const chip = makeChip({
    sourceType: 'bookmark',
    tabUrl: 'https://env-alpha.example.test/docs',
    rawUrl: 'https://env-alpha.example.test/docs',
    displaySegments: ['Example Docs'],
    tooltip: 'env-alpha · env-bravo · Example Docs',
    envs: [
      {
        prefix: 'env-alpha',
        tabUrl: 'https://env-alpha.example.test/docs',
        rawUrl: 'https://env-alpha.example.test/docs',
        sourceType: 'bookmark',
        saved: true,
        savedPageKey: 'https://env-alpha.example.test/docs',
        title: 'Example Docs',
        faviconUrl: ''
      },
      {
        prefix: 'env-bravo',
        tabUrl: 'https://env-bravo.example.test/docs',
        rawUrl: 'https://env-bravo.example.test/docs',
        sourceType: 'bookmark',
        title: 'Example Docs',
        faviconUrl: ''
      }
    ]
  })

  const html = renderWithDomainCardContext(React.createElement(PageChip, { chip }))
  const savedEnvHintMatch = html.match(/<span[^>]*class="([^"]*\bchip-env-saved-hint\b[^"]*)"/)

  assert.ok(savedEnvHintMatch, 'read-only saved env hint should render')
  assertInstantActionClass(savedEnvHintMatch[1])
  assert.equal((html.match(/\bchip-env-saved-hint\b/g) || []).length, 1)
  assert.doesNotMatch(html, /\bchip-env-save\b/)
  assert.doesNotMatch(html, /aria-label="Remove saved page"/)
  assert.doesNotMatch(html, /\bchip-save\b/)
})

test('PageChip matches working set hover against raw tab URLs', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fdocs'
  const chip = makeChip({
    tabUrl: 'https://example.com/docs',
    rawUrl
  })
  const html = renderWithDomainCardContext(
    React.createElement(PageChip, { chip }),
    {
      activeHoverUrl: 'https://example.com/preview',
      activeHoverUrls: [rawUrl],
      activeHoverSource: 'working-set'
    } as Partial<DomainCardContextValue>
  )
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)

  assert.ok(chipMatch, 'page chip should render')
  assert.match(chipMatch[1], /\bpage-chip-hover-match\b/)
})

test('Overflow expander outlines when external hover matches a hidden chip', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fhidden'
  const hiddenChip = makeChip({
    tabUrl: 'https://example.com/hidden',
    rawUrl
  })
  const visibleChip = makeChip({
    tabUrl: 'https://example.com/visible',
    rawUrl: 'https://example.com/visible'
  })
  const renderOverflow = (context: Partial<DomainCardContextValue>) => renderWithDomainCardContext(
    React.createElement(FlatSection, {
      visibleChips: [visibleChip],
      hiddenChips: [hiddenChip],
      hiddenCount: 1
    }),
    context
  )
  const overflowClass = (html: string) => {
    const match = html.match(/<button[^>]*class="([^"]*\bpage-chip-overflow\b[^"]*)"/)
    assert.ok(match, 'overflow expander button should render')
    return match[1]
  }
  const historyMatch = overflowClass(renderOverflow({
    activeHoverUrl: 'https://example.com/hidden',
    activeHoverSource: 'history'
  }))
  const workingSetRawMatch = overflowClass(renderOverflow({
    activeHoverUrl: 'https://example.com/preview',
    activeHoverUrls: [rawUrl],
    activeHoverSource: 'working-set'
  }))
  const chipSelfMatch = overflowClass(renderOverflow({
    activeHoverUrl: 'https://example.com/hidden',
    activeHoverSource: 'chip'
  }))

  assert.match(historyMatch, /\bpage-chip-overflow-hover-match\b/)
  assert.match(workingSetRawMatch, /\bpage-chip-overflow-hover-match\b/)
  assert.doesNotMatch(chipSelfMatch, /\bpage-chip-overflow-hover-match\b/)
})

test('TabHistoryPanel outlines matching history rows when another source owns the match', () => {
  const snapshot = makeHistorySnapshot()
  const chipHoverHtml = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      activeHoverUrl: 'https://example.com/docs',
      activeHoverSource: 'chip'
    })
  )
  const workingSetHoverHtml = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      activeHoverUrl: 'https://example.com/docs',
      activeHoverSource: 'working-set'
    })
  )
  const selfHoverHtml = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      activeHoverUrl: 'https://example.com/docs',
      activeHoverSource: 'history'
    })
  )
  const chipHoverMatch = chipHoverHtml.match(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)
  const workingSetHoverMatch = workingSetHoverHtml.match(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)
  const selfHoverMatch = selfHoverHtml.match(/<div class="([^"]*\bhistory-entry group\/history-entry\b[^"]*)"/)

  assert.ok(chipHoverMatch, 'chip-hover history entry should render')
  assert.ok(workingSetHoverMatch, 'working-set-hover history entry should render')
  assert.ok(selfHoverMatch, 'self-hover history entry should render')
  assert.match(chipHoverMatch[1], /\bhistory-entry-hover-match\b/)
  assert.match(workingSetHoverMatch[1], /\bhistory-entry-hover-match\b/)
  assert.doesNotMatch(selfHoverMatch[1], /\bhistory-entry-hover-match\b/)
})

test('TabHistoryPanel matches chip hover against raw tab URLs without changing the preview URL', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fdocs'
  const snapshot = makeHistorySnapshot({
    entries: [
      {
        ...makeHistorySnapshot().entries[0],
        url: 'https://example.com/docs',
        rawUrl,
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

test('TabHistoryPanel reuses shared page-target matching for suspended history rows', () => {
  const rawUrl = 'chrome-extension://suspender/suspended.html#uri=https%3A%2F%2Fexample.com%2Fdocs'
  const snapshot = makeHistorySnapshot({
    entries: [
      {
        ...makeHistorySnapshot().entries[0],
        url: 'https://example.com/docs',
        rawUrl,
        displayUrl: 'example.com/docs'
      }
    ]
  })
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot,
      activeHoverUrl: rawUrl,
      activeHoverUrls: [rawUrl],
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
  const entryButtonMatch = html.match(/<div role="button" tabindex="0" aria-disabled="false" class="([^"]*\bhistory-entry-main\b[^"]*)"/)

  assert.ok(entryButtonMatch, 'history entry focus target should render')
  assert.match(entryButtonMatch[1], /\bcursor-default\b/)
  assert.doesNotMatch(entryButtonMatch[1], /\bcursor-pointer\b/)
})

test('TabHistoryPanel renders the close action in the favicon slot', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        entries: [
          {
            ...baseEntry,
            favIconUrl: 'https://example.com/favicon.ico'
          }
        ]
      })
    })
  )
  const faviconFrameMatch = html.match(/<span class="([^"]*\bhistory-entry-favicon-frame\b[^"]*)"/)
  const closeActionMatch = html.match(/<button[^>]*class="([^"]*\bhistory-entry-close\b[^"]*)"/)

  assert.ok(faviconFrameMatch, 'history entry favicon frame should render')
  assert.ok(closeActionMatch, 'history entry close action should render')
  assert.match(html, /history-entry-favicon-frame[\s\S]*history-entry-close-favicon/)
  assert.match(faviconFrameMatch[1], /group\/history-favicon-frame/)
  assert.match(closeActionMatch[1], /\bhistory-entry-close-favicon\b/)
  assert.match(closeActionMatch[1], /\babsolute\b/)
  assert.match(closeActionMatch[1], /\bleft-1\/2\b/)
  assert.match(closeActionMatch[1], /group-hover\/history-favicon-frame:pointer-events-auto/)
  assert.match(closeActionMatch[1], /group-hover\/history-favicon-frame:opacity-100/)
  assert.doesNotMatch(closeActionMatch[1], /group-hover\/history-row:opacity-100/)
  assert.match(html, /history-entry-favicon-content\b[^"]*group-hover\/history-favicon-frame:opacity-0/)

  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(tabHistoryPanelSource, /<TooltipAnchor content="Close this tab">/)
})

test('TabHistoryPanel uses PageChip-style fade truncation and expanded title tooltips', () => {
  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  assert.match(tabHistoryPanelSource, /titleEl\.scrollHeight - titleEl\.clientHeight > 1/)
  assert.match(tabHistoryPanelSource, /getHistoryTitleContentWidth/)
  assert.match(tabHistoryPanelSource, /getHistoryTitleTooltipLineHtml/)
  assert.match(tabHistoryPanelSource, /historyTitleTooltipLineMarkup/)
  assert.match(tabHistoryPanelSource, /historyTitleTooltipLineNodesFromHtml/)
  assert.match(tabHistoryPanelSource, /tooltipViewportConstrained/)
  assert.match(tabHistoryPanelSource, /visibleLineCount/)
  assert.match(tabHistoryPanelSource, /history-entry-title block min-w-0 flex-auto overflow-hidden hyphens-auto break-normal max-h-\[calc\(2lh\)\]/)
  assert.match(tabHistoryPanelSource, /\[\&\.history-entry-title-truncated\]:\[mask-image:linear-gradient\(to_bottom,black_0,black_calc\(100%_-_1lh\),transparent_calc\(100%_-_1lh\)\),linear-gradient\(to_right,black_0,black_calc\(100%_-_60px\),rgba\(0,0,0,0\.35\)_calc\(100%_-_20px\),transparent\)\]/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-title line-clamp-2/)
  assert.doesNotMatch(tabHistoryPanelSource, /history-entry-title-tooltip line-clamp-2/)
  assert.match(tabHistoryPanelSource, /--history-entry-title-tooltip-text-width/)
  assert.match(tabHistoryPanelSource, /w-\[var\(--history-entry-title-tooltip-text-width\)\]/)
  assert.match(tabHistoryPanelSource, /titleTooltipTargetTextWidth/)
  assert.match(tabHistoryPanelSource, /titleTooltipTextWidth \+ HISTORY_TITLE_TOOLTIP_HORIZONTAL_PADDING_PX/)
  assert.match(tabHistoryPanelSource, /roundHistoryTitleTooltipToDevicePixel/)
  assert.match(tabHistoryPanelSource, /getHistoryTitleTooltipSubpixelOffset/)
  assert.match(tabHistoryPanelSource, /historyTitleTooltipSubpixelOffset/)
  assert.match(tabHistoryPanelSource, /translate3d\(\$\{titleMetrics\.tooltipSubpixelOffset\.x\}px, \$\{titleMetrics\.tooltipSubpixelOffset\.y\}px, 0\)/)
  assert.match(tabHistoryPanelSource, /const \[titleTooltipOpen, setTitleTooltipOpen\] = useState\(false\)/)
  assert.match(tabHistoryPanelSource, /titleTooltipOpen && 'history-entry-tooltip-open'/)
  assert.match(tabHistoryPanelSource, /titleTooltipOpen && 'history-entry-row-tooltip-open'/)
  assert.match(tabHistoryPanelSource, /history-entry-low-score opacity-60 hover:opacity-100 focus-within:opacity-100 \[\&\.history-entry-row-tooltip-open\]:opacity-100/)
  assert.match(tabHistoryPanelSource, /group-\[\.history-entry-row-tooltip-open\]\/history-row:text-\[rgba\(115,115,115,0\.54\)\]/)
  assert.match(tabHistoryPanelSource, /function onHistoryTitleTooltipClick\(e: MouseEvent<HTMLDivElement>\)/)
  assert.match(tabHistoryPanelSource, /className="history-entry-title-tooltip max-w-\[calc\(100vw-16px\)\] text-\[13px\] leading-tight \[overflow-wrap:break-word\] cursor-default select-none"/)
  assert.match(tabHistoryPanelSource, /onClick=\{onHistoryTitleTooltipClick\}/)
  assert.match(tabHistoryPanelSource, /history-entry-title-tooltip-hit-area/)
  assert.match(tabHistoryPanelSource, /\[\&\.history-entry-tooltip-open\]:bg-\[rgba\(82,82,82,0\.13\)\]/)
  assert.match(tabHistoryPanelSource, /\[\&\.history-entry-tooltip-open\]:bg-\[rgba\(82,82,82,0\.18\)\]/)
  assert.match(tabHistoryPanelSource, /onOpenChange=\{setTitleTooltipOpen\}/)
  assert.match(tabHistoryPanelSource, /history-entry-title-tooltip-line-tail/)
  assert.doesNotMatch(tabHistoryPanelSource, /\[text-wrap:balance\]/)
  assert.doesNotMatch(tabHistoryPanelSource, /\[width:max-content\]/)
  assert.match(tabHistoryPanelSource, /function getHistoryTitleTooltipAnchor\(\)/)
  assert.match(tabHistoryPanelSource, /anchorToCursor=\{false\}/)
  assert.match(tabHistoryPanelSource, /sideOffset=\{0\}/)
  assert.match(tabHistoryPanelSource, /alignOffset=\{0\}/)
  assert.match(tabHistoryPanelSource, /after:w-0/)
  assert.doesNotMatch(tabHistoryPanelSource, /after:w-14/)
})

test('TabHistoryPanel applies bionic title emphasis with protected title tokens', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        entries: [
          {
            ...baseEntry,
            title: 'The API and UX of Checkout Flow',
            url: 'https://example.com/checkout',
            displayUrl: 'example.com/checkout'
          }
        ]
      })
    })
  )

  assert.match(html, /history-entry-title[\s\S]*The API and UX of <span class="chip-title-fixation\b[^"]*">Chec<\/span>kout <span class="chip-title-fixation\b[^"]*">Fl<\/span>ow/)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>The</)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>API</)
  assert.doesNotMatch(html, /chip-title-fixation\b[^>]*>UX</)
})

test('TabHistoryPanel marks working-set history matches and dims low-score history rows', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 101,
        currentIndex: 0,
        entries: [
          baseEntry,
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            active: false,
            cursor: false,
            current: false,
            title: 'Older Entry',
            url: 'https://example.com/older',
            displayUrl: 'example.com/older'
          }
        ]
      }),
      workingSet: makeWorkingSetSnapshot()
    })
  )

  assert.match(html, /history-entry-working-set-match/)
  assert.doesNotMatch(html, /history-working-set-rail/)
  assert.match(html, /history-entry-low-score/)
  assert.doesNotMatch(html, /history-working-set-extra-list/)
})

test('TabHistoryPanel gives highlighted history indexes stronger contrast', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        activeTabId: 101,
        currentIndex: 0,
        entries: [
          baseEntry,
          {
            ...baseEntry,
            index: 1,
            tabId: 202,
            active: false,
            cursor: false,
            current: false,
            title: 'Older Entry',
            url: 'https://example.com/older',
            displayUrl: 'example.com/older'
          }
        ]
      })
    })
  )
  const indexClasses = Array.from(html.matchAll(/<span class="([^"]*\bhistory-entry-index-(?:highlight|muted)\b[^"]*)"/g)).map((match) => match[1])

  assert.equal(indexClasses.filter((className) => className.includes('history-entry-index-highlight')).length, 1)
  assert.equal(indexClasses.filter((className) => className.includes('history-entry-index-muted')).length, 1)
  assert.match(indexClasses.find((className) => className.includes('history-entry-index-highlight')) || '', /font-semibold/)
  assert.match(indexClasses.find((className) => className.includes('history-entry-index-muted')) || '', /text-\[rgba\(115,115,115,0\.42\)\]/)
})

test('TabHistoryPanel always dims browser utility history rows', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        stackSize: 4,
        activeTabId: 301,
        currentIndex: 0,
        entries: [
          {
            ...baseEntry,
            title: 'Chrome Settings',
            url: 'chrome://settings/',
            displayUrl: 'chrome://settings/'
          },
          {
            ...baseEntry,
            index: 1,
            tabId: 302,
            active: false,
            cursor: false,
            current: false,
            title: 'New Tab',
            url: 'chrome://newtab/',
            displayUrl: 'chrome://newtab/'
          },
          {
            ...baseEntry,
            index: 2,
            tabId: 303,
            active: false,
            cursor: false,
            current: false,
            title: 'Tab Out',
            url: 'chrome-extension://tab-out/index.html?filter=docs',
            displayUrl: 'Tab Out'
          },
          {
            ...baseEntry,
            index: 3,
            tabId: 304,
            active: false,
            cursor: false,
            current: false,
            title: 'Chrome New Tab Frame',
            url: 'chrome-search://local-ntp/local-ntp.html',
            displayUrl: 'chrome-search://local-ntp/local-ntp.html'
          }
        ]
      })
    })
  )
  const lowScoreRows = Array.from(html.matchAll(/<div class="([^"]*\bhistory-entry-row\b[^"]*\bhistory-entry-low-score\b[^"]*)"/g))

  assert.equal(lowScoreRows.length, 4)
})

test('TabHistoryPanel always dims standalone app history rows', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        entries: [
          {
            ...baseEntry,
            title: 'Standalone App',
            url: 'https://app.example.com/',
            displayUrl: 'app.example.com',
            isApp: true
          }
        ]
      })
    })
  )

  assert.match(html, /history-entry-low-score/)
})

test('TabHistoryPanel does not dim suspended real pages as extension utility rows', () => {
  const baseEntry = makeHistorySnapshot().entries[0]
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot({
        entries: [
          {
            ...baseEntry,
            title: 'Suspended Docs',
            url: 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs',
            displayUrl: 'example.com/docs'
          }
        ]
      })
    })
  )

  assert.doesNotMatch(html, /history-entry-low-score/)
})

test('TabHistoryPanel appends only non-overlapping working-set items below history', () => {
  const html = renderToStaticMarkup(
    React.createElement(TabHistoryPanel as React.ComponentType<any>, {
      snapshot: makeHistorySnapshot(),
      workingSet: makeWorkingSetSnapshot({
        items: [
          makeWorkingSetSnapshot().items[0],
          {
            key: 'https://example.com/extra',
            tabId: 202,
            windowId: 1,
            tabUrl: 'https://example.com/extra',
            rawUrl: 'https://example.com/extra',
            title: 'Extra Candidate',
            displayUrl: 'example.com/extra',
            faviconUrl: '',
            dupeCount: 1,
            active: false,
            activeInOtherWindow: false,
            score: 80
          }
        ]
      })
    })
  )
  const extraRows = Array.from(html.matchAll(/<div class="([^"]*\bhistory-entry-row\b[^"]*\bhistory-working-set-extra\b[^"]*)"/g))
  const extraListMatch = html.match(/<div class="([^"]*\bhistory-working-set-extra-list\b[^"]*)"/)

  assert.ok(extraListMatch, 'supplemental working set list should render')
  assert.doesNotMatch(extraListMatch[1], /\bmt-1\b/)
  assert.match(extraListMatch[1], /\bborder-t\b/)
  assert.match(extraListMatch[1], /\bpt-1\.5\b/)
  assert.equal(extraRows.length, 1)
  assert.match(html, /Ext<\/span>ra[\s\S]*Cand<\/span>idate/)
  assert.match(html, /default-favicon-image/)
  assert.doesNotMatch(html, /Close Extra Candidate/)
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
  assert.match(defaultEntry, /\bborder-0\b/)
  assert.match(defaultEntry, /\bbg-transparent\b/)
  assert.match(defaultEntry, /rounded-\[10px\]/)
  assert.match(defaultEntry, /group-hover\/history-row:bg-\[rgba\(82,82,82,0\.13\)\]/)
  assert.match(defaultEntry, /group-hover\/history-row:after:opacity-100/)
  assert.doesNotMatch(defaultEntry, /group-hover\/history-row:border-\[var\(--accent-amber\)\]/)
  assert.doesNotMatch(defaultEntry, /\bbg-tab-card\b/)
  assert.doesNotMatch(defaultEntry, /bg-\[rgba\(115,115,115,0\.04\)\]/)
  assert.match(currentEntry, /\bcurrent-active-history-entry\b/)
  assert.match(currentEntry, /\bborder-0\b/)
  assert.doesNotMatch(currentEntry, /\bborder-transparent\b/)
  assert.match(currentEntry, /\bbg-neutral-100\b/)
  assert.match(currentEntry, /\bring-neutral-400\b/)
  assert.doesNotMatch(currentEntry, /group-hover\/history-row:border-\[var\(--accent-amber\)\]/)
  assert.doesNotMatch(currentEntry, /\bgroup-hover\/history-row:bg-\[rgba\(82,82,82,0\.13\)\]\b/)
  assert.doesNotMatch(currentEntry, /group-hover\/history-row:after:opacity-100/)
  assert.match(currentEntry, /shadow-\[0_1px_2px_rgba\(10,10,10,0\.07\)\]/)
  assert.doesNotMatch(currentEntry, /inset_0_0_0_1px_rgba\(82,82,82,0\.48\)/)
  assert.match(currentEntry, /\[--history-entry-fade-bg:var\(--color-neutral-100\)\]/)
  assert.match(html, /current-active-history-entry-frame\b[^"]*shadow-\[inset_0_0_0_1px_rgba\(82,82,82,0\.48\)\]/)

  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(tabHistoryPanelSource, /<TooltipAnchor content="Close this tab">/)
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
  assert.match(activeOtherEntry, /\bborder-0\b/)
  assert.doesNotMatch(activeOtherEntry, /\bborder-\[rgba\(115,115,115,0\.2\)\]/)
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
  const match = styleSource.match(/\.page-chip\.page-chip-hover-match,\n\.page-chip-overflow\.page-chip-overflow-hover-match,\n\.history-entry\.history-entry-hover-match,\n\.working-set-item\.working-set-item-hover-match\s*\{([^}]*)\}/)

  assert.ok(match, 'cross-surface hover match rule should exist')
  assert.match(match[1], /outline:\s*1px solid var\(--accent-amber\);/)
  assert.match(match[1], /outline-offset:\s*1px;/)
  assert.doesNotMatch(match[1], /\b(?:background|box-shadow|border):/)
})

test('domain card frames itself when a history hover highlights one of its chips', () => {
  const styleSource = readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8')
  const match = styleSource.match(/\.domain-block:has\(\.page-chip\.page-chip-hover-match\) > \.mission-card,\n\.domain-block:has\(\.page-chip-overflow\.page-chip-overflow-hover-match\) > \.mission-card\s*\{([^}]*)\}/)

  assert.ok(match, 'domain card hover match rule should exist')
  assert.match(match[1], /border-color:\s*color-mix\(in srgb, var\(--accent-amber\) 42%, var\(--warm-gray\)\);/)
  assert.doesNotMatch(match[1], /\bbox-shadow:/)
  assert.doesNotMatch(match[1], /\btransition:/)
  assert.doesNotMatch(match[1], /\bbackground:/)
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

  assert.match(html, /<mark class="chip-filter-match\b[^"]*">Pull Request<\/mark> <span class="chip-title-fixation\b[^"]*">rev<\/span>iew/)
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
  assert.match(html, /chip-title-suppression-glyph\b/)
  assert.doesNotMatch(html, />˷<\/span>/)
  assert.match(html, /Suppressed title text: Example Workspace/)
  assert.doesNotMatch(html, /chip-title-suppression-marker[^>]* title=/)
  const chipMatch = html.match(/<div class="[^"]*\bpage-chip\b[^"]*"[^>]*>/)
  assert.ok(chipMatch, 'page chip should render')
  assert.doesNotMatch(chipMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextMatch = html.match(/<span class="chip-text(?:\s|")[^>]*>/)
  assert.ok(chipTextMatch, 'chip text should render')
  assert.doesNotMatch(chipTextMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextTooltipHitAreaMatch = html.match(/<span class="[^"]*\bchip-text-tooltip-hit-area\b[^"]*"[^>]*>/)
  assert.ok(chipTextTooltipHitAreaMatch, 'chip text tooltip hit area should render')
  assert.match(chipTextTooltipHitAreaMatch[0], /data-slot="tooltip-trigger"/)
  assert.match(chipTextTooltipHitAreaMatch[0], /-my-\[5px\]/)
  assert.match(chipTextTooltipHitAreaMatch[0], /py-\[5px\]/)
  const markerMatch = html.match(/<span class="([^"]*\bchip-title-suppression-marker\b[^"]*)"/)
  assert.ok(markerMatch, 'title suppression marker should render')
  assert.match(markerMatch[1], /(?:^|\s)h-\[14px\](?:\s|$)/)
  assert.match(markerMatch[1], /(?:^|\s)min-w-\[14px\](?:\s|$)/)
  assert.match(markerMatch[1], /\bshrink-0\b/)
  assert.match(markerMatch[1], /(?:^|\s)text-\[12px\](?:\s|$)/)
  assert.match(markerMatch[1], /(?:^|\s)leading-\[12px\](?:\s|$)/)
  assert.match(markerMatch[1], /\balign-middle\b/)
  assert.doesNotMatch(markerMatch[1], /(?:^|\s)text-\[10px\](?:\s|$)/)
  assert.doesNotMatch(markerMatch[1], /\bfont-medium\b/)
  assert.doesNotMatch(markerMatch[1], /\bfont-semibold\b/)
  const markerElementMatch = html.match(/<span class="[^"]*\bchip-title-suppression-marker\b[^"]*"[^>]*>/)
  assert.ok(markerElementMatch, 'title suppression marker element should render')
  assert.doesNotMatch(markerElementMatch[0], /data-slot="tooltip-trigger"/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /const shouldShowChipTooltip = chip\.iconOnly \|\| isTextTruncated \|\| hasTitleSuppressionMarkers \|\| hasStructuralPlaceholders/)
  assert.match(pageChipSource, /PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = 'chip-title-suppression-marker inline rounded-lg border-0[\s\S]*text-\[12px\][\s\S]*leading-\[inherit\][\s\S]*align-baseline/)
  assert.match(pageChipSource, /PAGE_CHIP_TOOLTIP_SUPPRESSION_MARKER_CLASS_NAME = [\s\S]*\[box-decoration-break:clone\]/)
  assert.match(pageChipSource, /hydrateClonedChipTooltipFragment\(document, fragment\)/)
  assert.match(pageChipSource, /hiddenTitleText = label\.replace\(\//)
  assert.match(pageChipSource, /highlightedTextNodes\(part, highlightTerms/)
  assert.doesNotMatch(pageChipSource, /title-suppression-marker-tooltip/)
})

test('PageChip tooltip keeps whitespace before trailing suppression labels', () => {
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
  assert.match(html, /<span class="chip-title-fixation\b[^"]*">Alp<\/span>ha <span class="chip-title-fixation\b[^"]*">cha<\/span>nnel — [\s\S]*chip-title-suppression-marker[\s\S]*chip-title-suppression-glyph[\s\S]* — [\s\S]*chip-strip-indicator[\s\S]*>\/<\/span>/)
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
  assert.match(stripMatch[1], /\binline-flex\b/)
  assert.match(stripMatch[1], /\bsize-4\b/)
  assert.match(stripMatch[1], /\brounded-full\b/)
  assert.doesNotMatch(stripMatch[1], /\[corner-shape:squircle\]/)
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
  assert.doesNotMatch(chipMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextMatch = html.match(/<span class="chip-text(?:\s|")[^>]*>/)
  assert.ok(chipTextMatch, 'chip text should render')
  assert.doesNotMatch(chipTextMatch[0], /data-slot="tooltip-trigger"/)
  const chipTextTooltipHitAreaMatch = html.match(/<span class="[^"]*\bchip-text-tooltip-hit-area\b[^"]*"[^>]*>/)
  assert.ok(chipTextTooltipHitAreaMatch, 'chip text tooltip hit area should render')
  assert.match(chipTextTooltipHitAreaMatch[0], /data-slot="tooltip-trigger"/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /mode === 'tooltip' && hiddenLabel/)
  assert.match(pageChipSource, /chip-strip-indicator inline-block max-w-full/)
  assert.match(pageChipSource, /highlightedTextNodes\(hiddenLabel, highlightTerms/)
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
  assert.match(html, /<span class="chip-title-fixation\b[^"]*">Ope<\/span>nAI <span class="chip-title-fixation\b[^"]*">Do<\/span>cs\s+<span class="[^"]*\bchip-path\b[^"]*">\/docs\/reference<\/span>/)
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
  assert.match(html, /chip-title-row\b[^>]*>[\s\S]*<span class="chip-title-fixation\b[^"]*">Deplo<\/span>yment <span class="chip-title-fixation\b[^"]*">His<\/span>tory[\s\S]*chip-env-row\b[^>]*>[\s\S]*dev1us[\s\S]*dev2us/)
  assert.equal([...html.matchAll(/chip-title-suppression-marker/g)].length, 2)
  const chipMatch = html.match(/<div class="([^"]*\bpage-chip\b[^"]*)"/)
  assert.ok(chipMatch, 'folded page chip should render')
  assert.match(chipMatch[1], /\bpage-chip-folded\b/)
  assert.match(chipMatch[1], /\bcursor-default\b/)
  assert.doesNotMatch(chipMatch[1], /\bclickable\b/)
  assert.doesNotMatch(chipMatch[1], /\bcursor-pointer\b/)
  assert.match(chipMatch[1], /hover:bg-\[rgba\(82,82,82,0\.05\)\]/)
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
  assert.match(envButtonMatch[1], /\bcursor-default\b/)
  assert.doesNotMatch(envButtonMatch[1], /\bcursor-pointer\b/)
  assert.match(envButtonMatch[1], /\bhover:bg/)
  assert.match(envButtonMatch[1], /\bfocus-visible:outline/)
  const pageChipSource = readFileSync(new URL('../src/components/PageChip.tsx', import.meta.url), 'utf8')
  assert.match(pageChipSource, /chipTooltipTextWidth && !isFolded && !isTitleVariantGroup && 'w-\[var\(--page-chip-tooltip-text-width\)\]'/)
  assert.doesNotMatch(pageChipSource, /<TooltipAnchor content=\{envLabel\}>/)
  const foldedTooltipSource = pageChipSource.match(/function foldedChipTooltipContentNode\(\) \{[\s\S]*?\n  \}\n\n  const chipTooltipContent/)
  assert.ok(foldedTooltipSource, 'folded tooltip content renderer should exist')
  assert.doesNotMatch(foldedTooltipSource[0], /chip-env-row/)
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

  assert.match(html, /website-path-section-label\b[^>]*>\/document<\/span>[\s\S]*<span class="chip-title-fixation\b[^"]*">Exa<\/span>mple <span class="chip-title-fixation\b[^"]*">Sp<\/span>ec/)
  assert.match(html, /website-path-section-label\b[^>]*>\/spreadsheets<\/span>[\s\S]*<span class="chip-title-fixation\b[^"]*">Exa<\/span>mple <span class="chip-title-fixation\b[^"]*">Bud<\/span>get/)
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

test('DomainCard renders the public suffix as less prominent title text', () => {
  const group: DomainGroup = {
    domain: 'example.co.uk',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-example-co-uk',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )

  assert.match(html, /<span class="domain-title-name">example<\/span>/)
  assert.match(html, /<span class="domain-title-suffix[^"]*\bfont-semibold\b[^"]*\btext-tab-muted\b[^"]*\bopacity-75\b[^"]*">\.co\.uk<\/span>/)
  assert.match(html, /<span class="mission-name[^"]*font-black[^"]*"/)
  assert.doesNotMatch(html, /domain-title-subdomain/)
})

test('DomainCard inlines a single non-port subdomain into the title', () => {
  const group: DomainGroup = {
    domain: 'example.com',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-example-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    singleSubdomainKey: 'docs',
    singleSubdomainIsPort: false,
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )

  assert.match(html, /<span class="domain-title-subdomain[^"]*\bfont-semibold\b[^"]*\btext-tab-muted\b[^"]*\bopacity-85\b[^"]*">docs\.<\/span>/)
  assert.match(html, /<span class="domain-title-name">example<\/span>/)
  assert.match(html, /<span class="domain-title-suffix[^"]*">\.com<\/span>/)
  assert.doesNotMatch(html, /\bmission-subdomain\b/)
})

test('DomainCard keeps a single localhost port in the subdomain pill', () => {
  const group: DomainGroup = {
    domain: 'localhost',
    tabs: []
  }
  const vm: DashboardCardVM = {
    stableId: 'domain-localhost',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '1',
    singleSubdomainKey: '3001',
    singleSubdomainIsPort: true,
    sections: []
  }

  const html = renderToStaticMarkup(
    React.createElement(DomainCard, {
      group,
      vm
    })
  )

  assert.doesNotMatch(html, /domain-title-subdomain/)
  assert.match(html, /<span class="mission-name[^"]*">localhost<\/span>/)
  assert.match(html, /<span class="[^"]*\bmission-subdomain\b[^"]*before:content-\[[^"]*:[^"]*\][^"]*">3001<\/span>/)
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
