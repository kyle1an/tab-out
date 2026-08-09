import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AppErrorBoundary, DashboardErrorFallback } from '../src/components/AppErrorBoundary.js'

test('AppErrorBoundary renders its children when nothing throws', () => {
  const html = renderToStaticMarkup(
    React.createElement(AppErrorBoundary, null, React.createElement('main', null, 'dashboard')),
  )

  assert.ok(html.includes('<main>dashboard</main>'))
  assert.ok(!html.includes('Tab Out hit an error'))
})

test('DashboardErrorFallback shows the failure, the message, and a reload action', () => {
  const html = renderToStaticMarkup(
    React.createElement(DashboardErrorFallback, {
      error: new Error('suppressedTitleToneIndexByText.get is not a function'),
      resetErrorBoundary: () => {},
    }),
  )

  assert.ok(html.includes('Tab Out hit an error'))
  assert.ok(html.includes('suppressedTitleToneIndexByText.get is not a function'))
  assert.ok(html.includes('>Reload</button>'))
})

test('DashboardErrorFallback renders non-Error throwables without crashing itself', () => {
  const html = renderToStaticMarkup(
    React.createElement(DashboardErrorFallback, {
      error: 'plain string throw',
      resetErrorBoundary: () => {},
    }),
  )

  assert.ok(html.includes('plain string throw'))
})
