import assert from 'node:assert/strict'
import test from 'node:test'

import {
  foldedTabCloseTargets,
  historyDeleteFullyRemoved,
} from '../src/components/chip-close-targets.js'
import { groupCloseActionLabel } from '../src/extension/page-chip-target-policy.js'

test('foldedTabCloseTargets excludes closed Saved and retained envs in either display order', () => {
  const open = {
    prefix: 'open',
    tabUrl: 'https://open.example.test/page',
    rawUrl: 'https://open.example.test/page',
    sourceType: 'tab' as const,
  }
  const saved = {
    prefix: 'saved',
    tabUrl: 'https://saved.example.test/page',
    rawUrl: 'https://saved.example.test/page',
    sourceType: 'saved-page' as const,
    closedSaved: true,
  }
  const retained = {
    prefix: 'retained',
    tabUrl: 'https://retained.example.test/page',
    rawUrl: 'https://retained.example.test/page',
    sourceType: 'retained-page' as const,
    closedSaved: true,
  }

  assert.deepEqual(foldedTabCloseTargets([saved, open, retained]), [open])
  assert.deepEqual(foldedTabCloseTargets([open, retained, saved]), [open])
})

test('groupCloseActionLabel: singular labels match single-chip wording', () => {
  assert.equal(groupCloseActionLabel({ tabCount: 1, historyCount: 0 }), 'Close this tab')
  assert.equal(groupCloseActionLabel({ tabCount: 0, historyCount: 1 }), 'Delete from history')
})

test('groupCloseActionLabel: plural labels are count-aware', () => {
  assert.equal(groupCloseActionLabel({ tabCount: 3, historyCount: 0 }), 'Close 3 tabs')
  assert.equal(groupCloseActionLabel({ tabCount: 0, historyCount: 2 }), 'Delete 2 from history')
})

test('groupCloseActionLabel: mixed groups name both destructive operations', () => {
  assert.equal(groupCloseActionLabel({ tabCount: 1, historyCount: 1 }), 'Close 1 tab and delete 1 from history')
  assert.equal(groupCloseActionLabel({ tabCount: 2, historyCount: 3 }), 'Close 2 tabs and delete 3 from history')
})

test('historyDeleteFullyRemoved rejects partial history deletion', () => {
  assert.equal(historyDeleteFullyRemoved(2, { deletedCount: 2 }), true)
  assert.equal(historyDeleteFullyRemoved(2, { deletedCount: 1 }), false)
  assert.equal(historyDeleteFullyRemoved(2, null), false)
})
