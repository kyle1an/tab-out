import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkingSetService, WORKING_SET_ACTIVITY_KEY } from '../src/extension/background/working-set-service.js'
import type { ChromeApi } from '../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStore } from '../src/extension/types'

function chromeTab(id: number, path: string, audio: { audible?: boolean; muted?: boolean } = {}): chrome.tabs.Tab {
  return {
    id,
    index: id - 1,
    windowId: 1,
    highlighted: false,
    active: id === 1,
    pinned: false,
    incognito: false,
    selected: id === 1,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: `https://example.test/${path}`,
    title: path,
    audible: audio.audible,
    mutedInfo: { muted: !!audio.muted }
  } as chrome.tabs.Tab
}

test('Working Set snapshots preserve independent browser audio state', async () => {
  const now = Date.now()
  const tabs = [
    chromeTab(1, 'playing', { audible: true }),
    chromeTab(2, 'muted', { muted: true }),
    chromeTab(3, 'silent')
  ]
  const activity: WorkingSetActivityStore = {
    version: 1,
    records: Object.fromEntries(tabs.map((tab, index) => {
      const url = tab.url as string
      const at = now - index * 1_000
      return [url, {
        key: url,
        url,
        title: tab.title || '',
        domain: 'example.test',
        lastSeenAt: at,
        lastActivatedAt: at,
        events: [{ kind: 'activation', at }]
      }]
    }))
  }
  const chromeApi = {
    tabs: {
      query: async () => tabs
    },
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: 'normal' }]
    },
    storage: {
      local: {
        get: async () => ({ [WORKING_SET_ACTIVITY_KEY]: activity })
      }
    }
  } as unknown as ChromeApi

  const snapshot = await createWorkingSetService(chromeApi).getWorkingSetSnapshot()
  const audioByTabId = new Map(snapshot.items.map((item) => [
    item.tabId,
    { audible: item.audible, muted: item.muted }
  ]))

  assert.deepEqual(audioByTabId, new Map([
    [1, { audible: true, muted: false }],
    [2, { audible: false, muted: true }],
    [3, { audible: false, muted: false }]
  ]))
})
