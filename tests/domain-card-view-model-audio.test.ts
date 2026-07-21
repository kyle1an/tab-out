import assert from 'node:assert/strict'
import test from 'node:test'

import { dashboardChipFor, makeDashboardTab } from './helpers/domain-card-view-model.js'

test('chip audioState is playing for an audible unmuted tab', () => {
  const chip = dashboardChipFor([makeDashboardTab({ url: 'https://example.com/a', audible: true })], 'https://example.com/a')
  assert.equal(chip?.audioState, 'playing')
})

test('chip audioState is muted for a muted tab', () => {
  const chip = dashboardChipFor([makeDashboardTab({ url: 'https://example.com/b', audible: true, muted: true })], 'https://example.com/b')
  assert.equal(chip?.audioState, 'muted')
})

test('chip audioState is null for a silent tab', () => {
  const chip = dashboardChipFor([makeDashboardTab({ url: 'https://example.com/c' })], 'https://example.com/c')
  assert.equal(chip?.audioState, null)
})
