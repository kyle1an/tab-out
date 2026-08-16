import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildDesktopWindowMergePlan,
  desktopWindowMergePlansMatch,
} from '../src/extension/background/desktop-window-merge-plan.js'

function window(id: number, state: chrome.windows.Window['state'] = 'normal') {
  return {
    focused: id === 10,
    id,
    incognito: false,
    state,
    type: 'normal',
  } as chrome.windows.Window
}

function tab(
  id: number,
  windowId: number,
  index: number,
  extra: Partial<chrome.tabs.Tab> = {},
) {
  return {
    active: index === 0,
    groupId: -1,
    id,
    index,
    pendingUrl: undefined,
    pinned: false,
    title: `Example ${id}`,
    url: `https://example.test/${id}`,
    windowId,
    ...extra,
  } as chrome.tabs.Tab
}

function group(id: number, windowId: number, title: string) {
  return {
    collapsed: true,
    color: 'blue',
    id,
    title,
    windowId,
  } as chrome.tabGroups.TabGroup
}

test('planner preserves destination content, source order, pins, and whole groups', () => {
  const result = buildDesktopWindowMergePlan({
    destinationWindowId: 10,
    windowIds: [20, 10, 30],
    windows: [window(10), window(20), window(30, 'maximized')],
    tabs: [
      tab(1, 10, 0, { active: true, pinned: true }),
      tab(2, 10, 1, { active: false }),
      tab(3, 20, 0, { active: true, pinned: true }),
      tab(4, 20, 1, { active: false, groupId: 41 }),
      tab(5, 20, 2, {
        active: false,
        discarded: true,
        groupId: 41,
        mutedInfo: { muted: true },
      }),
      tab(6, 20, 3, { active: false }),
      tab(7, 30, 0, { active: true, pinned: true }),
      tab(8, 30, 1, { active: false, groupId: 42 }),
    ],
    groups: [group(41, 20, 'Example group'), group(42, 30, 'Another group')],
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.plan.destinationActiveTabId, 1)
  assert.equal(result.plan.sourceWindowCount, 2)
  assert.deepEqual(result.plan.movingTabIds, [3, 4, 5, 6, 7, 8])
  assert.deepEqual(result.plan.pinnedTabIds, [3, 7])
  assert.deepEqual(result.plan.unpinnedUnits, [
    { kind: 'group', groupId: 41, tabIds: [4, 5] },
    { kind: 'tab', tabId: 6 },
    { kind: 'group', groupId: 42, tabIds: [8] },
  ])
  assert.deepEqual(
    result.plan.tabSnapshots.find((candidate) => candidate.id === 5),
    {
      active: false,
      discarded: true,
      groupId: 41,
      id: 5,
      index: 2,
      muted: true,
      pinned: false,
      rawUrl: 'https://example.test/5',
      windowId: 20,
    },
  )
})

test('planner accepts group zero and fails closed for minimized windows and malformed group strips', () => {
  const zeroGroup = buildDesktopWindowMergePlan({
    destinationWindowId: 10,
    windowIds: [10, 20],
    windows: [window(10), window(20)],
    tabs: [tab(1, 10, 0), tab(2, 20, 0, { groupId: 0 })],
    groups: [group(0, 20, 'Example group')],
  })
  assert.equal(zeroGroup.ok, true)

  const minimized = buildDesktopWindowMergePlan({
    destinationWindowId: 10,
    windowIds: [10, 20],
    windows: [window(10), window(20, 'minimized')],
    tabs: [tab(1, 10, 0), tab(2, 20, 0)],
    groups: [],
  })
  assert.deepEqual(minimized, { ok: false, reason: 'window-inventory-changed' })

  const splitGroup = buildDesktopWindowMergePlan({
    destinationWindowId: 10,
    windowIds: [10, 20],
    windows: [window(10), window(20)],
    tabs: [
      tab(1, 10, 0),
      tab(2, 20, 0, { groupId: 41 }),
      tab(3, 20, 1, { active: false }),
      tab(4, 20, 2, { active: false, groupId: 41 }),
    ],
    groups: [group(41, 20, 'Example group')],
  })
  assert.deepEqual(splitGroup, { ok: false, reason: 'group-inventory-changed' })
})

test('preview matching detects tab state, navigation, and group metadata changes', () => {
  const input = {
    destinationWindowId: 10,
    windowIds: [10, 20],
    windows: [window(10), window(20)],
    tabs: [tab(1, 10, 0), tab(2, 20, 0, { groupId: 41 })],
    groups: [group(41, 20, 'Example group')],
  }
  const expected = buildDesktopWindowMergePlan(input)
  const navigated = buildDesktopWindowMergePlan({
    ...input,
    tabs: [input.tabs[0]!, { ...input.tabs[1]!, url: 'https://example.test/changed' }],
  })
  const renamed = buildDesktopWindowMergePlan({
    ...input,
    groups: [{ ...input.groups[0]!, title: 'Renamed group' }],
  })
  const muted = buildDesktopWindowMergePlan({
    ...input,
    tabs: [input.tabs[0]!, {
      ...input.tabs[1]!,
      mutedInfo: { muted: true },
    }],
  })
  const discarded = buildDesktopWindowMergePlan({
    ...input,
    tabs: [input.tabs[0]!, { ...input.tabs[1]!, discarded: true }],
  })
  assert.equal(expected.ok && navigated.ok && desktopWindowMergePlansMatch(expected.plan, navigated.plan), false)
  assert.equal(expected.ok && renamed.ok && desktopWindowMergePlansMatch(expected.plan, renamed.plan), false)
  assert.equal(expected.ok && muted.ok && desktopWindowMergePlansMatch(expected.plan, muted.plan), false)
  assert.equal(expected.ok && discarded.ok && desktopWindowMergePlansMatch(expected.plan, discarded.plan), false)
})

test('preview matching treats a committed pending navigation as the same raw target', () => {
  const input = {
    destinationWindowId: 10,
    windowIds: [10, 20],
    windows: [window(10), window(20)],
    tabs: [
      tab(1, 10, 0),
      tab(2, 20, 0, {
        pendingUrl: 'https://example.test/next',
        url: 'https://example.test/previous',
      }),
    ],
    groups: [],
  }
  const expected = buildDesktopWindowMergePlan(input)
  const committed = buildDesktopWindowMergePlan({
    ...input,
    tabs: [input.tabs[0]!, {
      ...input.tabs[1]!,
      pendingUrl: undefined,
      url: 'https://example.test/next',
    }],
  })

  assert.equal(
    expected.ok && committed.ok && desktopWindowMergePlansMatch(expected.plan, committed.plan),
    true,
  )
})
