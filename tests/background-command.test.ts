import assert from 'node:assert/strict'
import test from 'node:test'
import { Effect } from 'effect'

import { openFilterTabEffect } from '../src/extension/background/filter-command.js'
import { openNewTabEffect } from '../src/extension/background/new-tab-command.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'

type CommandApiCalls = {
  tabCreate: chrome.tabs.CreateProperties[]
  windowCreate: chrome.windows.CreateData[]
  windowUpdate: Array<{ windowId: number, updateInfo: chrome.windows.UpdateInfo }>
}

function createStaleWindowCommandApi() {
  const calls: CommandApiCalls = {
    tabCreate: [],
    windowCreate: [],
    windowUpdate: [],
  }
  const chromeApi = {
    runtime: { id: 'tab-out' },
    tabs: {
      async create(createProperties: chrome.tabs.CreateProperties) {
        calls.tabCreate.push(createProperties)
        if (createProperties.windowId === 1) throw new Error('Window 1 closed before tab creation')
        return { id: 10, windowId: 2 } as chrome.tabs.Tab
      },
    },
    windows: {
      async getLastFocused() {
        return { id: 1, type: 'normal', focused: true } as chrome.windows.Window
      },
      async getAll() {
        return [
          { id: 1, type: 'normal', focused: true },
          { id: 2, type: 'normal', focused: false },
        ] as chrome.windows.Window[]
      },
      async update(windowId: number, updateInfo: chrome.windows.UpdateInfo) {
        calls.windowUpdate.push({ windowId, updateInfo })
        return { id: windowId, type: 'normal', focused: true } as chrome.windows.Window
      },
      async create(createData: chrome.windows.CreateData) {
        calls.windowCreate.push(createData)
        return { id: 3, type: 'normal' } as chrome.windows.Window
      },
    },
  } as unknown as ChromeApi

  return { calls, chromeApi }
}

test('open-filter retries a fresh normal-window selection when the selected window closes', async () => {
  const { calls, chromeApi } = createStaleWindowCommandApi()

  await Effect.runPromise(openFilterTabEffect(chromeApi))

  assert.deepEqual(calls.tabCreate, [
    {
      windowId: 1,
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      active: true,
    },
    {
      windowId: 2,
      url: 'chrome-extension://tab-out/index.html?focusFilter=1',
      active: true,
    },
  ])
  assert.deepEqual(calls.windowUpdate, [{ windowId: 2, updateInfo: { focused: true } }])
  assert.deepEqual(calls.windowCreate, [])
})

test('open-filter retries window activation when Chrome leaves the target unfocused', async () => {
  const windowUpdates: Array<{ windowId: number, updateInfo: chrome.windows.UpdateInfo }> = []
  const chromeApi = {
    runtime: { id: 'tab-out' },
    tabs: {
      create: async () => ({ id: 10, windowId: 2 }) as chrome.tabs.Tab,
    },
    windows: {
      getLastFocused: async () => ({ id: 2, type: 'normal', focused: false }) as chrome.windows.Window,
      getAll: async () => [{ id: 2, type: 'normal', focused: false }] as chrome.windows.Window[],
      update: async (windowId: number, updateInfo: chrome.windows.UpdateInfo) => {
        windowUpdates.push({ windowId, updateInfo })
        return { id: windowId, type: 'normal', focused: windowUpdates.length > 1 } as chrome.windows.Window
      },
      create: async () => {
        throw new Error('should not create a replacement window')
      },
    },
  } as unknown as ChromeApi

  await Effect.runPromise(openFilterTabEffect(chromeApi))

  assert.deepEqual(windowUpdates, [
    { windowId: 2, updateInfo: { focused: true } },
    { windowId: 2, updateInfo: { focused: true } },
  ])
})

test('open-new-tab retries a fresh normal-window selection when the selected window closes', async () => {
  const { calls, chromeApi } = createStaleWindowCommandApi()

  await Effect.runPromise(openNewTabEffect(chromeApi))

  assert.deepEqual(calls.tabCreate, [
    { windowId: 1, active: true },
    { windowId: 2, active: true },
  ])
  assert.deepEqual(calls.windowUpdate, [{ windowId: 2, updateInfo: { focused: true } }])
  assert.deepEqual(calls.windowCreate, [])
})

test('open-new-tab tries every existing normal window before creating another', async () => {
  const attempts: number[] = []
  const chromeApi = {
    runtime: { id: 'tab-out' },
    tabs: {
      create: async ({ windowId }: chrome.tabs.CreateProperties) => {
        attempts.push(windowId as number)
        if (windowId === 1 || windowId === 2) throw new Error('window closed')
        return { id: 10, windowId } as chrome.tabs.Tab
      },
    },
    windows: {
      getLastFocused: async () => ({ id: 1, type: 'normal', focused: true }),
      getAll: async () => [
        { id: 1, type: 'normal', focused: true },
        { id: 2, type: 'normal', focused: false },
        { id: 3, type: 'normal', focused: false },
      ],
      update: async (windowId: number) => ({ id: windowId, type: 'normal', focused: true }),
      create: async () => { throw new Error('should not create a fourth window') },
    },
  } as unknown as ChromeApi

  await Effect.runPromise(openNewTabEffect(chromeApi))

  assert.deepEqual(attempts, [1, 2, 3])
})
