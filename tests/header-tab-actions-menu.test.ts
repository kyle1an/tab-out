import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { HeaderTabActionsMenu } from '../src/components/HeaderTabActionsMenu.js'

test('HeaderTabActionsMenu renders a persistent horizontal-ellipsis header control', () => {
  const html = renderToStaticMarkup(
    React.createElement(HeaderTabActionsMenu, {
      ready: true,
    }),
  )
  const trigger = html.match(/<button[^>]*data-tabout-part="menu-trigger"[^>]*>/)?.[0] ?? ''

  assert.match(html, /data-tabout="tab-actions"/)
  assert.match(trigger, /data-tabout-part="menu-trigger"/)
  assert.match(trigger, /aria-label="Tab actions"/)
  assert.doesNotMatch(trigger, / disabled(?:=|>)/)
  assert.match(html, /icon-\[lucide--ellipsis\][^>]*aria-hidden="true"/)
  assert.doesNotMatch(html, /icon-\[lucide--ellipsis-vertical\]/)
})
