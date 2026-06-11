import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CardActionsMenu } from '../src/components/CardActionsMenu.js'
import { DomainCard } from '../src/components/DomainCard.js'
import type { DashboardCardVM, DomainGroup } from '../src/extension/types'

test('CardActionsMenu renders a kebab trigger and hides the close item until opened', () => {
  const html = renderToStaticMarkup(
    React.createElement(CardActionsMenu, {
      displayName: 'google.com',
      label: 'Close all 5 tabs',
      onClose: () => {}
    })
  )

  // Trigger is present in the at-rest markup.
  assert.match(html, /<button[^>]*data-tabout-part="card-menu"/)
  assert.match(html, /aria-label="Actions for google\.com"/)
  assert.match(html, /aria-haspopup="menu"/)
  assert.match(html, /icon-\[lucide--ellipsis-vertical\]/)

  // The closed menu's item is NOT in the at-rest markup (it lives in the unopened portal).
  assert.doesNotMatch(html, /Close all 5 tabs/)
  assert.doesNotMatch(html, /data-tabout-part="close-button"/)
})

function makeClosableCardVM(overrides: Partial<DashboardCardVM> = {}): DashboardCardVM {
  return {
    stableId: 'domain-google-com',
    isHidden: false,
    displayMode: 'normal',
    filtering: false,
    tabCountLabel: '5',
    closableCount: 5,
    closableCountLabel: 'Close all 5 tabs',
    suspendableCount: 5,
    suspendableCountLabel: 'Suspend all 5 tabs',
    suppressedTitleParts: [],
    sections: [],
    ...overrides
  }
}

test('DomainCard renders the kebab actions menu (not the old close button) when closable', () => {
  const group: DomainGroup = { domain: 'google.com', tabs: [] }
  const html = renderToStaticMarkup(React.createElement(DomainCard, { group, vm: makeClosableCardVM() }))

  assert.match(html, /data-tabout-part="card-menu"/)
  assert.match(html, /aria-label="Actions for google\.com"/)
  // The old dual-mode close button is gone from the at-rest header.
  assert.doesNotMatch(html, /card-close-btn/)
  assert.doesNotMatch(html, /data-tabout-part="close-button"/)
})

test('CardActionsMenu orders suspend before close', () => {
  const source = readFileSync(new URL('../src/components/CardActionsMenu.tsx', import.meta.url), 'utf8')

  assert.ok(source.indexOf('data-tabout-part="suspend-button"') < source.indexOf('data-tabout-part="close-button"'))
})

test('DomainCard renders no actions menu when there is nothing closable', () => {
  const group: DomainGroup = { domain: 'google.com', tabs: [] }
  const html = renderToStaticMarkup(
    React.createElement(DomainCard, { group, vm: makeClosableCardVM({ closableCount: 0 }) })
  )

  assert.doesNotMatch(html, /data-tabout-part="card-menu"/)
})

test('DomainCard suppresses the actions menu on the standalone-apps card', () => {
  // Suppression is gated on the domain key, not the stableId — keep the VM plain
  // so the test reflects what actually drives the behavior.
  const group: DomainGroup = { domain: '__standalone-apps__', tabs: [] }
  const html = renderToStaticMarkup(React.createElement(DomainCard, { group, vm: makeClosableCardVM() }))

  assert.doesNotMatch(html, /data-tabout-part="card-menu"/)
})
