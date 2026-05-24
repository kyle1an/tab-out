import assert from 'node:assert/strict'
import test from 'node:test'

import { registerDashboardRefresh } from '../src/extension/dashboard-controller.js'
import { closeHistoryEntry, focusHistoryEntry } from '../src/extension/tab-history.js'
import { focusTab, snapshotChromeTabs } from '../src/extension/tabs.js'
import { markClosure, undoLastClose } from '../src/extension/undo.js'
import { focusWorkingSetItem } from '../src/extension/working-set-client.js'

function createChromeMock(initialTabs: any[], currentWindowId = 1) {
  const tabs = initialTabs.map((tab) => ({ ...tab }))
  const calls: any = {
    create: [],
    remove: [],
    runtimeMessages: [],
    tabsUpdate: [],
    windowsUpdate: []
  }

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      async sendMessage(extensionId, message) {
        calls.runtimeMessages.push({ extensionId, message: { ...message } })
        if (extensionId === 'blocked') throw new Error('Cannot message extension')
        if (extensionId === 'rejects') return 'Error: tab is not suspended'
        return undefined
      }
    },
    tabs: {
      async query() {
        return tabs.map((tab) => ({ ...tab }))
      },
      async update(tabId, updateProperties) {
        calls.tabsUpdate.push({ tabId, updateProperties: { ...updateProperties } })
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) return undefined

        if (updateProperties.active) {
          for (const candidate of tabs) {
            if (candidate.windowId === tab.windowId) candidate.active = false
          }
        }
        Object.assign(tab, updateProperties)
        return { ...tab }
      },
      async create(createProperties) {
        calls.create.push({ ...createProperties })
        if (createProperties.url === 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs') {
          throw new Error('Cannot create blocked extension URL')
        }
        const nextId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1
        const windowId = createProperties.windowId ?? currentWindowId
        const windowTabs = tabs.filter((tab) => tab.windowId === windowId)
        const requestedIndex = Number.isInteger(createProperties.index) ? createProperties.index : windowTabs.length
        const insertionIndex = Math.max(0, Math.min(requestedIndex, windowTabs.length))
        for (const candidate of windowTabs) {
          const candidateIndex = Number.isInteger(candidate.index) ? candidate.index : windowTabs.indexOf(candidate)
          if (candidateIndex >= insertionIndex) candidate.index = candidateIndex + 1
        }
        const tab = {
          id: nextId,
          windowId,
          url: createProperties.url || 'chrome://newtab/',
          title: '',
          active: !!createProperties.active,
          pinned: !!createProperties.pinned,
          groupId: -1,
          index: insertionIndex
        }
        tabs.push(tab)
        return { ...tab }
      },
      async remove(tabIds) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        calls.remove.push(...ids)
        for (const id of ids) {
          const index = tabs.findIndex((tab) => tab.id === id)
          if (index !== -1) tabs.splice(index, 1)
        }
      }
    },
    windows: {
      async getCurrent() {
        return { id: currentWindowId, type: 'normal' }
      },
      async update(windowId, updateProperties) {
        calls.windowsUpdate.push({ windowId, updateProperties: { ...updateProperties } })
        return { id: windowId, type: 'normal', focused: !!updateProperties.focused }
      }
    }
  }

  return { calls, tabs }
}

test('focusTab does not pin an existing Tab Out tab when focusing a chip target', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: tabOutUrl, title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: tabOutUrl, title: 'Tab Out', active: false, pinned: false, groupId: -1 },
    { id: 3, windowId: 2, url: 'https://example.com/docs', title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.create, [])
  assert.equal(tabs.find((tab) => tab.id === 2).pinned, false)
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 3, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('focusTab does not create a pinned Tab Out tab when focusing a chip target in another window', async () => {
  const tabOutUrl = 'chrome-extension://tab-out/index.html'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: tabOutUrl, title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: 'https://example.com/docs', title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.create, [])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('focusTab asks the owning suspender extension to unsuspend an exact suspended match', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'marvellous',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('focusTab unsuspends directly when the owning suspender extension cannot be messaged', async () => {
  const suspendedUrl = 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'blocked',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true, url: 'https://example.com/docs' } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2).url, 'https://example.com/docs')
})

test('focusTab unsuspends directly when the owning suspender extension rejects the request', async () => {
  const suspendedUrl = 'chrome-extension://rejects/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusTab('https://example.com/docs')

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'rejects',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true, url: 'https://example.com/docs' } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2).url, 'https://example.com/docs')
})

test('focusHistoryEntry uses the same suspended-tab activation path as page chips', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusHistoryEntry({
    exists: true,
    tabId: 2,
    windowId: 2,
    url: 'https://example.com/docs',
    rawUrl: suspendedUrl
  } as any)

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'marvellous',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
})

