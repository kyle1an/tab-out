import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalDedupeKey } from '../src/extension/url-canonical.js'

const longForm =
  'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention&page=com.atlassian.jira.plugin.system.issuetabpanels%3Acomment-tabpanel#comment-100'
const shortForm = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100&sourceType=mention'
const canonical = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=100'

test('the two Jira URL forms of the same comment produce the same key', () => {
  assert.equal(canonicalDedupeKey(longForm), canonical)
  assert.equal(canonicalDedupeKey(shortForm), canonical)
})

test('a hash-only comment link matches a focusedCommentId link', () => {
  const hashOnly = 'https://example.atlassian.net/browse/ABC-123#comment-100'
  assert.equal(canonicalDedupeKey(hashOnly), canonical)
})

test('different focused comments on the same issue stay distinct', () => {
  const other = 'https://example.atlassian.net/browse/ABC-123?focusedCommentId=200'
  assert.notEqual(canonicalDedupeKey(other), canonical)
})

test('an issue with no comment is distinct from one with a comment', () => {
  const noComment = 'https://example.atlassian.net/browse/ABC-123'
  assert.equal(canonicalDedupeKey(noComment), 'https://example.atlassian.net/browse/ABC-123')
  assert.notEqual(canonicalDedupeKey(noComment), canonical)
})

test('different issue keys stay distinct', () => {
  const other = 'https://example.atlassian.net/browse/XYZ-9?focusedCommentId=100'
  assert.notEqual(canonicalDedupeKey(other), canonical)
})

test('GitHub repository root trailing slashes collapse to the no-slash key', () => {
  const repository = 'https://github.com/example/repo'
  assert.equal(canonicalDedupeKey(repository), repository)
  assert.equal(canonicalDedupeKey(`${repository}/`), repository)
})

test('GitHub repository root canonicalization preserves query and hash identity', () => {
  const repository = 'https://github.com/example/repo'
  const canonicalVariant = `${repository}?tab=readme#example-section`
  assert.equal(canonicalDedupeKey(`${repository}/?tab=readme#example-section`), canonicalVariant)
  assert.notEqual(canonicalDedupeKey(`${repository}/?tab=issues#example-section`), canonicalVariant)
})

test('GitHub trailing-slash canonicalization stays scoped to repository roots', () => {
  const nestedRoute = 'https://github.com/example/repo/issues/'
  const reservedRoute = 'https://github.com/settings/profile/'
  assert.equal(canonicalDedupeKey(nestedRoute), nestedRoute)
  assert.equal(canonicalDedupeKey(reservedRoute), reservedRoute)
})

test('non-Jira URLs are returned unchanged', () => {
  const url = 'https://example.com/page?utm_source=x#frag'
  assert.equal(canonicalDedupeKey(url), url)
})

test('a Confluence /wiki path on atlassian.net is returned unchanged', () => {
  const url = 'https://example.atlassian.net/wiki/spaces/DOCS/pages/1'
  assert.equal(canonicalDedupeKey(url), url)
})

test('malformed URLs are returned unchanged without throwing', () => {
  assert.equal(canonicalDedupeKey('not a url'), 'not a url')
  assert.equal(canonicalDedupeKey(''), '')
})

function withExtensionId<T>(id: string, fn: () => T): T {
  const g = globalThis as { chrome?: unknown }
  const previous = g.chrome
  g.chrome = { runtime: { id } }
  try {
    return fn()
  } finally {
    if (previous === undefined) delete g.chrome
    else g.chrome = previous
  }
}

test('Tab Out dashboard variants collapse to a single dedupe key', () => {
  withExtensionId('tab-out', () => {
    const base = 'chrome-extension://tab-out/index.html'
    assert.equal(canonicalDedupeKey(base), base)
    assert.equal(canonicalDedupeKey(`${base}?filter=github`), base)
    assert.equal(canonicalDedupeKey(`${base}?focusFilter=1`), base)
    assert.equal(canonicalDedupeKey(`${base}#frag`), base)
  })
})

test('chrome://newtab/ is not folded into the Tab Out dashboard key', () => {
  withExtensionId('tab-out', () => {
    assert.equal(canonicalDedupeKey('chrome://newtab/'), 'chrome://newtab/')
  })
})

test('other chrome-extension pages are left unchanged', () => {
  withExtensionId('tab-out', () => {
    const other = 'chrome-extension://tab-out/suspended.html#uri=https%3A%2F%2Fx.com'
    assert.equal(canonicalDedupeKey(other), other)
  })
})
