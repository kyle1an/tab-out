import assert from 'node:assert/strict'
import test from 'node:test'

import { liveTabsMatchingTarget } from '../src/extension/live-tab-matching.js'
import type { LiveTabMatchTarget } from '../src/extension/live-tab-matching.js'

const DOCS = 'https://example.com/docs'
const DOCS_SUSPENDED = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
const OTHER = 'https://example.com/other'
const ENV_A = 'https://a.example.com/dash'
const ENV_B = 'https://b.example.com/dash'
const ENV_B_SUSPENDED = 'chrome-extension://marvellous/suspended.html#ttl=Dash&uri=https%3A%2F%2Fb.example.com%2Fdash'

type Row = {
  name: string
  tabs: Array<{ id: number; url?: string }>
  target: LiveTabMatchTarget
  expected: number[]
}

const table: Row[] = [
  {
    name: 'exact URL match returns every duplicate',
    tabs: [
      { id: 1, url: DOCS },
      { id: 2, url: DOCS },
      { id: 3, url: OTHER }
    ],
    target: { tabUrl: DOCS },
    expected: [1, 2]
  },
  {
    name: 'a suspended live tab matches its effective page target',
    tabs: [
      { id: 1, url: DOCS_SUSPENDED },
      { id: 2, url: OTHER }
    ],
    target: { tabUrl: DOCS },
    expected: [1]
  },
  {
    name: 'a suspended target matches the live unsuspended tab',
    tabs: [
      { id: 1, url: DOCS },
      { id: 2, url: OTHER }
    ],
    target: { tabUrl: DOCS_SUSPENDED },
    expected: [1]
  },
  {
    name: 'suspended target and suspended tab meet at the effective URL',
    tabs: [{ id: 1, url: DOCS_SUSPENDED }],
    target: { tabUrl: DOCS_SUSPENDED },
    expected: [1]
  },
  {
    name: 'no match returns empty',
    tabs: [{ id: 1, url: OTHER }],
    target: { tabUrl: DOCS },
    expected: []
  },
  {
    name: 'tabs without a URL never match',
    tabs: [{ id: 1 }, { id: 2, url: '' }],
    target: { tabUrl: DOCS },
    expected: []
  },
  {
    name: 'folded chips match every variant URL and ignore non-members',
    tabs: [
      { id: 1, url: ENV_A },
      { id: 2, url: ENV_B },
      { id: 3, url: OTHER }
    ],
    target: { tabUrl: ENV_A, envs: [{ tabUrl: ENV_A }, { tabUrl: ENV_B }] },
    expected: [1, 2]
  },
  {
    name: 'folded chips match a suspended variant through its effective URL',
    tabs: [
      { id: 1, url: ENV_A },
      { id: 2, url: ENV_B_SUSPENDED }
    ],
    target: { tabUrl: ENV_A, envs: [{ tabUrl: ENV_A }, { tabUrl: ENV_B }] },
    expected: [1, 2]
  },
  {
    name: 'folded env list may itself carry a suspended variant URL',
    tabs: [
      { id: 1, url: ENV_B },
      { id: 2, url: OTHER }
    ],
    target: { tabUrl: ENV_A, envs: [{ tabUrl: ENV_B_SUSPENDED }] },
    expected: [1]
  },
  {
    name: 'an empty folded env list falls back to single-target matching',
    tabs: [
      { id: 1, url: DOCS },
      { id: 2, url: OTHER }
    ],
    target: { tabUrl: DOCS, envs: [] },
    expected: [1]
  }
]

for (const row of table) {
  test(`live-tab matching: ${row.name}`, () => {
    const matched = liveTabsMatchingTarget(row.tabs, row.target).map((tab) => tab.id)
    assert.deepEqual(matched, row.expected)
  })
}