test('focusWorkingSetItem falls back to the effective URL for blocked suspended tabs', async () => {
  const suspendedUrl = 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'chrome-extension://tab-out/index.html', title: 'Tab Out', active: true, pinned: false, groupId: -1 },
    { id: 2, windowId: 2, url: suspendedUrl, title: 'Docs', active: false, pinned: false, groupId: -1 }
  ])

  const focused = await focusWorkingSetItem({
    tabId: 2,
    windowId: 2,
    tabUrl: 'https://example.com/docs',
    rawUrl: suspendedUrl
  })

  assert.equal(focused, true)
  assert.deepEqual(calls.runtimeMessages, [
    {
      extensionId: 'blocked',
      message: { action: 'unsuspend', tabId: 2 }
    }
  ])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true, url: 'https://example.com/docs' } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2).url, 'https://example.com/docs')
})

test('closeHistoryEntry removes the exact history tab and returns an undo snapshot', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 },
    { id: 2, windowId: 2, url: 'https://example.com/docs', title: 'Docs', active: false, pinned: true, groupId: 4, index: 3 }
  ])

  const result = await closeHistoryEntry({ exists: true, tabId: 2 } as any)

  assert.equal(result.closed, true)
  assert.deepEqual(calls.remove, [2])
  assert.equal(tabs.some((tab) => tab.id === 2), false)
  assert.deepEqual(result.snapshot, [
    {
      url: 'https://example.com/docs',
      rawUrl: 'https://example.com/docs',
      title: 'Docs',
      pinned: true,
      groupId: 4,
      windowId: 2,
      index: 3
    }
  ])
})

test('undoLastClose restores tabs and requests animated dashboard refresh', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])
  let refreshOptions = null
  const unregister = registerDashboardRefresh((options) => {
    refreshOptions = options
  })

  markClosure([
    {
      url: 'https://example.com/docs',
      title: 'Docs',
      pinned: true,
      groupId: -1,
      windowId: 1,
      index: 1
    }
  ])
  await undoLastClose()
  unregister()

  assert.deepEqual(calls.create, [
    {
      url: 'https://example.com/docs',
      windowId: 1,
      index: 1,
      pinned: true,
      active: false
    }
  ])
  assert.equal(tabs.some((tab) => tab.url === 'https://example.com/docs'), true)
  assert.deepEqual(refreshOptions, { animateCards: true })
})

test('snapshotChromeTabs stores raw suspended URL for undo and effective URL for matching', () => {
  const rawUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs%3Fq%3D1'

  const snapshot = snapshotChromeTabs([
    {
      url: rawUrl,
      title: rawUrl,
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 2
    }
  ])

  assert.deepEqual(snapshot, [
    {
      url: 'https://example.com/docs?q=1',
      rawUrl,
      title: rawUrl,
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 2
    }
  ])
})

test('undoLastClose restores raw suspended URL before falling back to effective URL', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 }
  ])

  markClosure([
    {
      url: 'https://example.com/docs',
      rawUrl: 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs',
      title: 'Docs',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 1
    }
  ])
  await undoLastClose()

  assert.equal(calls.create[0].url, 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs')
  assert.equal(tabs.some((tab) => tab.url === 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'), true)

  markClosure([
    {
      url: 'https://example.com/docs',
      rawUrl: 'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs',
      title: 'Docs',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 2
    }
  ])
  await undoLastClose()

  assert.deepEqual(calls.create.slice(-2).map((call) => call.url), [
    'chrome-extension://blocked/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs',
    'https://example.com/docs'
  ])
  assert.equal(tabs.some((tab) => tab.url === 'https://example.com/docs'), true)
})

test('undoLastClose restores same-window tabs in their original tab-strip order', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: 'https://alpha.example/', title: 'Alpha', active: true, pinned: false, groupId: -1, index: 0 },
    { id: 2, windowId: 1, url: 'https://charlie.example/', title: 'Charlie', active: false, pinned: false, groupId: -1, index: 1 },
    { id: 3, windowId: 1, url: 'https://echo.example/', title: 'Echo', active: false, pinned: false, groupId: -1, index: 2 }
  ])

  markClosure([
    {
      url: 'https://delta.example/',
      title: 'Delta',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 3
    },
    {
      url: 'https://bravo.example/',
      title: 'Bravo',
      pinned: false,
      groupId: -1,
      windowId: 1,
      index: 1
    }
  ])
  await undoLastClose()

  assert.deepEqual(calls.create.map(({ url, windowId, index, active }) => ({ url, windowId, index, active })), [
    { url: 'https://bravo.example/', windowId: 1, index: 1, active: false },
    { url: 'https://delta.example/', windowId: 1, index: 3, active: false }
  ])
  assert.equal(tabs.find((tab) => tab.url === 'https://bravo.example/')?.index, 1)
  assert.equal(tabs.find((tab) => tab.url === 'https://delta.example/')?.index, 3)
})
