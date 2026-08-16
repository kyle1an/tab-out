const DESKTOP_WINDOW_MERGE_UNGROUPED_ID = -1

type DesktopWindowMergePlanFailure =
  | 'group-inventory-changed'
  | 'tab-inventory-changed'
  | 'window-inventory-changed'

interface DesktopWindowMergeTabSnapshot {
  readonly active: boolean
  readonly discarded: boolean
  readonly groupId: number
  readonly id: number
  readonly index: number
  readonly muted: boolean
  readonly pinned: boolean
  readonly rawUrl: string
  readonly windowId: number
}

interface DesktopWindowMergeGroupSnapshot {
  readonly collapsed: boolean
  readonly color: chrome.tabGroups.TabGroup['color']
  readonly id: number
  readonly shared: boolean
  readonly title: string
  readonly windowId: number
}

export type DesktopWindowMergeUnit =
  | {
    readonly kind: 'group'
    readonly groupId: number
    readonly tabIds: readonly number[]
  }
  | {
    readonly kind: 'tab'
    readonly tabId: number
  }

export interface DesktopWindowMergePlan {
  readonly destinationActiveTabId: number
  readonly destinationWindowId: number
  readonly groupSnapshots: readonly DesktopWindowMergeGroupSnapshot[]
  readonly movingTabIds: readonly number[]
  readonly pinnedTabIds: readonly number[]
  readonly snapshotKey: string
  readonly sourceWindowCount: number
  readonly tabSnapshots: readonly DesktopWindowMergeTabSnapshot[]
  readonly unpinnedUnits: readonly DesktopWindowMergeUnit[]
  readonly windowIds: readonly number[]
}

export type DesktopWindowMergePlanResult =
  | { readonly ok: true, readonly plan: DesktopWindowMergePlan }
  | { readonly ok: false, readonly reason: DesktopWindowMergePlanFailure }

export interface DesktopWindowMergePlanInput {
  readonly destinationWindowId: number
  readonly groups: readonly chrome.tabGroups.TabGroup[]
  readonly tabs: readonly chrome.tabs.Tab[]
  readonly windowIds: readonly number[]
  readonly windows: readonly chrome.windows.Window[]
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

function groupSnapshot(
  group: chrome.tabGroups.TabGroup,
): DesktopWindowMergeGroupSnapshot | null {
  if (
    !nonNegativeInteger(group.id) ||
    !positiveInteger(group.windowId) ||
    typeof group.collapsed !== 'boolean' ||
    typeof group.color !== 'string'
  ) return null
  return {
    collapsed: group.collapsed,
    color: group.color,
    id: group.id,
    shared: group.shared === true,
    title: group.title ?? '',
    windowId: group.windowId,
  }
}

function tabSnapshot(tab: chrome.tabs.Tab): DesktopWindowMergeTabSnapshot | null {
  if (
    !positiveInteger(tab.id) ||
    !positiveInteger(tab.windowId) ||
    !nonNegativeInteger(tab.index) ||
    !Number.isInteger(tab.groupId) ||
    typeof tab.active !== 'boolean' ||
    typeof tab.pinned !== 'boolean'
  ) return null
  return {
    active: tab.active,
    discarded: tab.discarded === true,
    groupId: tab.groupId,
    id: tab.id,
    index: tab.index,
    muted: tab.mutedInfo?.muted === true,
    pinned: tab.pinned,
    rawUrl: tab.pendingUrl || tab.url || '',
    windowId: tab.windowId,
  }
}

function buildSnapshotKey(
  windowIds: readonly number[],
  tabs: readonly DesktopWindowMergeTabSnapshot[],
  groups: readonly DesktopWindowMergeGroupSnapshot[],
): string {
  return JSON.stringify({ windowIds, tabs, groups })
}

export function buildDesktopWindowMergePlan(
  input: DesktopWindowMergePlanInput,
): DesktopWindowMergePlanResult {
  const windowIds = [...input.windowIds]
  if (
    !positiveInteger(input.destinationWindowId) ||
    !windowIds.includes(input.destinationWindowId) ||
    windowIds.some((windowId) => !positiveInteger(windowId)) ||
    new Set(windowIds).size !== windowIds.length
  ) return { ok: false, reason: 'window-inventory-changed' }

  const windowsById = new Map<number, chrome.windows.Window>()
  for (const window of input.windows) {
    if (!positiveInteger(window.id) || windowsById.has(window.id)) continue
    windowsById.set(window.id, window)
  }
  for (const windowId of windowIds) {
    const window = windowsById.get(windowId)
    if (
      !window ||
      window.type !== 'normal' ||
      (window.state !== 'normal' && window.state !== 'maximized') ||
      window.incognito === true ||
      (windowId === input.destinationWindowId && window.focused !== true)
    ) return { ok: false, reason: 'window-inventory-changed' }
  }

  const selectedWindowIds = new Set(windowIds)
  const tabs: DesktopWindowMergeTabSnapshot[] = []
  for (const tab of input.tabs) {
    if (!selectedWindowIds.has(tab.windowId)) continue
    const snapshot = tabSnapshot(tab)
    if (!snapshot) return { ok: false, reason: 'tab-inventory-changed' }
    tabs.push(snapshot)
  }
  if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
    return { ok: false, reason: 'tab-inventory-changed' }
  }

