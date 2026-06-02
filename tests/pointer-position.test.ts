import assert from 'node:assert/strict'
import test from 'node:test'

import { pointWithinRect } from '../src/components/pointer-position.js'

test('pointWithinRect treats the rect bounds as inclusive', () => {
  const rect = { left: 10, right: 50, top: 20, bottom: 40 }
  assert.equal(pointWithinRect({ x: 30, y: 30 }, rect), true)
  assert.equal(pointWithinRect({ x: 10, y: 20 }, rect), true)
  assert.equal(pointWithinRect({ x: 50, y: 40 }, rect), true)
})

test('pointWithinRect rejects points outside the rect or with no rect', () => {
  const rect = { left: 10, right: 50, top: 20, bottom: 40 }
  assert.equal(pointWithinRect({ x: 9, y: 30 }, rect), false)
  assert.equal(pointWithinRect({ x: 30, y: 41 }, rect), false)
  assert.equal(pointWithinRect({ x: 30, y: 30 }, null), false)
  assert.equal(pointWithinRect({ x: 30, y: 30 }, undefined), false)
})
