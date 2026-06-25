import assert from 'node:assert/strict'
import test from 'node:test'

import { moveTabToCurrentWindow } from '../src/extension/tab-move.js'

function createChromeMock(initialTabs: any[], currentWindowId = 1) {
  const tabs = initialTabs.map((tab) => ({ ...tab }))
  const calls: any = { move: [], tabsUpdate: [], windowsUpdate: [], runtimeMessages: [] }

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      async sendMessage(extensionId: string, message: unknown) {
        calls.runtimeMessages.push({ extensionId, message: { ...(message as object) } })
        return undefined
      }
    },
    tabs: {
      async query() {
        return tabs.map((tab) => ({ ...tab }))
      },
      async move(tabId: number, moveProperties: any) {
        calls.move.push({ tabId, moveProperties: { ...moveProperties } })
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (tab && typeof moveProperties.windowId === 'number') tab.windowId = moveProperties.windowId
        return tab ? { ...tab } : undefined
      },
      async update(tabId: number, updateProperties: any) {
        calls.tabsUpdate.push({ tabId, updateProperties: { ...updateProperties } })
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) return undefined
        Object.assign(tab, updateProperties)
        return { ...tab }
      }
    },
    windows: {
      async getCurrent() {
        return { id: currentWindowId, type: 'normal' }
      },
      async update(windowId: number, updateProperties: any) {
        calls.windowsUpdate.push({ windowId, updateProperties: { ...updateProperties } })
        return { id: windowId, type: 'normal', focused: !!updateProperties.focused }
      }
    }
  }

  return { calls, tabs }
}

const TAB_OUT = 'chrome-extension://tab-out/index.html'

test('moveTabToCurrentWindow moves a tab from another window in the background', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' }, { activate: false })

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
  assert.deepEqual(calls.tabsUpdate, [])
  assert.deepEqual(calls.windowsUpdate, [])
})

test('moveTabToCurrentWindow moves and switches to the tab in the foreground', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' }, { activate: true })

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 1, updateProperties: { focused: true } }])
})

test('moveTabToCurrentWindow does not move a tab already in the current window (background no-op)', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' }, { activate: false })

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [])
  assert.deepEqual(calls.tabsUpdate, [])
})

test('moveTabToCurrentWindow switches to an already-current-window tab without moving (foreground)', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' }, { activate: true })

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 1, updateProperties: { focused: true } }])
})

test('moveTabToCurrentWindow resolves by URL when no tabId, preferring another window', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' },
    { id: 3, windowId: 2, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabUrl: 'https://example.com/docs' }, { activate: false })

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [{ tabId: 3, moveProperties: { windowId: 1, index: -1 } }])
})

test('moveTabToCurrentWindow returns false when no open tab matches', async () => {
  const { calls } = createChromeMock([{ id: 1, windowId: 1, url: TAB_OUT }])

  const moved = await moveTabToCurrentWindow({ tabUrl: 'https://nope.example/' }, { activate: false })

  assert.equal(moved, false)
  assert.deepEqual(calls.move, [])
})

test('moveTabToCurrentWindow treats a synthetic string tabId as no id and resolves by URL', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 'saved-abc', tabUrl: 'https://example.com/docs' }, { activate: false })

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
})

test('moveTabToCurrentWindow unsuspends a suspended tab when foregrounding', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: suspendedUrl }
  ])

  const moved = await moveTabToCurrentWindow(
    { tabId: 2, tabUrl: 'https://example.com/docs', rawUrl: suspendedUrl },
    { activate: true }
  )

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
  assert.deepEqual(calls.runtimeMessages, [{ extensionId: 'marvellous', message: { action: 'unsuspend', tabId: 2 } }])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
})

test('moveTabToCurrentWindow unsuspends a suspended tab when moving in the background', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: suspendedUrl }
  ])

  const moved = await moveTabToCurrentWindow(
    { tabId: 2, tabUrl: 'https://example.com/docs', rawUrl: suspendedUrl },
    { activate: false }
  )

  assert.equal(moved, true)
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
  assert.deepEqual(calls.runtimeMessages, [{ extensionId: 'marvellous', message: { action: 'unsuspend', tabId: 2 } }])
  assert.deepEqual(calls.tabsUpdate, [])
  assert.deepEqual(calls.windowsUpdate, [])
})
