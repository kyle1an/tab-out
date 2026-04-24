import assert from 'node:assert/strict'
import test from 'node:test'

import { focusTab } from '../extension/tabs.js'

function createChromeMock(initialTabs, currentWindowId = 1) {
  const tabs = initialTabs.map((tab) => ({ ...tab }))
  const calls = {
    create: [],
    tabsUpdate: [],
    windowsUpdate: []
  }

  globalThis.chrome = {
    runtime: {
      id: 'tab-out'
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
        const nextId = Math.max(0, ...tabs.map((tab) => Number(tab.id) || 0)) + 1
        const tab = {
          id: nextId,
          windowId: createProperties.windowId ?? currentWindowId,
          url: createProperties.url || 'chrome://newtab/',
          title: '',
          active: !!createProperties.active,
          pinned: !!createProperties.pinned,
          groupId: -1
        }
        tabs.push(tab)
        return { ...tab }
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
