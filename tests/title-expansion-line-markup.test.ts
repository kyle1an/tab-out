import assert from 'node:assert/strict'
import test from 'node:test'

import { expansionLineMarkup } from '../src/components/title-expansion/index.js'
import type { ExpansionLineClasses } from '../src/components/title-expansion/index.js'

const CLASSES: ExpansionLineClasses = {
  wrapper: 'lines-wrap',
  line: 'line-normal',
  constrainedLine: 'line-constrained',
  tailLine: 'line-tail'
}

test('wraps captured lines and marks only the last as the tail', () => {
  const markup = expansionLineMarkup(['first', 'second', 'third <mark>hit</mark>'], CLASSES)

  assert.equal(
    markup,
    '<span class="lines-wrap">' +
      '<span class="line-normal">first</span>' +
      '<span class="line-normal">second</span>' +
      '<span class="line-tail">third <mark>hit</mark></span>' +
      '</span>'
  )
})

test('viewport-constrained switches earlier lines to the constrained class, tail unchanged', () => {
  const markup = expansionLineMarkup(['first', 'second'], CLASSES, true)

  assert.equal(
    markup,
    '<span class="lines-wrap">' +
      '<span class="line-constrained">first</span>' +
      '<span class="line-tail">second</span>' +
      '</span>'
  )
})

test('a single captured line is the tail', () => {
  const markup = expansionLineMarkup(['only'], CLASSES)

  assert.equal(markup, '<span class="lines-wrap"><span class="line-tail">only</span></span>')
})
