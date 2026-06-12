import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSuspenderId, buildSuspendUrl, isSuspended, rememberSuspendTargetFromTabs, getSuspendTarget, unwrapSuspenderUrl, unwrapSuspenderTitle } from '../src/extension/suspension.js'

const SUSPENDER_ID = 'aaaabbbbccccddddeeeeffffgggghhhh'
const TEMPLATE = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=Old%20Title&pos=0&uri=https://old.example/page`

test('isSuspended: true only for a suspender-rewritten url pair, derived or supplied', () => {
  assert.equal(isSuspended(TEMPLATE, 'https://old.example/page'), true)
  assert.equal(isSuspended(TEMPLATE), true)
  assert.equal(isSuspended('https://old.example/page', 'https://old.example/page'), false)
  assert.equal(isSuspended('https://old.example/page'), false)
  assert.equal(isSuspended(''), false)
  assert.equal(isSuspended(undefined), false)
})

test('extractSuspenderId: returns the id for a suspended.html url', () => {
  assert.equal(extractSuspenderId(TEMPLATE), SUSPENDER_ID)
})

test('extractSuspenderId: null for non-suspended extension pages and other urls', () => {
  assert.equal(extractSuspenderId(`chrome-extension://${SUSPENDER_ID}/options.html`), null)
  assert.equal(extractSuspenderId('https://example.com'), null)
  assert.equal(extractSuspenderId(''), null)
  assert.equal(extractSuspenderId(undefined), null)
})

test('buildSuspendUrl: round-trips through the unwrap helpers', () => {
  const url = 'https://example.com/path?x=1&y=2#frag'
  const title = 'Hello & Goodbye #1 café'
  const built = buildSuspendUrl({ id: SUSPENDER_ID, template: TEMPLATE }, { url, title })
  assert.equal(unwrapSuspenderUrl(built), url)
  assert.equal(unwrapSuspenderTitle(built), title)
})

test('buildSuspendUrl: preserves the suspender base path and extra fragment params', () => {
  const built = buildSuspendUrl(
    { id: SUSPENDER_ID, template: TEMPLATE },
    { url: 'https://new.example', title: 'New' }
  )
  assert.ok(built.startsWith(`chrome-extension://${SUSPENDER_ID}/suspended.html#`))
  assert.ok(built.includes('pos=0'))
  assert.ok(built.endsWith('&uri=https://new.example'))
})

test('buildSuspendUrl: zeroes the template pos= scroll offset', () => {
  const template = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=Old&pos=4220&uri=https://old.example/page`
  const built = buildSuspendUrl({ id: SUSPENDER_ID, template }, { url: 'https://new.example', title: 'New' })
  assert.ok(built.includes('&pos=0&'))
  assert.ok(!built.includes('pos=4220'))
})

test('rememberSuspendTargetFromTabs: captures the first suspended tab; getSuspendTarget returns it', async () => {
  const raw = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=T&pos=0&uri=https://kept.example`
  rememberSuspendTargetFromTabs([
    { suspended: false, rawUrl: 'https://live.example' },
    { suspended: true, rawUrl: raw }
  ])
  const target = await getSuspendTarget()
  assert.deepEqual(target, { id: SUSPENDER_ID, template: raw })
})

test('rememberSuspendTargetFromTabs: ignores non-suspender and non-suspended tabs', async () => {
  const good = `chrome-extension://${SUSPENDER_ID}/suspended.html#ttl=T&pos=0&uri=https://good.example`
  rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: good }])
  // A later scan whose only "suspended" tab is a non-suspender URL (plus a live
  // tab) must NOT overwrite the previously-learned target.
  rememberSuspendTargetFromTabs([
    { suspended: true, rawUrl: 'https://not-a-suspender.example' },
    { suspended: false, rawUrl: 'https://live.example' }
  ])
  assert.deepEqual(await getSuspendTarget(), { id: SUSPENDER_ID, template: good })
})

test('rememberSuspendTargetFromTabs: same-suspender template drift updates memory without re-persisting', async () => {
  const otherId = 'iiiijjjjkkkkllllmmmmnnnnoooopppp'
  const setCalls: unknown[] = []
  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async (items: unknown) => { setCalls.push(items) }
      }
    }
  } as unknown as typeof globalThis.chrome
  try {
    const first = `chrome-extension://${otherId}/suspended.html#ttl=A&pos=10&uri=https://a.example`
    const second = `chrome-extension://${otherId}/suspended.html#ttl=B&pos=99&uri=https://b.example`
    rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: first }])
    assert.equal(setCalls.length, 1)
    rememberSuspendTargetFromTabs([{ suspended: true, rawUrl: second }])
    assert.equal(setCalls.length, 1)
    assert.deepEqual(await getSuspendTarget(), { id: otherId, template: second })
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})
