import assert from 'node:assert/strict'
import test from 'node:test'

import { moveTabToCurrentWindow, moveTabToNewWindow } from '../src/extension/tab-move.js'

function createChromeMock(initialTabs: any[], currentWindowId = 1) {
  const tabs = initialTabs.map((tab) => ({ ...tab }))
  const calls: any = { move: [], tabsGet: 0, tabsQuery: 0, tabsUpdate: [], windowsCreate: [], windowsUpdate: [], runtimeMessages: [] }

  ;(globalThis as any).chrome = {
    runtime: {
      id: 'tab-out',
      async sendMessage(extensionId: string, message: unknown) {
        calls.runtimeMessages.push({ extensionId, message: { ...(message as object) } })
        return undefined
      }
    },
    tabs: {
      async get(tabId: number) {
        calls.tabsGet += 1
        const tab = tabs.find((candidate) => candidate.id === tabId)
        if (!tab) throw new Error(`No tab with id: ${tabId}`)
        return { ...tab }
      },
      async query() {
        calls.tabsQuery += 1
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
      async create(createProperties: any) {
        calls.windowsCreate.push({ ...createProperties })
        const windowId = Math.max(0, ...tabs.map((tab) => Number(tab.windowId) || 0)) + 1
        if (typeof createProperties.tabId === 'number') {
          const tab = tabs.find((candidate) => candidate.id === createProperties.tabId)
          if (tab) tab.windowId = windowId
        }
        return { id: windowId, type: createProperties.type || 'normal', focused: !!createProperties.focused }
      },
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

  assert.equal(moved, 'handled')
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

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 1, updateProperties: { focused: true } }])
  assert.equal(calls.tabsQuery, 1)
  assert.equal(calls.tabsGet, 1)
})

test('moveTabToCurrentWindow does not move a tab already in the current window (background no-op)', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' }, { activate: false })

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.move, [])
  assert.deepEqual(calls.tabsUpdate, [])
})

test('moveTabToCurrentWindow switches to an already-current-window tab without moving (foreground)', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' }, { activate: true })

  assert.equal(moved, 'handled')
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

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.move, [{ tabId: 3, moveProperties: { windowId: 1, index: -1 } }])
})

test('moveTabToCurrentWindow resolves against pending navigation identity', async () => {
  const targetUrl = 'https://example.test/docs'
  const otherUrl = 'https://example.test/other'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: targetUrl, pendingUrl: otherUrl },
    { id: 3, windowId: 2, url: otherUrl, pendingUrl: targetUrl }
  ])

  const moved = await moveTabToCurrentWindow({ tabUrl: targetUrl }, { activate: false })

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.move, [{ tabId: 3, moveProperties: { windowId: 1, index: -1 } }])
})

test('moveTabToCurrentWindow rejects a numeric target navigating away from its rendered URL', async () => {
  const targetUrl = 'https://example.test/docs'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: targetUrl, pendingUrl: 'https://example.test/other' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: targetUrl })

  assert.equal(moved, 'not-found')
  assert.deepEqual(calls.move, [])
})

test('moveTabToCurrentWindow reads tabs after current-window state settles', async () => {
  const targetUrl = 'https://example.test/docs'
  const pendingUrl = 'https://example.test/other'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: targetUrl }
  ])
  let releaseCurrentWindow!: () => void
  const currentWindowGate = new Promise<void>((resolve) => {
    releaseCurrentWindow = resolve
  })
  let navigationStarted = false
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    await currentWindowGate
    navigationStarted = true
    return { id: 1, type: 'normal' }
  }
  ;(globalThis as any).chrome.tabs.query = async () => {
    calls.tabsQuery += 1
    return [{
      id: 2,
      windowId: 2,
      url: targetUrl,
      ...(navigationStarted ? { pendingUrl } : {})
    }]
  }

  const resultPromise = moveTabToCurrentWindow({ tabId: 2, tabUrl: targetUrl })
  await Promise.resolve()

  assert.equal(calls.tabsQuery, 0)
  releaseCurrentWindow()
  const result = await resultPromise

  assert.equal(result, 'not-found')
  assert.equal(calls.tabsQuery, 1)
  assert.deepEqual(calls.move, [])
})

