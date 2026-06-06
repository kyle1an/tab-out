import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { highlightTermsForFilter, highlightedTextNodes } from '../src/components/filter-highlight-text.js'

function renderNodes(node: React.ReactNode): string {
  return renderToStaticMarkup(React.createElement(React.Fragment, null, node))
}

test('highlightedTextNodes wraps a matching term in a chip-filter-match <mark>', () => {
  const html = renderNodes(highlightedTextNodes('Example Docs', ['docs'], 'k'))
  assert.match(html, /<mark[^>]*class="[^"]*chip-filter-match[^"]*"[^>]*>Docs<\/mark>/)
  assert.match(html, /Example /)
})

test('highlightedTextNodes returns plain renderText output with no <mark> when there are no terms', () => {
  const html = renderNodes(highlightedTextNodes('Example Docs', [], 'k'))
  assert.equal(html, 'Example Docs')
  assert.doesNotMatch(html, /<mark/)
})

test('highlightedTextNodes merges overlapping ranges into a single mark', () => {
  const html = renderNodes(highlightedTextNodes('example', ['exa', 'example'], 'k'))
  assert.equal((html.match(/<mark/g) || []).length, 1)
  assert.match(html, /<mark[^>]*>example<\/mark>/)
})

test('highlightedTextNodes tolerates zero-width spaces when matching', () => {
  const html = renderNodes(highlightedTextNodes('ex\u200Bample', ['example'], 'k'))
  assert.match(html, /<mark/)
})

test('highlightTermsForFilter parses space-separated terms in parsed mode', () => {
  assert.deepEqual(highlightTermsForFilter('foo bar', 'parsed').sort(), ['bar', 'foo'])
})

test('highlightTermsForFilter returns one lowercased substring in legacy mode', () => {
  assert.deepEqual(highlightTermsForFilter('FOO Bar', 'legacy'), ['foo bar'])
})

test('highlightTermsForFilter returns [] for a blank filter', () => {
  assert.deepEqual(highlightTermsForFilter('   ', 'parsed'), [])
})
