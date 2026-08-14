import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildUrlVariantPresentationGroups,
  buildUrlVariantPresentations,
} from '../src/extension/url-variant-presentation.js'

function labelsFor(urls: readonly string[]): string[] {
  return buildUrlVariantPresentations(urls).map((presentation) => presentation.label)
}

test('URL variant presentation prefers the differing path segments', () => {
  assert.deepEqual(
    labelsFor([
      'https://example.test/team/dashboard',
      'https://example.test/me/dashboard',
    ]),
    ['/team', '/me'],
  )
})

test('URL variant presentation keeps short semantic query values readable', () => {
  assert.deepEqual(
    labelsFor([
      'https://example.test/content/item?state=open',
      'https://example.test/content/item?state=closed',
    ]),
    ['…?state=open', '…?state=closed'],
  )
})

test('URL variant presentation uses the root marker when only a sibling has a query', () => {
  assert.deepEqual(
    labelsFor([
      'https://example.test/content/item',
      'https://example.test/content/item?state=open',
    ]),
    ['/', '…?state=open'],
  )
})

test('URL variant presentation fingerprints long opaque query values', () => {
  const urls = Array.from(
    { length: 14 },
    (_, index) => `https://accounts.example.test/content/item?TL=${String(index + 1).padStart(2, '0')}abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ`,
  )
  const presentations = buildUrlVariantPresentations(urls)
  const labels = presentations.map((presentation) => presentation.label)

  assert.deepEqual(presentations.map((presentation) => presentation.exactUrl), urls)
  assert.equal(new Set(labels).size, urls.length)
  assert.ok(labels.every((label) => /^…\?TL=…[0-9A-Z]{7}$/.test(label)), labels.join('\n'))
  assert.ok(labels.every((label) => label.length <= 64), labels.join('\n'))
  assert.ok(labels.every((label) => !label.includes('abcdefghijklmnopqrstuvwxyz')), labels.join('\n'))
})

test('URL variant presentation groups collapse opaque value families without losing exact targets', () => {
  const urls = Array.from(
    { length: 14 },
    (_, index) => `https://accounts.example.test/content/item?TL=${String(index + 1).padStart(2, '0')}abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ`,
  )

  const groups = buildUrlVariantPresentationGroups(urls, { collapseOpaqueValues: true })

  assert.deepEqual(groups, [{
    label: '…?TL=…',
    targetIndexes: urls.map((_, index) => index),
  }])
})

test('URL variant presentation groups collapse colon-separated OAuth values', () => {
  const urls = [
    'https://accounts.example.test/o/oauth2/start?session=alpha-session:12345678901234567890',
    'https://accounts.example.test/o/oauth2/start?session=bravo-session:12345678901234567890',
  ]

  assert.deepEqual(
    buildUrlVariantPresentationGroups(urls, { collapseOpaqueValues: true }),
    [{ label: '…?session=…', targetIndexes: [0, 1] }],
  )
})

test('URL variant presentation groups preserve short semantic query distinctions', () => {
  const urls = [
    'https://example.test/content/item?state=open',
    'https://example.test/content/item?state=closed',
  ]

  assert.deepEqual(
    buildUrlVariantPresentationGroups(urls, { collapseOpaqueValues: true }),
    [
      { label: '…?state=open', targetIndexes: [0] },
      { label: '…?state=closed', targetIndexes: [1] },
    ],
  )
})

test('URL variant presentation groups preserve long word-like query distinctions', () => {
  const urls = [
    'https://example.test/content/item?state=production-europe-west-region',
    'https://example.test/content/item?state=staging-europe-west-region',
  ]

  assert.deepEqual(
    buildUrlVariantPresentationGroups(urls, { collapseOpaqueValues: true }),
    [
      { label: '…?state=production-europe-west-region', targetIndexes: [0] },
      { label: '…?state=staging-europe-west-region', targetIndexes: [1] },
    ],
  )
})

test('URL variant presentation groups preserve repeated exact URL occurrences', () => {
  const repeatedUrl = 'https://example.test/content/item?state=open'

  assert.deepEqual(
    buildUrlVariantPresentationGroups([
      repeatedUrl,
      'https://example.test/content/item?state=closed',
      repeatedUrl,
    ]),
    [
      { label: '…?state=open', targetIndexes: [0] },
      { label: '…?state=closed', targetIndexes: [1] },
      { label: '…?state=open', targetIndexes: [2] },
    ],
  )
})

test('URL variant presentation keeps opaque values fingerprinted when hosts disambiguate', () => {
  const opaqueValue = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const labels = labelsFor([
    `https://one.example.test/content/item?TL=${opaqueValue}`,
    `https://two.example.test/content/item?TL=${opaqueValue}`,
  ])

  assert.equal(new Set(labels).size, 2)
  assert.ok(labels.every((label) => label.includes('?TL=…')), labels.join('\n'))
  assert.ok(labels.every((label) => !label.includes(opaqueValue)), labels.join('\n'))
  assert.ok(labels.every((label) => label.length <= 64), labels.join('\n'))
})

test('URL variant presentation remains stable when callers reorder the same URLs', () => {
  const urls = [
    'https://example.test/content/item?opaque_token=alpha0123456789abcdefghijklmnopqrstuvwxyz',
    'https://example.test/content/item?opaque_token=bravo0123456789abcdefghijklmnopqrstuvwxyz',
    'https://example.test/content/item?opaque_token=charlie0123456789abcdefghijklmnopqrstuvwxyz',
  ]
  const forward = new Map(buildUrlVariantPresentations(urls).map(({ exactUrl, label }) => [exactUrl, label]))
  const reversed = new Map(buildUrlVariantPresentations(urls.toReversed()).map(({ exactUrl, label }) => [exactUrl, label]))

  assert.deepEqual(reversed, forward)
})

test('URL variant presentation keeps trailing-slash variants distinguishable', () => {
  assert.deepEqual(
    labelsFor([
      'https://example.test/jira/your-work',
      'https://example.test/jira/your-work/',
    ]),
    ['/jira/your-work', '/jira/your-work/'],
  )
})

test('URL variant presentation falls back to exact invalid values without losing identity', () => {
  const urls = ['not a URL alpha', 'not a URL bravo']
  const presentations = buildUrlVariantPresentations(urls)

  assert.deepEqual(presentations.map((presentation) => presentation.exactUrl), urls)
  assert.equal(new Set(presentations.map((presentation) => presentation.label)).size, urls.length)
})
