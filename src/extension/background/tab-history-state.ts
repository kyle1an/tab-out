export const MAX_TAB_HISTORY = 24

export type GlobalTabHistoryEntry = {
  windowId: number
  tabId: number
}

export type GlobalTabHistory = {
  stack: GlobalTabHistoryEntry[]
  index: number
}

type GlobalTabHistoryInput = Partial<GlobalTabHistory> | null | undefined

type ActiveTabLike = {
  id?: number
  windowId: number
} | null | undefined

type HistoryChangeResult = {
  history: GlobalTabHistory
  changed: boolean
}

type RepairedHistoryResult = HistoryChangeResult & {
  activeWasInserted: boolean
}

type PrunedHistoryResult = GlobalTabHistory & {
  changed: boolean
}

export function normalizeGlobalHistory(entry: GlobalTabHistoryInput): GlobalTabHistory {
  if (!entry || !Array.isArray(entry.stack)) {
    return { stack: [], index: -1 }
  }
  const stack = entry.stack.filter((item) => item && typeof item.tabId === 'number' && typeof item.windowId === 'number')
  const maxIndex = stack.length - 1
  const rawIndex = entry.index
  const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) ? Math.max(-1, Math.min(rawIndex, maxIndex)) : maxIndex
  return { stack: stack as GlobalTabHistoryEntry[], index }
}

export function historyChanged(a: GlobalTabHistoryInput, b: GlobalTabHistoryInput): boolean {
  const first = normalizeGlobalHistory(a)
  const second = normalizeGlobalHistory(b)
  if (first.index !== second.index || first.stack.length !== second.stack.length) return true
  return first.stack.some((entry, index) => entry.tabId !== second.stack[index].tabId || entry.windowId !== second.stack[index].windowId)
}

function dedupeHistoryByLatestTab(history: GlobalTabHistoryInput): GlobalTabHistory {
  const current = normalizeGlobalHistory(history)
  const latestIndexByTabId = new Map<number, number>()
  current.stack.forEach((entry, index) => latestIndexByTabId.set(entry.tabId, index))

  const nextStack: GlobalTabHistoryEntry[] = []
  const oldIndexToNewIndex = new Map<number, number>()
  current.stack.forEach((entry, index) => {
    if (latestIndexByTabId.get(entry.tabId) !== index) return
    oldIndexToNewIndex.set(index, nextStack.length)
    nextStack.push(entry)
  })

  let nextIndex = -1
  const currentEntry = current.stack[current.index]
  if (currentEntry) {
    const keptOldIndex = latestIndexByTabId.get(currentEntry.tabId)
    nextIndex = keptOldIndex === undefined ? -1 : (oldIndexToNewIndex.get(keptOldIndex) ?? -1)
  }

  return {
    stack: nextStack,
    index: nextStack.length === 0 ? -1 : nextIndex
  }
}

function trimHistoryToMax(history: GlobalTabHistoryInput): GlobalTabHistory {
  const current = normalizeGlobalHistory(history)
  if (current.stack.length <= MAX_TAB_HISTORY) return current

  const dropCount = current.stack.length - MAX_TAB_HISTORY
  return {
    stack: current.stack.slice(dropCount),
    index: current.index === -1 ? -1 : Math.max(0, current.index - dropCount)
  }
}

export function canonicalizeGlobalHistory(history: GlobalTabHistoryInput): HistoryChangeResult {
  const current = normalizeGlobalHistory(history)
  const deduped = dedupeHistoryByLatestTab(current)
  const trimmed = trimHistoryToMax(deduped)
  return {
    history: trimmed,
    changed: historyChanged(current, trimmed)
  }
}

export function removeTabEntriesFromHistory(history: GlobalTabHistoryInput, tabId: number): GlobalTabHistory {
  const current = normalizeGlobalHistory(history)
  const removedIndexes = current.stack
    .map((entry, index) => (entry.tabId === tabId ? index : -1))
    .filter((index) => index !== -1)

  if (removedIndexes.length === 0) return current

  const nextStack = current.stack.filter((entry) => entry.tabId !== tabId)
  const removedBeforeIndex = removedIndexes.filter((index) => index < current.index).length
  const removedAtIndex = removedIndexes.includes(current.index)
  let nextIndex = current.index - removedBeforeIndex

  if (removedAtIndex) {
    nextIndex = Math.min(nextIndex, nextStack.length - 1)
  }

  return {
    stack: nextStack,
    index: nextStack.length === 0 ? -1 : Math.max(0, nextIndex)
  }
}

