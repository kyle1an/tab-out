import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_DASHBOARD_VIEW,
  dashboardSourceForView,
  dashboardViewFromValue,
} from '../src/extension/dashboard-view.js'
import { dashboardViewFromSearch, urlForDashboardView } from '../src/extension/app-url.js'

test('the default dashboard view uses the tabs source', () => {
  assert.equal(DEFAULT_DASHBOARD_VIEW, 'all-tabs')
  assert.equal(dashboardSourceForView('open-saved'), 'tabs')
  assert.equal(dashboardSourceForView('all-tabs'), 'tabs')
  assert.equal(dashboardSourceForView('bookmarks'), 'bookmarks')
})

test('dashboardViewFromValue accepts persisted views and defaults invalid values', () => {
  assert.equal(dashboardViewFromValue('open-saved'), 'open-saved')
  assert.equal(dashboardViewFromValue('all-tabs'), 'all-tabs')
  assert.equal(dashboardViewFromValue('bookmarks'), 'bookmarks')
  assert.equal(dashboardViewFromValue('unknown'), 'all-tabs')
  assert.equal(dashboardViewFromValue(null), 'all-tabs')
  assert.equal(dashboardViewFromValue(undefined), 'all-tabs')
})

test('dashboardViewFromSearch reads supported values and defaults absent or unknown values', () => {
  assert.equal(dashboardViewFromSearch(''), 'all-tabs')
  assert.equal(dashboardViewFromSearch('?view=open-saved'), 'open-saved')
  assert.equal(dashboardViewFromSearch('?view=all-tabs'), 'all-tabs')
  assert.equal(dashboardViewFromSearch('?filter=qa&view=bookmarks'), 'bookmarks')
  assert.equal(dashboardViewFromSearch('?view=unknown'), 'all-tabs')
})

test('urlForDashboardView omits the default view and preserves unrelated URL parts', () => {
  assert.equal(
    urlForDashboardView('all-tabs', {
      pathname: '/index.html',
      search: '?filter=qa&view=open-saved&marker=one',
      hash: '#top',
    }),
    '/index.html?filter=qa&marker=one#top',
  )
})

test('urlForDashboardView writes non-default views without disturbing unrelated URL parts', () => {
  assert.equal(
    urlForDashboardView('open-saved', {
      pathname: '/index.html',
      search: '?filter=qa',
      hash: '#top',
    }),
    '/index.html?filter=qa&view=open-saved#top',
  )
  assert.equal(
    urlForDashboardView('bookmarks', {
      pathname: '/index.html',
      search: '?view=unknown&filter=qa',
      hash: '#top',
    }),
    '/index.html?view=bookmarks&filter=qa#top',
  )
})
