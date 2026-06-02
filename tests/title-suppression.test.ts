import assert from 'node:assert/strict'
import test from 'node:test'

import { titleSuppressionCloseLabel } from '../src/components/title-suppression.js'

test('titleSuppressionCloseLabel pluralizes the tab count', () => {
  assert.equal(titleSuppressionCloseLabel(1), 'Close 1 tab')
  assert.equal(titleSuppressionCloseLabel(2), 'Close 2 tabs')
  assert.equal(titleSuppressionCloseLabel(0), 'Close 0 tabs')
})
