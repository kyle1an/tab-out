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
  assert.match(html, /\[box-decoration-break:clone\]/)
  assert.doesNotMatch(html, /\[-webkit-box-decoration-break:clone\]/)
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

test('highlightedTextNodes keeps highlights aligned when toLowerCase expands characters', () => {
  // '\u0130' (U+0130) lowercases to two units ('i' + combining dot), shifting every
  // later index \u2014 the mark must still wrap the matched original text.
  const html = renderNodes(highlightedTextNodes('\u0130\u0130\u0130 Example Docs', ['docs'], 'k'))
  assert.match(html, /<mark[^>]*>Docs<\/mark>/)
})

test('highlightedTextNodes includes the original character when its lowercase form expands', () => {
  const html = renderNodes(highlightedTextNodes('\u0130stanbul', ['i'], 'k'))

  assert.match(html, /<mark[^>]*>\u0130<\/mark>stanbul/)
})

test('highlightTermsForFilter parses space-separated terms', () => {
  assert.deepEqual(highlightTermsForFilter('foo bar').sort(), ['bar', 'foo'])
})

test('highlightedTextNodes marks a hyphenated phrase matched by a quoted spaced filter', () => {
  const terms = highlightTermsForFilter('"tab out"')
  const html = renderNodes(highlightedTextNodes('Tab-Out guide', terms, 'k'))

  assert.match(html, /<mark[^>]*>Tab-Out<\/mark>/)
})

test('highlightTermsForFilter returns [] for a blank filter', () => {
  assert.deepEqual(highlightTermsForFilter('   '), [])
})