test('moveTabToCurrentWindow reports not-found when no open tab matches', async () => {
  const { calls } = createChromeMock([{ id: 1, windowId: 1, url: TAB_OUT }])

  const moved = await moveTabToCurrentWindow({ tabUrl: 'https://nope.example/' }, { activate: false })

  assert.equal(moved, 'not-found')
  assert.deepEqual(calls.move, [])
})

test('moveTabToCurrentWindow reports failed when the tab inventory is unknown', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])
  ;(globalThis as any).chrome.tabs.query = async () => {
    throw new Error('tabs unavailable')
  }

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' })

  assert.equal(moved, 'failed')
  assert.deepEqual(calls.move, [])
})

test('moveTabToCurrentWindow reports failed when the current window is unknown', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    throw new Error('window unavailable')
  }

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' })

  assert.equal(moved, 'failed')
  assert.deepEqual(calls.move, [])
})

test('moveTabToCurrentWindow reports failed rather than missing when Chrome refuses the move', async () => {
  createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])
  let attempts = 0
  ;(globalThis as any).chrome.tabs.move = async () => {
    attempts += 1
    throw new Error('move refused')
  }

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://example.com/docs' })

  assert.equal(moved, 'failed')
  assert.equal(attempts, 1)
})

test('moveTabToCurrentWindow keeps a successful physical move handled when later activation fails', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])
  ;(globalThis as any).chrome.tabs.update = async () => {
    throw new Error('activation refused')
  }

  const moved = await moveTabToCurrentWindow(
    { tabId: 2, tabUrl: 'https://example.com/docs' },
    { activate: true }
  )

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
  assert.deepEqual(calls.windowsUpdate, [])
})

test('moveTabToCurrentWindow does not activate a target that navigates after inventory resolution', async () => {
  const targetUrl = 'https://example.com/docs'
  const navigatedUrl = 'https://example.com/other'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: targetUrl }
  ])
  const queryTabs = (globalThis as any).chrome.tabs.query.bind((globalThis as any).chrome.tabs)
  ;(globalThis as any).chrome.tabs.query = async () => {
    const snapshot = await queryTabs()
    tabs[1].url = navigatedUrl
    return snapshot
  }

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: targetUrl }, { activate: true })

  assert.equal(moved, 'failed')
  assert.deepEqual(calls.tabsUpdate, [])
  assert.equal(tabs[1]?.url, navigatedUrl)
})

test('moveTabToCurrentWindow rejects a reused id when no live tab matches the target URL', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://unrelated.example/' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://expected.example/' })

  assert.equal(moved, 'not-found')
  assert.deepEqual(calls.move, [])
})

test('moveTabToCurrentWindow does not substitute a same-URL sibling for a missing numeric target', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://unrelated.example/' },
    { id: 3, windowId: 2, url: 'https://expected.example/' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 2, tabUrl: 'https://expected.example/' })

  assert.equal(moved, 'not-found')
  assert.deepEqual(calls.move, [])
  assert.deepEqual(calls.tabsUpdate, [])
})

test('moveTabToCurrentWindow treats a synthetic string tabId as no id and resolves by URL', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToCurrentWindow({ tabId: 'saved-abc', tabUrl: 'https://example.com/docs' }, { activate: false })

  assert.equal(moved, 'handled')
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

  assert.equal(moved, 'handled')
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

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.move, [{ tabId: 2, moveProperties: { windowId: 1, index: -1 } }])
  assert.deepEqual(calls.runtimeMessages, [{ extensionId: 'marvellous', message: { action: 'unsuspend', tabId: 2 } }])
  assert.deepEqual(calls.tabsUpdate, [])
  assert.deepEqual(calls.windowsUpdate, [])
})

test('moveTabToNewWindow moves a live tab into a focused new window', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToNewWindow({ tabId: 2, tabUrl: 'https://example.com/docs' })

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.windowsCreate, [{ tabId: 2, focused: true, type: 'normal' }])
  assert.deepEqual(calls.move, [])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2)?.windowId, 2)
  assert.equal(calls.tabsQuery, 1)
  assert.equal(calls.tabsGet, 1)
})

test('moveTabToNewWindow resolves by URL when no tabId', async () => {
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: 'https://example.com/docs' }
  ])

  const moved = await moveTabToNewWindow({ tabUrl: 'https://example.com/docs' })

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.windowsCreate, [{ tabId: 2, focused: true, type: 'normal' }])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 3, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2)?.windowId, 3)
})

