import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Missions } from '../src/components/Missions.js'

test('filtered empty missions announce their result summary', () => {
  const html = renderToStaticMarkup(React.createElement(Missions, {
    cards: [],
    filter: 'missing page'
  }))

  assert.match(html, /<output/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /No matches for “missing page”\./)
})
