import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { allocateCardSuppressionTones, createTitleSuppressionToneScope, titleSuppressionToneForIndex } from '../src/extension/title-suppression-tones.js'
import type { DashboardSectionVM } from '../src/extension/types'

const part = (text: string, count = 1, spansRenderedChildGroups = false) => ({ text, count, spansRenderedChildGroups })

function section(overrides: Partial<DashboardSectionVM>): DashboardSectionVM {
  return {
    key: 's',
    sectionCount: 0,
    sectionClosableUrls: [],
    showHeader: false,
    isShared: false,
    hasFlat: false,
    flatVisibleChips: [],
    flatHiddenChips: [],
    flatHiddenCount: 0,
    clusters: [],
    websitePathSections: [],
    ...overrides
  }
}

const cluster = (key: string, parts: ReturnType<typeof part>[]) => ({
  key,
  label: key,
  isPR: false,
  count: 0,
  closableUrls: [],
  suppressedTitleParts: parts,
  visibleChips: [],
  hiddenChips: [],
  hiddenCount: 0
})

test('dashboard types depend on title-suppression data types, not the allocator module', () => {
  const dashboardTypesSource = readFileSync(new URL('../src/extension/types.d.ts', import.meta.url), 'utf8')
  const allocatorSource = readFileSync(new URL('../src/extension/title-suppression-tones.ts', import.meta.url), 'utf8')

  assert.match(dashboardTypesSource, /from '\.\/title-suppression-types\.js'/)
  assert.doesNotMatch(dashboardTypesSource, /from '\.\/title-suppression-tones\.js'/)
  assert.match(allocatorSource, /from '\.\/title-suppression-types\.js'/)
})

test('tones are allocated by token coverage before summary position', () => {
  const scope = createTitleSuppressionToneScope([part('alpha', 1), part('beta', 5)])

  assert.equal(scope.useSuppressionTokenTones, true)
  assert.equal(scope.suppressedTitleToneIndexByText['beta'], 0)
  assert.equal(scope.suppressedTitleToneIndexByText['alpha'], 1)
  assert.equal(scope.suppressedTitleToneByText['beta'], 'amber')
  assert.equal(scope.suppressedTitleToneByText['alpha'], 'teal')
})

test('equal coverage keeps summary reading order', () => {
  const scope = createTitleSuppressionToneScope([part('zeta', 2), part('alpha', 2)])

  assert.equal(scope.suppressedTitleToneIndexByText['zeta'], 0)
  assert.equal(scope.suppressedTitleToneIndexByText['alpha'], 1)
})

test('a neutral single-token scope consumes no palette color', () => {
  const scope = createTitleSuppressionToneScope([part('solo')])

  assert.equal(scope.useSuppressionTokenTones, false)
  assert.equal(scope.usedToneCount, 0)
  assert.equal(scope.suppressedTitleToneByText['solo'], '')
})

test('a single token spanning rendered child groups keeps its tone', () => {
  const scope = createTitleSuppressionToneScope([part('spanner', 3, true)])

  assert.equal(scope.useSuppressionTokenTones, true)
  assert.equal(scope.usedToneCount, 1)
  assert.equal(scope.suppressedTitleToneByText['spanner'], 'amber')
})

test('palette colors are reused only after the four tones are exhausted', () => {
  const scope = createTitleSuppressionToneScope([part('a', 5), part('b', 4), part('c', 3), part('d', 2), part('e', 1)])

  assert.equal(scope.suppressedTitleToneByText['a'], 'amber')
  assert.equal(scope.suppressedTitleToneByText['e'], titleSuppressionToneForIndex(4))
  assert.equal(scope.suppressedTitleToneByText['e'], 'amber')
  assert.notEqual(scope.suppressedTitleToneByText['b'], scope.suppressedTitleToneByText['c'])
})

test('allocation is deterministic for identical inputs', () => {
  const parts = [part('one', 2), part('two', 2), part('three', 1)]
  const first = createTitleSuppressionToneScope(parts)
  const second = createTitleSuppressionToneScope(parts)

  assert.deepEqual(Object.entries(first.suppressedTitleToneByText), Object.entries(second.suppressedTitleToneByText))
})

test('one running tone index walks the card tree so meanings never share a color early', () => {
  const sections: DashboardSectionVM[] = [
    section({ key: 'neutral', suppressedTitleParts: [part('quiet')] }),
    section({
      key: 'busy',
      suppressedTitleParts: [part('x', 2), part('y', 1)],
      clusters: [cluster('pg', [part('deep', 1, true)])]
    })
  ]

  const { cardSuppressionToneScope, sections: toned } = allocateCardSuppressionTones([part('card-a', 3), part('card-b', 1)], sections)

  assert.equal(cardSuppressionToneScope.suppressedTitleToneByText['card-a'], 'amber')
  assert.equal(cardSuppressionToneScope.suppressedTitleToneByText['card-b'], 'teal')

  const neutral = toned[0]!
  assert.equal(neutral.titleSuppressionToneScope?.usedToneCount, 0)
  assert.equal(neutral.suppressedTitleToneByText?.['quiet'], '')

  const busy = toned[1]!
  assert.equal(busy.titleSuppressionToneScope?.suppressedTitleToneByText['x'], 'sky')
  assert.equal(busy.titleSuppressionToneScope?.suppressedTitleToneByText['y'], 'rose')

  const pathGroup = busy.clusters[0]!
  assert.equal(pathGroup.titleSuppressionToneScope?.suppressedTitleToneByText['deep'], titleSuppressionToneForIndex(4))

  // The merged map carries every ancestor tone down to chip markers.
  assert.equal(pathGroup.suppressedTitleToneByText?.['card-a'], 'amber')
  assert.equal(pathGroup.suppressedTitleToneByText?.['x'], 'sky')
  assert.equal(pathGroup.suppressedTitleToneByText?.['deep'], 'amber')
})

test('a child scope overrides an ancestor tone for the same token text', () => {
  const sections: DashboardSectionVM[] = [
    section({ key: 'child', suppressedTitleParts: [part('shared', 1), part('other', 1)] })
  ]

  const { cardSuppressionToneScope, sections: toned } = allocateCardSuppressionTones([part('shared', 2), part('card-only', 1)], sections)

  assert.equal(cardSuppressionToneScope.suppressedTitleToneByText['shared'], 'amber')
  assert.equal(toned[0]!.suppressedTitleToneByText?.['shared'], 'sky')
  assert.equal(toned[0]!.suppressedTitleToneByText?.['card-only'], 'teal')
})
