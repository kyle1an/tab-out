import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFilterResultCandidates,
  EMPTY_FILTER_RESULT_SELECTION,
  filterResultKeyboardIntent,
  reconcileFilterResultSelection,
  selectAdjacentFilterResult,
  selectHorizontalFilterResult,
  type FilterResultCandidate,
  type PositionedFilterResultCandidate
} from '../src/extension/filter-result-navigation.js'
import type { DashboardCardEntry, DashboardChipData } from '../src/extension/types.js'

const candidates: FilterResultCandidate[] = [
  {
    key: 'tab:alpha',
    identity: 'https://alpha.example.test/',
    domId: 'filter-result-alpha'
  },
  {
    key: 'tab:bravo',
    identity: 'https://bravo.example.test/',
    domId: 'filter-result-bravo'
  }
]

function chip(overrides: Partial<DashboardChipData> & { tabUrl: string }): DashboardChipData {
  return {
    tabUrl: overrides.tabUrl,
    rawUrl: overrides.rawUrl ?? overrides.tabUrl,
    sourceType: overrides.sourceType ?? 'tab',
    leadPrefix: '',
    pathGroupLabel: '',
    displaySegments: [],
    suppressedTitleParts: [],
    pathSuffix: '',
    tooltip: overrides.tooltip ?? overrides.tabUrl,
    dupeCount: 1,
    faviconUrl: '',
    isGrouped: false,
    groupDotColor: null,
    isApp: false,
    envs: null,
    ...overrides
  }
}

function cardWithVisibleChips(visibleChips: DashboardChipData[]): DashboardCardEntry {
  return {
    group: {
      domain: 'example.test',
      tabs: []
    },
    vm: {
      stableId: 'domain-example-test',
      isHidden: false,
      displayMode: 'normal',
      filtering: true,
      sections: [{
        key: '',
        sectionCount: visibleChips.length,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: visibleChips,
        flatHiddenChips: [],
        flatHiddenCount: 0,
        clusters: [],
        websitePathSections: []
      }]
    }
  }
}

test('the first filter result is selected by default for a committed query', () => {
  assert.deepEqual(
    reconcileFilterResultSelection(EMPTY_FILTER_RESULT_SELECTION, 'example', candidates),
    {
      query: 'example',
      candidateKey: 'tab:alpha',
      identity: 'https://alpha.example.test/'
    }
  )
})

test('selection follows the same Dashboard Item Identity when its rendered candidate is replaced', () => {
  const current = {
    query: 'example',
    candidateKey: 'history:alpha',
    identity: 'https://alpha.example.test/'
  }
  const hydratedCandidates: FilterResultCandidate[] = [
    {
      key: 'tab:bravo',
      identity: 'https://bravo.example.test/',
      domId: 'filter-result-bravo'
    },
    {
      key: 'tab:alpha',
      identity: 'https://alpha.example.test/',
      domId: 'filter-result-alpha'
    }
  ]

  assert.deepEqual(
    reconcileFilterResultSelection(current, 'example', hydratedCandidates),
    {
      query: 'example',
      candidateKey: 'tab:alpha',
      identity: 'https://alpha.example.test/'
    }
  )
})

test('Arrow navigation moves through results and clamps at either end', () => {
  const first = reconcileFilterResultSelection(EMPTY_FILTER_RESULT_SELECTION, 'example', candidates)
  const second = selectAdjacentFilterResult(first, 'example', candidates, 'next')

  assert.deepEqual(second, {
    query: 'example',
    candidateKey: 'tab:bravo',
    identity: 'https://bravo.example.test/'
  })
  assert.deepEqual(selectAdjacentFilterResult(second, 'example', candidates, 'next'), second)
  assert.deepEqual(selectAdjacentFilterResult(first, 'example', candidates, 'previous'), first)
})

