import assert from 'node:assert/strict'
import test from 'node:test'

import { searchExpandedWidth } from '../src/components/title-expansion/index.js'

function thresholdFits(threshold: number) {
  const calls: number[] = []
  const fits = (width: number) => {
    calls.push(width)
    return width >= threshold
  }
  return { calls, fits }
}

test('returns the lower bound unconstrained when it already fits', () => {
  const { calls, fits } = thresholdFits(100)

  const result = searchExpandedWidth({ lowerBound: 240.567, maxContentWidth: 500, steps: 12, fits })

  assert.deepEqual(result, { viewportConstrained: false, width: 240.57 })
  assert.deepEqual(calls, [240.567])
})

test('reports viewport-constrained at the max width when nothing fits', () => {
  const { calls, fits } = thresholdFits(Number.POSITIVE_INFINITY)

  const result = searchExpandedWidth({ lowerBound: 100, maxContentWidth: 480.125, steps: 12, fits })

  assert.deepEqual(result, { viewportConstrained: true, width: 480.13 })
  assert.deepEqual(calls, [100, 480.125])
})

test('binary search converges just above the fitting threshold', () => {
  const { fits } = thresholdFits(300.37)

  const result = searchExpandedWidth({ lowerBound: 100, maxContentWidth: 500, steps: 12, fits })

  assert.equal(result.viewportConstrained, false)
  assert.ok(result.width >= 300.37, `width ${result.width} under threshold`)
  assert.ok(result.width - 300.37 <= (500 - 100) / 2 ** 12 + 0.01, `width ${result.width} not converged`)
})

test('runs exactly the configured number of probe steps after the two bound checks', () => {
  const { calls, fits } = thresholdFits(300)

  searchExpandedWidth({ lowerBound: 100, maxContentWidth: 500, steps: 7, fits })

  assert.equal(calls.length, 2 + 7)
})

test('guard padding widens the converged width', () => {
  const { fits } = thresholdFits(300)

  const padded = searchExpandedWidth({ lowerBound: 100, maxContentWidth: 500, steps: 12, guardPx: 8, fits })
  const bare = searchExpandedWidth({ lowerBound: 100, maxContentWidth: 500, steps: 12, fits })

  assert.ok(Math.abs(padded.width - (bare.width + 8)) < 0.011, `${padded.width} is not ${bare.width} + 8`)
})

test('guard padding clamps at the max content width', () => {
  const { fits } = thresholdFits(499)

  const result = searchExpandedWidth({ lowerBound: 100, maxContentWidth: 500, steps: 12, guardPx: 8, fits })

  assert.equal(result.viewportConstrained, false)
  assert.equal(result.width, 500)
})

test('widths round to two decimals', () => {
  const { fits } = thresholdFits(0)

  const result = searchExpandedWidth({ lowerBound: 123.456789, maxContentWidth: 500, steps: 12, fits })

  assert.equal(result.width, 123.46)
})
