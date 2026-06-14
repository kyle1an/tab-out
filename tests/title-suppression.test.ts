import assert from 'node:assert/strict'
import test from 'node:test'

import { titleSuppressionCloseLabel, titleSuppressionSuspendLabel } from '../src/components/title-suppression.js'

test('titleSuppressionCloseLabel pluralizes the tab count', () => {
  assert.equal(titleSuppressionCloseLabel(1), 'Close 1 tab')
  assert.equal(titleSuppressionCloseLabel(2), 'Close 2 tabs')
  assert.equal(titleSuppressionCloseLabel(0), 'Close 0 tabs')
})

test('titleSuppressionSuspendLabel pluralizes the tab count', () => {
  assert.equal(titleSuppressionSuspendLabel(1), 'Suspend 1 tab')
  assert.equal(titleSuppressionSuspendLabel(2), 'Suspend 2 tabs')
  assert.equal(titleSuppressionSuspendLabel(0), 'Suspend 0 tabs')
})
