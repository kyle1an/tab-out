import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFilterResultCandidates,
  EMPTY_FILTER_RESULT_SELECTION,
  filterResultKeyboardIntent,
  reconcileFilterResultSelection,
  reconcileVisibleFilterResultSelection,
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

function cardWithChips(
  visibleChips: DashboardChipData[],
  hiddenChips: DashboardChipData[] = []
): DashboardCardEntry {
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
        sectionCount: visibleChips.length + hiddenChips.length,
        sectionClosableUrls: [],
        showHeader: false,
        isShared: false,
        hasFlat: true,
        flatVisibleChips: visibleChips,
        flatHiddenChips: hiddenChips,
        flatHiddenCount: hiddenChips.length,
        clusters: [],
        websitePathSections: []
      }]
    }
  }
}

function cardWithVisibleChips(visibleChips: DashboardChipData[]): DashboardCardEntry {
  return cardWithChips(visibleChips)
}

test('a committed query leaves result selection owned by the input', () => {
  assert.deepEqual(
    reconcileFilterResultSelection(EMPTY_FILTER_RESULT_SELECTION, 'example', candidates),
    {
      query: 'example',
      candidateKey: null,
      identity: null
    }
  )
})

test('editing a query returns an established result selection to the input', () => {
  const selected = selectAdjacentFilterResult(
    EMPTY_FILTER_RESULT_SELECTION,
    'example',
    candidates,
    'next'
  )

  assert.deepEqual(
    reconcileFilterResultSelection(selected, 'example updated', candidates),
    {
      query: 'example updated',
      candidateKey: null,
      identity: null
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

test('visible selection reconciliation probes only the still-selected candidate', () => {
  const current = selectAdjacentFilterResult(
    EMPTY_FILTER_RESULT_SELECTION,
    'example',
    candidates,
    'next'
  )
  const probedKeys: string[] = []

  const result = reconcileVisibleFilterResultSelection(
    current,
    'example',
    [
      candidates[0],
      candidates[1],
      {
        key: 'tab:charlie',
        identity: 'https://charlie.example.test/',
        domId: 'filter-result-charlie'
      }
    ],
    (candidate) => {
      probedKeys.push(candidate.key)
      return true
    }
  )

  assert.deepEqual(result.selection, current)
  assert.equal(result.candidate, candidates[0])
  assert.deepEqual(probedKeys, ['tab:alpha'])
})

test('visible selection reconciliation follows identity without probing unrelated candidates', () => {
  const replacementCandidates: FilterResultCandidate[] = [
    candidates[1],
    {
      key: 'history:alpha-hidden',
      identity: candidates[0].identity,
      domId: 'filter-result-alpha-hidden'
    },
    {
      key: 'tab:alpha-replacement',
      identity: candidates[0].identity,
      domId: 'filter-result-alpha-replacement'
    },
    {
      key: 'tab:charlie',
      identity: 'https://charlie.example.test/',
      domId: 'filter-result-charlie'
    }
  ]
  const probedKeys: string[] = []

  const result = reconcileVisibleFilterResultSelection(
    {
      query: 'example',
      candidateKey: 'history:alpha-removed',
      identity: candidates[0].identity
    },
    'example',
    replacementCandidates,
    (candidate) => {
      probedKeys.push(candidate.key)
      return candidate.key === 'tab:alpha-replacement'
    }
  )

  assert.deepEqual(result.selection, {
    query: 'example',
    candidateKey: 'tab:alpha-replacement',
    identity: candidates[0].identity
  })
  assert.equal(result.candidate, replacementCandidates[2])
  assert.deepEqual(probedKeys, ['history:alpha-hidden', 'tab:alpha-replacement'])
})

test('visible selection reconciliation leaves a new query owned by the input', () => {
  const fallbackCandidates: FilterResultCandidate[] = [
    {
      key: 'tab:collapsed',
      identity: 'https://collapsed.example.test/',
      domId: 'filter-result-collapsed'
    },
    candidates[0],
    candidates[1]
  ]
  const probedKeys: string[] = []

  const result = reconcileVisibleFilterResultSelection(
    EMPTY_FILTER_RESULT_SELECTION,
    'new query',
    fallbackCandidates,
    (candidate) => {
      probedKeys.push(candidate.key)
      return candidate.key !== 'tab:collapsed'
    }
  )

  assert.equal(result.candidate, undefined)
  assert.deepEqual(result.selection, {
    query: 'new query',
    candidateKey: null,
    identity: null
  })
  assert.deepEqual(probedKeys, [])
})

test('visible selection reconciliation stops at the first mounted fallback', () => {
  const fallbackCandidates: FilterResultCandidate[] = [
    {
      key: 'tab:collapsed',
      identity: 'https://collapsed.example.test/',
      domId: 'filter-result-collapsed'
    },
    candidates[0],
    candidates[1]
  ]
  const probedKeys: string[] = []

  const result = reconcileVisibleFilterResultSelection(
    {
      query: 'example',
      candidateKey: 'tab:removed',
      identity: 'https://removed.example.test/'
    },
    'example',
    fallbackCandidates,
    (candidate) => {
      probedKeys.push(candidate.key)
      return candidate.key !== 'tab:collapsed'
    }
  )

  assert.equal(result.candidate, candidates[0])
  assert.deepEqual(result.selection, {
    query: 'example',
    candidateKey: candidates[0].key,
    identity: candidates[0].identity
  })
  assert.deepEqual(probedKeys, ['tab:collapsed', 'tab:alpha'])
})

test('Arrow navigation moves through results and clamps at either end', () => {
  const inputOwned = reconcileFilterResultSelection(
    EMPTY_FILTER_RESULT_SELECTION,
    'example',
    candidates
  )
  const first = selectAdjacentFilterResult(inputOwned, 'example', candidates, 'next')
  const second = selectAdjacentFilterResult(first, 'example', candidates, 'next')
  const lastFromInput = selectAdjacentFilterResult(inputOwned, 'example', candidates, 'previous')

  assert.deepEqual(first, {
    query: 'example',
    candidateKey: 'tab:alpha',
    identity: 'https://alpha.example.test/'
  })
  assert.deepEqual(second, {
    query: 'example',
    candidateKey: 'tab:bravo',
    identity: 'https://bravo.example.test/'
  })
  assert.deepEqual(lastFromInput, second)
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
  const first = selectAdjacentFilterResult(
    EMPTY_FILTER_RESULT_SELECTION,
    'example',
    spatialCandidates,
    'next'
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
  const first = selectAdjacentFilterResult(EMPTY_FILTER_RESULT_SELECTION, 'example', candidates, 'next')
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

test('result candidates retain overflow targets so expansion can make them navigable', () => {
  const visible = chip({ tabUrl: 'https://overflow.example.test/visible' })
  const collapsed = chip({ tabUrl: 'https://overflow.example.test/collapsed' })

  const result = buildFilterResultCandidates({
    primaryMatches: [cardWithChips([visible], [collapsed])]
  })

  assert.deepEqual(
    result.map((candidate) => candidate.identity),
    [
      'https://overflow.example.test/visible',
      'https://overflow.example.test/collapsed'
    ]
  )
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
