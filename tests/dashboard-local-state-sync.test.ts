import assert from 'node:assert/strict'
import test from 'node:test'
import { DOMAIN_PIN_STORAGE_KEY } from '../src/extension/domain-pins.js'
import {
  pageChipPinId,
  pageChipPinKeyForUrl,
  pageChipPinScopeId,
  PAGE_CHIP_PIN_STORAGE_KEY
} from '../src/extension/page-chip-pins.js'
import { SECTION_PIN_STORAGE_KEY } from '../src/extension/section-pins.js'
import {
  reconcileDashboardLocalStateStorageChanges,
  type DashboardLocalState
} from '../src/hooks/useDashboardLocalState.js'

const PAGE_ALPHA = pageChipPinId(
  'tabs',
  pageChipPinScopeId('example.test', '', '', ''),
  pageChipPinKeyForUrl('https://example.test/alpha')
)
const PAGE_BRAVO = pageChipPinId(
  'tabs',
  pageChipPinScopeId('example.test', '', '', ''),
  pageChipPinKeyForUrl('https://example.test/bravo')
)

const CURRENT_STATE: DashboardLocalState = {
  loaded: true,
  pinnedDomains: ['example.test', 'local-intent.test'],
  pinnedSectionIds: ['section-alpha'],
  pinnedPageChipIds: [PAGE_ALPHA]
}

test('storage pin reconciliation preserves in-flight optimistic state while rebasing persisted values', () => {
  const result = reconcileDashboardLocalStateStorageChanges(
    CURRENT_STATE,
    {
      [DOMAIN_PIN_STORAGE_KEY]: {
        oldValue: ['example.test'],
        newValue: ['example.test', 'external.test']
      },
      [PAGE_CHIP_PIN_STORAGE_KEY]: {
        oldValue: [PAGE_ALPHA],
        newValue: [PAGE_BRAVO]
      }
    },
    {
      pinnedDomains: true,
      pinnedSectionIds: false,
      pinnedPageChipIds: false
    }
  )

  assert.ok(result)
  assert.deepEqual(result.nextState, {
    ...CURRENT_STATE,
    pinnedPageChipIds: [PAGE_BRAVO]
  })
  assert.deepEqual(result.persistedValues, {
    pinnedDomains: ['example.test', 'external.test'],
    pinnedPageChipIds: [PAGE_BRAVO]
  })
  assert.deepEqual(result.appliedKeys, ['pinnedPageChipIds'])
})

test('storage pin reconciliation applies external changes and treats removed keys as empty lists', () => {
  const result = reconcileDashboardLocalStateStorageChanges(
    CURRENT_STATE,
    {
      [DOMAIN_PIN_STORAGE_KEY]: {
        oldValue: CURRENT_STATE.pinnedDomains,
        newValue: ['external.test']
      },
      [SECTION_PIN_STORAGE_KEY]: {
        oldValue: CURRENT_STATE.pinnedSectionIds,
        newValue: undefined
      }
    },
    {
      pinnedDomains: false,
      pinnedSectionIds: false,
      pinnedPageChipIds: false
    }
  )

  assert.ok(result)
  assert.deepEqual(result.nextState, {
    ...CURRENT_STATE,
    pinnedDomains: ['external.test'],
    pinnedSectionIds: []
  })
  assert.deepEqual(result.persistedValues, {
    pinnedDomains: ['external.test'],
    pinnedSectionIds: []
  })
  assert.deepEqual(result.appliedKeys, ['pinnedDomains', 'pinnedSectionIds'])
})