test('horizontal Arrow navigation follows rendered positions instead of result order', () => {
  const spatialCandidates: FilterResultCandidate[] = [
    candidates[0],
    candidates[1],
    {
      key: 'tab:charlie',
      identity: 'https://charlie.example.test/',
      domId: 'filter-result-charlie'
    }
  ]
  const positionedCandidates: PositionedFilterResultCandidate[] = [
    {
      candidate: spatialCandidates[0],
      rect: { left: 0, right: 100, top: 0, bottom: 40 }
    },
    {
      candidate: spatialCandidates[1],
      rect: { left: 0, right: 100, top: 60, bottom: 100 }
    },
    {
      candidate: spatialCandidates[2],
      rect: { left: 140, right: 240, top: 0, bottom: 40 }
    }
  ]
  const first = reconcileFilterResultSelection(
    EMPTY_FILTER_RESULT_SELECTION,
    'example',
    spatialCandidates
  )
  const right = selectHorizontalFilterResult(first, 'example', positionedCandidates, 'right')

  assert.deepEqual(right, {
    query: 'example',
    candidateKey: 'tab:charlie',
    identity: 'https://charlie.example.test/'
  })
  assert.deepEqual(
    selectHorizontalFilterResult(right, 'example', positionedCandidates, 'left'),
    first
  )
})

test('horizontal Arrow navigation keeps the current result at a spatial boundary', () => {
  const first = reconcileFilterResultSelection(EMPTY_FILTER_RESULT_SELECTION, 'example', candidates)
  const positionedCandidates: PositionedFilterResultCandidate[] = [
    {
      candidate: candidates[0],
      rect: { left: 0, right: 100, top: 0, bottom: 40 }
    },
    {
      candidate: candidates[1],
      rect: { left: 0, right: 100, top: 60, bottom: 100 }
    }
  ]

  assert.deepEqual(
    selectHorizontalFilterResult(first, 'example', positionedCandidates, 'left'),
    first
  )
})

test('result candidates follow source priority and expose exact folded and same-title targets', () => {
  const folded = chip({
    tabUrl: 'https://shared.example.test/docs',
    envs: [
      { prefix: 'dev', tabUrl: 'https://dev.example.test/docs', rawUrl: 'https://dev.example.test/docs' },
      { prefix: 'qa', tabUrl: 'https://qa.example.test/docs', rawUrl: 'https://qa.example.test/docs' }
    ]
  })
  const sameTitle = chip({
    tabUrl: 'https://variants.example.test/',
    titleVariantChips: [
      chip({ tabUrl: 'https://variants.example.test/alpha' }),
      chip({ tabUrl: 'https://variants.example.test/bravo' })
    ]
  })
  const history = chip({
    tabUrl: 'https://history.example.test/result',
    sourceType: 'history'
  })
  const bookmark = chip({
    tabUrl: 'https://bookmark.example.test/result',
    sourceType: 'bookmark'
  })

  const result = buildFilterResultCandidates({
    primaryMatches: [cardWithVisibleChips([folded, sameTitle])],
    historyMatches: [cardWithVisibleChips([history])],
    bookmarkMatches: [cardWithVisibleChips([bookmark])]
  })

  assert.deepEqual(
    result.map((candidate) => candidate.identity),
    [
      'https://dev.example.test/docs',
      'https://qa.example.test/docs',
      'https://variants.example.test/alpha',
      'https://variants.example.test/bravo',
      'https://history.example.test/result',
      'https://bookmark.example.test/result'
    ]
  )
  assert.equal(new Set(result.map((candidate) => candidate.key)).size, result.length)
})

test('filter keyboard intent recognizes navigation and activation without stealing IME input', () => {
  assert.equal(filterResultKeyboardIntent({ key: 'ArrowDown' }), 'next')
  assert.equal(filterResultKeyboardIntent({ key: 'ArrowUp' }), 'previous')
  assert.equal(filterResultKeyboardIntent({ key: 'ArrowLeft' }), 'left')
  assert.equal(filterResultKeyboardIntent({ key: 'ArrowRight' }), 'right')
  assert.equal(filterResultKeyboardIntent({ key: 'Enter', metaKey: true, shiftKey: true }), 'activate')
  assert.equal(filterResultKeyboardIntent({ key: 'Enter', isComposing: true }), null)
  assert.equal(filterResultKeyboardIntent({ key: 'Enter', altKey: true }), null)
  assert.equal(filterResultKeyboardIntent({ key: 'Escape' }), null)
})
