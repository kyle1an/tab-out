import assert from 'node:assert/strict'
import test from 'node:test'

import { chipCanShowSuspend, chipSuspendableTargetCount } from '../src/components/chip-suspend-targets.js'

test('chipCanShowSuspend: live single tab true; non-tab/closed-saved sources false', () => {
  assert.equal(chipCanShowSuspend({ sourceType: 'tab', tabUrl: 'https://a', rawUrl: 'https://a' }), true)
  assert.equal(chipCanShowSuspend({ sourceType: 'bookmark', tabUrl: 'https://a', rawUrl: 'https://a' }), false)
  assert.equal(chipCanShowSuspend({ sourceType: 'saved-page', tabUrl: 'https://a', rawUrl: 'https://a' }), false)
  assert.equal(chipCanShowSuspend({ sourceType: 'tab', closedSaved: true, tabUrl: 'https://a', rawUrl: 'https://a' }), false)
})

test('chipCanShowSuspend: folded group with tab envs true; title-variant group false', () => {
  assert.equal(chipCanShowSuspend({
    sourceType: 'tab', tabUrl: 'https://a', rawUrl: 'https://a',
    envs: [{ sourceType: 'tab', tabUrl: 'https://e1', rawUrl: 'https://e1' }]
  }), true)
  assert.equal(chipCanShowSuspend({
    sourceType: 'tab', tabUrl: 'https://a', rawUrl: 'https://a',
    titleVariantChips: [{}, {}]
  }), false)
})

test('chipSuspendableTargetCount: counts live, non-suspended tabs only', () => {
  assert.equal(chipSuspendableTargetCount({ sourceType: 'tab', tabUrl: 'https://a', rawUrl: 'https://a' }), 1)
  assert.equal(chipSuspendableTargetCount({
    sourceType: 'tab', tabUrl: 'https://a',
    rawUrl: 'chrome-extension://x/suspended.html#uri=https://a'
  }), 0)
  assert.equal(chipSuspendableTargetCount({ sourceType: 'bookmark', tabUrl: 'https://a', rawUrl: 'https://a' }), 0)
})

test('chipSuspendableTargetCount: folded group counts live envs, skips already-suspended', () => {
  assert.equal(chipSuspendableTargetCount({
    sourceType: 'tab', tabUrl: 'https://a', rawUrl: 'https://a',
    envs: [
      { sourceType: 'tab', tabUrl: 'https://e1', rawUrl: 'https://e1' },
      { sourceType: 'tab', tabUrl: 'https://e2', rawUrl: 'https://e2' },
      { sourceType: 'tab', tabUrl: 'https://e3', rawUrl: 'chrome-extension://x/suspended.html#uri=https://e3' }
    ]
  }), 2)
})
