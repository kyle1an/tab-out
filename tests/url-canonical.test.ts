import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalDedupeKey } from '../src/extension/url-canonical.js'

type TestGlobal = typeof globalThis & { window?: Window & typeof globalThis }

function withWindow<T>(windowValue: Partial<Window>, fn: () => T): T {
  const testGlobal = globalThis as TestGlobal
  const previousWindow = testGlobal.window
  testGlobal.window = windowValue as Window & typeof globalThis
  try {
    return fn()
  } finally {
    if (previousWindow === undefined) delete testGlobal.window
    else testGlobal.window = previousWindow
  }
}

function withoutConsoleWarn<T>(fn: () => T): T {
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.warn = originalWarn
  }
}

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

test('a local canonicalizer overrides the built-in for the same host', () => {
  withWindow({
    LOCAL_URL_CANONICALIZERS: [
      { hostnameEndsWith: '.atlassian.net', canonicalize: (u: URL) => `${u.origin}/LOCAL${u.pathname}` }
    ]
  }, () => {
    assert.equal(canonicalDedupeKey(canonical), 'https://example.atlassian.net/LOCAL/browse/ABC-123')
  })
})

test('a throwing local canonicalizer falls back to the built-in rule', () => {
  withoutConsoleWarn(() => {
    withWindow({
      LOCAL_URL_CANONICALIZERS: [
        { hostnameEndsWith: '.atlassian.net', canonicalize: () => { throw new Error('bad local rule') } }
      ]
    }, () => {
      assert.equal(canonicalDedupeKey(shortForm), canonical)
    })
  })
})
