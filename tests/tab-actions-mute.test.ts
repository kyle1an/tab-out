import assert from 'node:assert/strict'
import test from 'node:test'

import { replaceDashboardRefreshForTesting } from '../src/extension/dashboard-intake.js'
import { historyEntryMuteFailureToastMessage, setChipTargetMuted, setHistoryEntryMuted } from '../src/extension/tab-actions.js'

type MuteCall = { tabId: number, muted: boolean }

function installChromeMock(initialTabs: Array<Record<string, unknown>>) {
  let tabs = initialTabs.map((t) => ({ ...t }))
  const muteCalls: MuteCall[] = []
  let queryCount = 0
  ;(globalThis as any).chrome = {
    runtime: { id: 'tab-out' },
    tabs: {
      async query() {
        queryCount += 1
        return tabs.map((t) => ({ ...t }))
      },
      async get(tabId: number) {
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error('Unknown tab')
        return { ...tab }
      },
      async update(tabId: number, props: { muted?: boolean }) {
        if (typeof props.muted === 'boolean') muteCalls.push({ tabId, muted: props.muted })
        tabs = tabs.map((t) => (t.id === tabId ? { ...t, mutedInfo: { muted: props.muted } } : t))
        return tabs.find((t) => t.id === tabId)
      },
    },
    windows: {
      async getAll() {
        return [{ id: 1, type: 'normal' }]
      },
      async getCurrent() {
        return { id: 1 }
      },
    },
  }
  return {
    muteCalls,
    navigateTab(tabId: number, url: string) {
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, url } : tab))
    },
    get queryCount() {
      return queryCount
    },
  }
}

test('setHistoryEntryMuted updates exactly that tab without a redundant inventory read', async () => {
  const chromeMock = installChromeMock([{ id: 7, url: 'https://example.com/', windowId: 1 }])
  await setHistoryEntryMuted({ tabId: 7, tabUrl: 'https://example.com/' }, true)
  assert.deepEqual(chromeMock.muteCalls, [{ tabId: 7, muted: true }])
  assert.equal(chromeMock.queryCount, 0)
})

test('setHistoryEntryMuted ignores a non-integer tab id', async () => {
  const { muteCalls } = installChromeMock([{ id: 7, url: 'https://example.com/', windowId: 1 }])
  await setHistoryEntryMuted({ tabId: Number.NaN, tabUrl: 'https://example.com/' }, true)
  assert.equal(muteCalls.length, 0)
})

test('setChipTargetMuted mutes every matching tab with one inventory read', async () => {
  const chromeMock = installChromeMock([
    { id: 1, url: 'https://example.com/a', windowId: 1 },
    { id: 2, url: 'https://example.com/a', windowId: 1 },
    { id: 3, url: 'https://example.com/b', windowId: 1 },
  ])
  await setChipTargetMuted({ tabUrl: 'https://example.com/a', muted: true })
  assert.deepEqual(chromeMock.muteCalls.map((c) => c.tabId).sort(), [1, 2])
  assert.ok(chromeMock.muteCalls.every((c) => c.muted === true))
  assert.equal(chromeMock.queryCount, 1)
})

test('setChipTargetMuted mutes every tab across folded envs', async () => {
  const { muteCalls } = installChromeMock([
    { id: 1, url: 'https://a.example.com/', windowId: 1 },
    { id: 2, url: 'https://b.example.com/', windowId: 1 },
    { id: 3, url: 'https://c.example.com/', windowId: 1 },
  ])
  await setChipTargetMuted({
    tabUrl: 'https://a.example.com/',
    envs: [{ tabUrl: 'https://a.example.com/' }, { tabUrl: 'https://b.example.com/' }] as any,
    muted: true,
  })
  assert.deepEqual(muteCalls.map((c) => c.tabId).sort(), [1, 2])
})

test('setChipTargetMuted reports failure without refreshing when the live inventory is unknown', async () => {
  const { muteCalls } = installChromeMock([
    { id: 1, url: 'https://example.test/docs', windowId: 1 },
  ])
  ;(globalThis as any).chrome.tabs.query = async () => {
    throw new Error('Tab inventory unavailable')
  }
  let refreshCount = 0
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount
  try {
    const result = await setChipTargetMuted({
      tabUrl: 'https://example.test/docs',
      muted: true,
    })

    assert.equal(result, false)
    assert.deepEqual(muteCalls, [])
    assert.equal(refreshCount, refreshBaseline)
  } finally {
    unregisterRefresh()
  }
})

