import assert from 'node:assert/strict'
import test from 'node:test'

import { setChipTargetMuted, setHistoryEntryMuted } from '../src/extension/tab-actions.js'

type MuteCall = { tabId: number; muted: boolean }

function installChromeMock(initialTabs: Array<Record<string, unknown>>) {
  let tabs = initialTabs.map((t) => ({ ...t }))
  const muteCalls: MuteCall[] = []
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out' },
    tabs: {
      async query() {
        return tabs.map((t) => ({ ...t }))
      },
      async update(tabId: number, props: { muted?: boolean }) {
        if (typeof props.muted === 'boolean') muteCalls.push({ tabId, muted: props.muted })
        tabs = tabs.map((t) => (t.id === tabId ? { ...t, mutedInfo: { muted: props.muted } } : t))
        return tabs.find((t) => t.id === tabId)
      }
    },
    windows: {
      async getAll() {
        return [{ id: 1, type: 'normal' }]
      },
      async getCurrent() {
        return { id: 1 }
      }
    }
  }
  return { muteCalls }
}

test('setHistoryEntryMuted updates exactly that tab', async () => {
  const { muteCalls } = installChromeMock([{ id: 7, url: 'https://example.com/', windowId: 1 }])
  await setHistoryEntryMuted(7, true)
  assert.deepEqual(muteCalls, [{ tabId: 7, muted: true }])
})

test('setHistoryEntryMuted ignores a non-integer tab id', async () => {
  const { muteCalls } = installChromeMock([{ id: 7, url: 'https://example.com/', windowId: 1 }])
  await setHistoryEntryMuted(Number.NaN, true)
  assert.equal(muteCalls.length, 0)
})

test('setChipTargetMuted mutes every tab matching the chip URL', async () => {
  const { muteCalls } = installChromeMock([
    { id: 1, url: 'https://example.com/a', windowId: 1 },
    { id: 2, url: 'https://example.com/a', windowId: 1 },
    { id: 3, url: 'https://example.com/b', windowId: 1 }
  ])
  await setChipTargetMuted({ tabUrl: 'https://example.com/a', muted: true })
  assert.deepEqual(muteCalls.map((c) => c.tabId).sort(), [1, 2])
  assert.ok(muteCalls.every((c) => c.muted === true))
})

test('setChipTargetMuted mutes every tab across folded envs', async () => {
  const { muteCalls } = installChromeMock([
    { id: 1, url: 'https://a.example.com/', windowId: 1 },
    { id: 2, url: 'https://b.example.com/', windowId: 1 },
    { id: 3, url: 'https://c.example.com/', windowId: 1 }
  ])
  await setChipTargetMuted({
    tabUrl: 'https://a.example.com/',
    envs: [{ tabUrl: 'https://a.example.com/' }, { tabUrl: 'https://b.example.com/' }] as any,
    muted: true
  })
  assert.deepEqual(muteCalls.map((c) => c.tabId).sort(), [1, 2])
})

test('setHistoryEntryMuted can unmute (muted: false)', async () => {
  const { muteCalls } = installChromeMock([{ id: 7, url: 'https://example.com/', windowId: 1 }])
  await setHistoryEntryMuted(7, false)
  assert.deepEqual(muteCalls, [{ tabId: 7, muted: false }])
})