test('moveTabToNewWindow reads tabs after current-window state settles', async () => {
  const targetUrl = 'https://example.test/docs'
  const pendingUrl = 'https://example.test/other'
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 2, url: targetUrl }
  ])
  let releaseCurrentWindow!: () => void
  const currentWindowGate = new Promise<void>((resolve) => {
    releaseCurrentWindow = resolve
  })
  let navigationStarted = false
  ;(globalThis as any).chrome.windows.getCurrent = async () => {
    await currentWindowGate
    navigationStarted = true
    return { id: 1, type: 'normal' }
  }
  ;(globalThis as any).chrome.tabs.query = async () => {
    calls.tabsQuery += 1
    return [{
      id: 2,
      windowId: 2,
      url: targetUrl,
      ...(navigationStarted ? { pendingUrl } : {})
    }]
  }

  const resultPromise = moveTabToNewWindow({ tabId: 2, tabUrl: targetUrl })
  await Promise.resolve()

  assert.equal(calls.tabsQuery, 0)
  releaseCurrentWindow()
  const result = await resultPromise

  assert.equal(result, 'not-found')
  assert.equal(calls.tabsQuery, 1)
  assert.deepEqual(calls.windowsCreate, [])
})

test('moveTabToNewWindow reports not-found when no open tab matches', async () => {
  const { calls } = createChromeMock([{ id: 1, windowId: 1, url: TAB_OUT }])

  const moved = await moveTabToNewWindow({ tabUrl: 'https://nope.example/' })

  assert.equal(moved, 'not-found')
  assert.deepEqual(calls.windowsCreate, [])
  assert.deepEqual(calls.tabsUpdate, [])
  assert.deepEqual(calls.windowsUpdate, [])
})

test('moveTabToNewWindow reports failed when the tab inventory is unknown', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' }
  ])
  ;(globalThis as any).chrome.tabs.query = async () => {
    throw new Error('tabs unavailable')
  }

  const moved = await moveTabToNewWindow({ tabId: 2, tabUrl: 'https://example.com/docs' })

  assert.equal(moved, 'failed')
  assert.deepEqual(calls.windowsCreate, [])
})

test('moveTabToNewWindow reports failed rather than missing when Chrome refuses the new window', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://example.com/docs' }
  ])
  ;(globalThis as any).chrome.windows.create = async (createProperties: any) => {
    calls.windowsCreate.push({ ...createProperties })
    throw new Error('create refused')
  }

  const moved = await moveTabToNewWindow({ tabId: 2, tabUrl: 'https://example.com/docs' })

  assert.equal(moved, 'failed')
  assert.deepEqual(calls.windowsCreate, [{ tabId: 2, focused: true, type: 'normal' }])
})

test('moveTabToNewWindow does not substitute a same-URL sibling for a missing numeric target', async () => {
  const { calls } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: 'https://unrelated.example/' },
    { id: 3, windowId: 1, url: 'https://expected.example/' }
  ])

  const moved = await moveTabToNewWindow({ tabId: 2, tabUrl: 'https://expected.example/' })

  assert.equal(moved, 'not-found')
  assert.deepEqual(calls.windowsCreate, [])
  assert.deepEqual(calls.tabsUpdate, [])
})

test('moveTabToNewWindow unsuspends a suspended tab after moving it', async () => {
  const suspendedUrl = 'chrome-extension://marvellous/suspended.html#ttl=Docs&uri=https%3A%2F%2Fexample.com%2Fdocs'
  const { calls, tabs } = createChromeMock([
    { id: 1, windowId: 1, url: TAB_OUT },
    { id: 2, windowId: 1, url: suspendedUrl }
  ])

  const moved = await moveTabToNewWindow({ tabId: 2, tabUrl: 'https://example.com/docs', rawUrl: suspendedUrl })

  assert.equal(moved, 'handled')
  assert.deepEqual(calls.windowsCreate, [{ tabId: 2, focused: true, type: 'normal' }])
  assert.deepEqual(calls.runtimeMessages, [{ extensionId: 'marvellous', message: { action: 'unsuspend', tabId: 2 } }])
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 2, updateProperties: { active: true } }])
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 2, updateProperties: { focused: true } }])
  assert.equal(tabs.find((tab) => tab.id === 2)?.windowId, 2)
})