test('setChipTargetMuted reports failure without refreshing when every mute write fails', async () => {
  const { muteCalls } = installChromeMock([
    { id: 1, url: 'https://example.test/docs', windowId: 1 },
  ])
  ;(globalThis as any).chrome.tabs.update = async () => {
    throw new Error('Tab update unavailable')
  }
  let refreshCount = 0
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount
  try {
    const result = await setChipTargetMuted({
      tabUrl: 'https://example.test/docs',
      muted: true,
    })

    assert.equal(result, false)
    assert.deepEqual(muteCalls, [])
    assert.equal(refreshCount, refreshBaseline)
  } finally {
    unregisterRefresh()
  }
})

test('setChipTargetMuted preserves and refreshes a confirmed partial mute', async () => {
  const { muteCalls } = installChromeMock([
    { id: 1, url: 'https://example.test/docs', windowId: 1 },
    { id: 2, url: 'https://example.test/docs', windowId: 1 },
  ])
  const updateTab = (globalThis as any).chrome.tabs.update.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.update = async (tabId: number, properties: { muted?: boolean }) => {
    if (tabId === 2) throw new Error('Tab update unavailable')
    return updateTab(tabId, properties)
  }
  let refreshCount = 0
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount
  try {
    const result = await setChipTargetMuted({
      tabUrl: 'https://example.test/docs',
      muted: true,
    })

    assert.equal(result, false)
    assert.deepEqual(muteCalls, [{ tabId: 1, muted: true }])
    assert.equal(refreshCount, refreshBaseline + 1)
  } finally {
    unregisterRefresh()
  }
})

test('setChipTargetMuted skips a later target that navigates while earlier updates settle', async () => {
  const chromeMock = installChromeMock([
    { id: 1, url: 'https://example.test/docs', windowId: 1 },
    { id: 2, url: 'https://example.test/docs', windowId: 1 },
  ])
  const updateTab = (globalThis as any).chrome.tabs.update.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.update = async (tabId: number, properties: { muted?: boolean }) => {
    const updated = await updateTab(tabId, properties)
    if (tabId === 1) chromeMock.navigateTab(2, 'https://example.test/navigated')
    return updated
  }
  let refreshCount = 0
  const unregisterRefresh = replaceDashboardRefreshForTesting(() => {
    refreshCount += 1
  })
  const refreshBaseline = refreshCount

  try {
    const result = await setChipTargetMuted({
      tabUrl: 'https://example.test/docs',
      muted: true,
    })

    assert.equal(result, false)
    assert.deepEqual(chromeMock.muteCalls, [{ tabId: 1, muted: true }])
    assert.equal(refreshCount, refreshBaseline + 1)
  } finally {
    unregisterRefresh()
  }
})

test('setHistoryEntryMuted can unmute (muted: false)', async () => {
  const { muteCalls } = installChromeMock([{ id: 7, url: 'https://example.com/', windowId: 1 }])
  await setHistoryEntryMuted({ tabId: 7, tabUrl: 'https://example.com/' }, false)
  assert.deepEqual(muteCalls, [{ tabId: 7, muted: false }])
})

test('setHistoryEntryMuted rejects a reused tab id whose live URL no longer matches', async () => {
  const { muteCalls } = installChromeMock([{ id: 7, url: 'https://unrelated.example/', windowId: 1 }])

  await setHistoryEntryMuted({ tabId: 7, tabUrl: 'https://expected.example/' }, true)

  assert.deepEqual(muteCalls, [])
})

test('setHistoryEntryMuted reports unknown for a URL-only target when live tabs cannot be read', async () => {
  const { muteCalls } = installChromeMock([
    { id: 7, url: 'https://example.test/docs', windowId: 1 },
  ])
  ;(globalThis as any).chrome.tabs.query = async () => {
    throw new Error('Tab inventory unavailable')
  }

  const result = await setHistoryEntryMuted({ tabUrl: 'https://example.test/docs' }, true)

  assert.equal(result, 'unknown')
  assert.deepEqual(muteCalls, [])
})

test('setHistoryEntryMuted reports a specific mute or unmute write failure', async () => {
  installChromeMock([{ id: 7, url: 'https://example.test/docs', windowId: 1 }])
  ;(globalThis as any).chrome.tabs.update = async () => {
    throw new Error('Tab update unavailable')
  }

  assert.equal(historyEntryMuteFailureToastMessage(true), 'Could not mute tab')
  assert.equal(historyEntryMuteFailureToastMessage(false), 'Could not unmute tab')
  assert.equal(await setHistoryEntryMuted({ tabId: 7, tabUrl: 'https://example.test/docs' }, true), false)
})