  const tabsByWindow = new Map<number, DesktopWindowMergeTabSnapshot[]>()
  for (const windowId of windowIds) tabsByWindow.set(windowId, [])
  for (const tab of tabs) tabsByWindow.get(tab.windowId)?.push(tab)
  for (const windowTabs of tabsByWindow.values()) {
    windowTabs.sort((left, right) => left.index - right.index)
    if (
      windowTabs.length === 0 ||
      windowTabs.filter((tab) => tab.active).length !== 1 ||
      windowTabs.some((tab, index) => tab.index !== index)
    ) return { ok: false, reason: 'tab-inventory-changed' }

    let sawUnpinned = false
    for (const tab of windowTabs) {
      if (!tab.pinned) sawUnpinned = true
      if ((tab.pinned && sawUnpinned) || (tab.pinned && tab.groupId !== -1)) {
        return { ok: false, reason: 'tab-inventory-changed' }
      }
    }
  }

  const referencedGroupIds = new Set<number>()
  for (const tab of tabs) {
    if (tab.groupId !== DESKTOP_WINDOW_MERGE_UNGROUPED_ID) {
      referencedGroupIds.add(tab.groupId)
    }
  }
  const groupSnapshots: DesktopWindowMergeGroupSnapshot[] = []
  const groupsById = new Map<number, DesktopWindowMergeGroupSnapshot>()
  for (const group of input.groups) {
    if (!referencedGroupIds.has(group.id)) continue
    const snapshot = groupSnapshot(group)
    if (!snapshot || groupsById.has(snapshot.id)) {
      return { ok: false, reason: 'group-inventory-changed' }
    }
    groupsById.set(snapshot.id, snapshot)
    groupSnapshots.push(snapshot)
  }
  if (groupsById.size !== referencedGroupIds.size) {
    return { ok: false, reason: 'group-inventory-changed' }
  }
  for (const tab of tabs) {
    if (tab.groupId === DESKTOP_WINDOW_MERGE_UNGROUPED_ID) continue
    if (groupsById.get(tab.groupId)?.windowId !== tab.windowId) {
      return { ok: false, reason: 'group-inventory-changed' }
    }
  }

  for (const windowTabs of tabsByWindow.values()) {
    const closedGroups = new Set<number>()
    let currentGroupId = DESKTOP_WINDOW_MERGE_UNGROUPED_ID
    for (const tab of windowTabs) {
      if (tab.groupId === currentGroupId) continue
      if (currentGroupId !== DESKTOP_WINDOW_MERGE_UNGROUPED_ID) {
        closedGroups.add(currentGroupId)
      }
      currentGroupId = tab.groupId
      if (currentGroupId !== DESKTOP_WINDOW_MERGE_UNGROUPED_ID && closedGroups.has(currentGroupId)) {
        return { ok: false, reason: 'group-inventory-changed' }
      }
    }
  }

  const sourceWindowIds = windowIds.filter((windowId) => windowId !== input.destinationWindowId)
  const movingTabIds: number[] = []
  const pinnedTabIds: number[] = []
  const unpinnedUnits: DesktopWindowMergeUnit[] = []
  for (const sourceWindowId of sourceWindowIds) {
    const sourceTabs = tabsByWindow.get(sourceWindowId) ?? []
    for (const tab of sourceTabs) {
      movingTabIds.push(tab.id)
      if (tab.pinned) pinnedTabIds.push(tab.id)
    }

    const emittedGroups = new Set<number>()
    for (const tab of sourceTabs) {
      if (tab.pinned) continue
      if (tab.groupId === DESKTOP_WINDOW_MERGE_UNGROUPED_ID) {
        unpinnedUnits.push({ kind: 'tab', tabId: tab.id })
        continue
      }
      if (emittedGroups.has(tab.groupId)) continue
      emittedGroups.add(tab.groupId)
      const groupTabIds: number[] = []
      for (const candidate of sourceTabs) {
        if (candidate.groupId === tab.groupId) groupTabIds.push(candidate.id)
      }
      unpinnedUnits.push({
        kind: 'group',
        groupId: tab.groupId,
        tabIds: groupTabIds,
      })
    }
  }

  const destinationActiveTab = (tabsByWindow.get(input.destinationWindowId) ?? [])
    .find((tab) => tab.active)
  if (!destinationActiveTab) return { ok: false, reason: 'tab-inventory-changed' }
  groupSnapshots.sort((left, right) => left.id - right.id)
  const orderedTabs = windowIds.flatMap((windowId) => tabsByWindow.get(windowId) ?? [])

  return {
    ok: true,
    plan: {
      destinationActiveTabId: destinationActiveTab.id,
      destinationWindowId: input.destinationWindowId,
      groupSnapshots,
      movingTabIds,
      pinnedTabIds,
      snapshotKey: buildSnapshotKey(windowIds, orderedTabs, groupSnapshots),
      sourceWindowCount: sourceWindowIds.length,
      tabSnapshots: orderedTabs,
      unpinnedUnits,
      windowIds,
    },
  }
}

export function desktopWindowMergePlansMatch(
  expected: DesktopWindowMergePlan,
  current: DesktopWindowMergePlan,
): boolean {
  return expected.destinationWindowId === current.destinationWindowId &&
    expected.snapshotKey === current.snapshotKey
}