export function historyForUserActivation(history: GlobalTabHistoryInput, activeEntry: GlobalTabHistoryEntry | null | undefined): HistoryChangeResult {
  const current = canonicalizeGlobalHistory(history).history
  if (!activeEntry || typeof activeEntry.tabId !== 'number' || typeof activeEntry.windowId !== 'number') {
    return { history: current, changed: false }
  }

  if (current.stack[current.index]?.tabId === activeEntry.tabId) {
    const nextStack = current.stack.slice()
    nextStack[current.index] = { windowId: activeEntry.windowId, tabId: activeEntry.tabId }
    const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: current.index }).history
    return { history: nextHistory, changed: historyChanged(current, nextHistory) }
  }

  const nextStack = current.index < current.stack.length - 1 ? current.stack.slice(0, current.index + 1) : current.stack.slice()
  nextStack.push({ windowId: activeEntry.windowId, tabId: activeEntry.tabId })
  const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: nextStack.length - 1 }).history

  return { history: nextHistory, changed: historyChanged(current, nextHistory) }
}

export function repairHistoryCursorForActiveTab(history: GlobalTabHistoryInput, activeTab: ActiveTabLike): RepairedHistoryResult {
  const current = canonicalizeGlobalHistory(history).history
  if (!activeTab?.id) {
    return { history: current, activeWasInserted: false, changed: historyChanged(history, current) }
  }

  if (current.stack[current.index]?.tabId === activeTab.id) {
    const nextStack = current.stack.slice()
    nextStack[current.index] = { windowId: activeTab.windowId, tabId: activeTab.id }
    const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: current.index }).history
    return { history: nextHistory, activeWasInserted: false, changed: historyChanged(current, nextHistory) }
  }

  const latestActiveIndex = current.stack.map((entry) => entry.tabId).lastIndexOf(activeTab.id)
  if (latestActiveIndex !== -1) {
    const nextStack = current.stack.slice()
    nextStack[latestActiveIndex] = { windowId: activeTab.windowId, tabId: activeTab.id }
    const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: latestActiveIndex }).history
    return { history: nextHistory, activeWasInserted: false, changed: historyChanged(current, nextHistory) }
  }

  const nextStack = current.index < current.stack.length - 1 ? current.stack.slice(0, current.index + 1) : current.stack.slice()
  nextStack.push({ windowId: activeTab.windowId, tabId: activeTab.id })
  const nextHistory = canonicalizeGlobalHistory({ stack: nextStack, index: nextStack.length - 1 }).history

  return { history: nextHistory, activeWasInserted: true, changed: true }
}

export function findHistoryTargetIndex(history: GlobalTabHistory, direction: number, existingTabs: Map<number, unknown>, activeTab: ActiveTabLike): number {
  if (!activeTab?.id) return -1

  let nextIndex = history.index + direction
  while (
    nextIndex >= 0 &&
    nextIndex < history.stack.length &&
    (!existingTabs.has(history.stack[nextIndex].tabId) || history.stack[nextIndex].tabId === activeTab.id)
  ) {
    nextIndex += direction
  }
  return nextIndex < 0 || nextIndex >= history.stack.length ? -1 : nextIndex
}

export function findTabForHistoryEntry<Tab>(history: GlobalTabHistoryInput, tabsById: Map<number, Tab>): Tab | null {
  const current = normalizeGlobalHistory(history)
  const entry = current.stack[current.index]
  return entry ? tabsById.get(entry.tabId) || null : null
}

export function pruneMissingHistoryEntries(history: GlobalTabHistoryInput, existingTabs: Map<number, unknown>): PrunedHistoryResult {
  const current = normalizeGlobalHistory(history)
  let nextHistory = current

  for (const entry of current.stack) {
    if (existingTabs.has(entry.tabId)) continue
    nextHistory = removeTabEntriesFromHistory(nextHistory, entry.tabId)
  }

  return {
    ...nextHistory,
    changed: nextHistory.stack.length !== current.stack.length || nextHistory.index !== current.index
  }
}

export function displayUrlForHistory(url = ''): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'chrome-extension:' && parsed.pathname.endsWith('/index.html')) return 'Tab Out'
    if (parsed.protocol === 'chrome:') return parsed.href
    return parsed.hostname + parsed.pathname
  } catch {
    return url
  }
}
