import {
  MAX_TAB_HISTORY,
  canonicalizeGlobalHistory,
  displayUrlForHistory,
  effectiveUrlForHistoryIdentity,
  findHistoryTargetIndex,
  findTabForHistoryEntry,
  historyChanged,
  historyForBackgroundTabCreation,
  historyForTabNavigation,
  historyForUserActivation,
  normalizeGlobalHistory,
  pruneMissingHistoryEntries,
  removeTabEntriesFromHistory,
  replaceTabIdInHistory,
  repairHistoryCursorForActiveTab,
  type GlobalTabHistory,
  type GlobalTabHistoryInput
} from './tab-history-state.js'
import { normalizeWorkingSetActivity, pageIdentityForWorkingSet } from '../working-set.js'
import { WORKING_SET_ACTIVITY_KEY } from './working-set-service.js'
import type { ChromeApi } from './chrome-api.js'
import { readChromeStorageValue, writeChromeStorageValue } from './chrome-storage.js'
import { focusExistingTabTargetResult, type ExistingTabFocusResult } from '../tab-focus.js'
import { isSuspended, unwrapSuspenderTitle, unwrapSuspenderUrl } from '../suspension.js'
import type { ChromeOpenTabsSnapshot } from '../tabs.js'
import type { TabHistorySnapshot, WorkingSetActivityStore } from '../types'

const TAB_HISTORY_KEY = 'globalTabHistory'
const TAB_HISTORY_STORAGE_VERSION = 2

type StoredGlobalTabHistoryV2 = GlobalTabHistory & {
  version: typeof TAB_HISTORY_STORAGE_VERSION
}

export const TAB_HISTORY_GET_MESSAGE = 'tab-out:get-tab-history'
export const TAB_HISTORY_SWITCH_MESSAGE = 'tab-out:switch-tab-history'

type FocusedWindowLookup = {
  id: number | null
  known: boolean
}
type ActiveTabLookup = {
  tab: chrome.tabs.Tab | null
  chromeFocused: boolean
  known: boolean
}
type LastFocusedActiveTabLookup = {
  tab: chrome.tabs.Tab | null
  known: boolean
}
type MutationResult<T> = {
  history?: GlobalTabHistoryInput
  value?: T
  commit?: () => void
}
type FocusAction = {
  tab: chrome.tabs.Tab
  openerTabId?: number
}
type CapturedTab = Promise<chrome.tabs.Tab | null>
/**
 * The browser state and history view are produced inside one serialized history
 * operation. Required tab/window reads reject together so callers never receive
 * a valid-looking partial generation.
 */
type TabHistorySnapshotCapture = {
  tabHistory: TabHistorySnapshot
  openTabsSnapshot: ChromeOpenTabsSnapshot
}
export type TabHistoryService = {
  getTabHistorySnapshot: (activity?: WorkingSetActivityStore | null) => Promise<TabHistorySnapshot>
  getTabHistorySnapshotCapture: (activity?: WorkingSetActivityStore | null) => Promise<TabHistorySnapshotCapture>
  recordFocusedWindowActiveTab: (windowId: number, capturedActiveTab?: CapturedTab) => Promise<void>
  recordTabCreation: (tab: chrome.tabs.Tab) => Promise<void>
  recordTabNavigation: (tabId: number, changeInfo: { url?: string }, tab: chrome.tabs.Tab) => Promise<void>
  recordTabActivation: (windowId: number, tabId: number, capturedTab?: CapturedTab) => Promise<void>
  removeTabFromHistory: (tabId: number) => Promise<void>
  replaceTabId: (addedTabId: number, removedTabId: number) => Promise<void>
  resetForBrowserStartup: () => Promise<void>
  restorePreviousTabAfterClose: (tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => Promise<void>
  switchTabHistory: (direction: number) => Promise<void>
}

function mapTabsById(tabs: chrome.tabs.Tab[]): Map<number, chrome.tabs.Tab> {
  return new Map(tabs.filter((tab) => typeof tab.id === 'number').map((tab) => [tab.id as number, tab]))
}

function mapWindowTypesById(windows: chrome.windows.Window[]): Map<number, string | undefined> {
  return new Map(windows.filter((win) => typeof win.id === 'number').map((win) => [win.id as number, win.type]))
}

function focusedWindowLookupFromWindows(windows: chrome.windows.Window[]): FocusedWindowLookup {
  const focusedWindow = windows.find((win) => win.focused && typeof win.id === 'number')
  return { id: focusedWindow?.id ?? null, known: true }
}

function isStandaloneAppWindow(windowType?: string) {
  return windowType === 'app' || windowType === 'popup'
}

function emptyGlobalTabHistory(): GlobalTabHistory {
  return { stack: [], index: -1, pending: [] }
}

function isStoredHistoryEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.windowId === 'number' &&
    Number.isInteger(entry.windowId) &&
    typeof entry.tabId === 'number' &&
    Number.isInteger(entry.tabId) &&
    typeof entry.url === 'string'
  )
}

function isStoredGlobalTabHistoryV2(value: unknown): value is StoredGlobalTabHistoryV2 {
  if (!value || typeof value !== 'object') return false
  const history = value as Record<string, unknown>
  return (
    history.version === TAB_HISTORY_STORAGE_VERSION &&
    Array.isArray(history.stack) &&
    history.stack.every(isStoredHistoryEntry) &&
    typeof history.index === 'number' &&
    Number.isInteger(history.index) &&
    Array.isArray(history.pending) &&
    history.pending.every((entry) => (
      isStoredHistoryEntry(entry) &&
      typeof (entry as Record<string, unknown>).createdAt === 'number' &&
      Number.isFinite((entry as Record<string, unknown>).createdAt)
    ))
  )
}

function storedGlobalTabHistory(history: GlobalTabHistoryInput): StoredGlobalTabHistoryV2 {
  const cleanHistory = canonicalizeGlobalHistory(history).history
  return {
    version: TAB_HISTORY_STORAGE_VERSION,
    ...cleanHistory
  }
}

function historyEntryForTab(tab: chrome.tabs.Tab): { windowId: number; tabId: number; url: string } | null {
  if (typeof tab.id !== 'number' || typeof tab.windowId !== 'number') return null
  return {
    windowId: tab.windowId,
    tabId: tab.id,
    url: effectiveUrlForHistoryIdentity(tab)
  }
}

function historyEntryMatchesTab(entry: { tabId: number; url: string }, tab: chrome.tabs.Tab | undefined): boolean {
  return !!tab && tab.id === entry.tabId && effectiveUrlForHistoryIdentity(tab) === entry.url
}

export function createTabHistoryService(chromeApi: ChromeApi = chrome): TabHistoryService {
  let tabHistoryCache: GlobalTabHistory | null = null
  let tabHistoryQueue: Promise<void> = Promise.resolve()
  let browserStartupResetPending = false
  const trustedTabIds = new Set<number>()

  function tabHistoryStorageArea(): chrome.storage.StorageArea | null {
    return chromeApi.storage?.local || chromeApi.storage?.session || null
  }

  async function readTabHistory(): Promise<GlobalTabHistory> {
    if (tabHistoryCache) return tabHistoryCache
    const storage = tabHistoryStorageArea()
    if (!storage) {
      tabHistoryCache = emptyGlobalTabHistory()
      return tabHistoryCache
    }

    let storedHistory = await readChromeStorageValue(storage, TAB_HISTORY_KEY)
    let migratedFromSession = false
    if (storedHistory == null && storage === chromeApi.storage?.local && chromeApi.storage?.session) {
      storedHistory = await readChromeStorageValue(chromeApi.storage.session, TAB_HISTORY_KEY)
      migratedFromSession = storedHistory != null
    }

    // The former ID-only schema cannot distinguish an extension reload from a
    // browser restart whose onStartup event was missed while Tab Out was
    // disabled. Reset it once rather than allowing Chrome's reused IDs to point
    // at unrelated pages.
    if (storedHistory != null && !isStoredGlobalTabHistoryV2(storedHistory)) {
      const emptyHistory = emptyGlobalTabHistory()
      await writeChromeStorageValue(storage, TAB_HISTORY_KEY, storedGlobalTabHistory(emptyHistory))
      tabHistoryCache = emptyHistory
      return tabHistoryCache
    }

    const canonical = canonicalizeGlobalHistory(storedHistory as GlobalTabHistoryInput)
    if (canonical.changed || migratedFromSession) {
      await writeChromeStorageValue(storage, TAB_HISTORY_KEY, storedGlobalTabHistory(canonical.history))
    }
    tabHistoryCache = canonical.history
    return tabHistoryCache
  }

  async function writeTabHistory(nextHistory: GlobalTabHistoryInput): Promise<void> {
    const cleanHistory = canonicalizeGlobalHistory(nextHistory).history
    const storage = tabHistoryStorageArea()
    if (storage) await writeChromeStorageValue(storage, TAB_HISTORY_KEY, storedGlobalTabHistory(cleanHistory))
    tabHistoryCache = cleanHistory
  }

  async function readActivityTimestamps(): Promise<Map<string, number>> {
    const storage = tabHistoryStorageArea()
    if (!storage) return new Map()
    try {
      const stored = await readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
      const activity = normalizeWorkingSetActivity(stored as Parameters<typeof normalizeWorkingSetActivity>[0])
      const map = new Map<string, number>()
      for (const [key, record] of Object.entries(activity.records)) {
        const ts = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
        if (ts > 0) map.set(key, ts)
      }
      return map
    } catch {
      return new Map()
    }
  }

  function activityTimestampsFromStore(activity: WorkingSetActivityStore | null | undefined): Map<string, number> {
    const normalized = normalizeWorkingSetActivity(activity)
    const map = new Map<string, number>()
    for (const [key, record] of Object.entries(normalized.records)) {
      const ts = Math.max(record.lastActivatedAt || 0, record.lastNavigatedAt || 0)
      if (ts > 0) map.set(key, ts)
    }
    return map
  }

  function enqueueTabHistoryTask<T>(run: () => Promise<T>): Promise<T> {
    const task = tabHistoryQueue.catch(() => {}).then(run)
    tabHistoryQueue = task.then(
      () => {},
      () => {}
    )
    return task
  }

  async function applyPendingBrowserStartupReset(): Promise<void> {
    if (!browserStartupResetPending) return
    await writeTabHistory({ stack: [], index: -1, pending: [] })
    browserStartupResetPending = false
  }

  function enqueueTabHistoryMutation<T>(mutator: (history: GlobalTabHistory) => MutationResult<T> | void | Promise<MutationResult<T> | void>) {
    return enqueueTabHistoryTask(async () => {
      await applyPendingBrowserStartupReset()
      const before = canonicalizeGlobalHistory(await readTabHistory()).history
      const result = (await mutator(before)) || {}
      const requestedHistory = result.history || before
      const cleanHistory = canonicalizeGlobalHistory(requestedHistory).history
      const changed = historyChanged(before, cleanHistory)
      if (changed) await writeTabHistory(cleanHistory)
      result.commit?.()
      return {
        history: cleanHistory,
        changed,
        value: result.value
      }
    })
  }

  async function historyAfterTabActivation(
    history: GlobalTabHistory,
    tab: chrome.tabs.Tab
  ): Promise<GlobalTabHistory> {
    const activeEntry = historyEntryForTab(tab)
    if (!activeEntry) return history
    await primeNativeCloseTarget(activeEntry.windowId, activeEntry.tabId, history)
    return historyForUserActivation(history, activeEntry).history
  }

  async function recordTabActivation(windowId: number, tabId: number, capturedTab?: CapturedTab): Promise<void> {
    if (typeof windowId !== 'number' || typeof tabId !== 'number') return

    await enqueueTabHistoryMutation(async (history) => {
      let activatedTab: chrome.tabs.Tab | null = null
      try {
        activatedTab = capturedTab ? await capturedTab : null
        if (!activatedTab) activatedTab = await chromeApi.tabs.get(tabId)
      } catch {
        return { history }
      }
      if (activatedTab.id !== tabId || activatedTab.windowId !== windowId) return { history }
      return {
        history: await historyAfterTabActivation(history, activatedTab),
        commit: () => {
          trustedTabIds.add(tabId)
        }
      }
    })
  }

  async function recordTabCreation(tab: chrome.tabs.Tab): Promise<void> {
    const tabId = tab.id
    const windowId = tab.windowId
    if (
      tab.active ||
      typeof tabId !== 'number' ||
      typeof windowId !== 'number' ||
      typeof tab.openerTabId !== 'number'
    ) {
      return
    }

    // A creation event starts a new physical lifetime even if Chrome reused an
    // ID whose removal/startup event the extension did not observe.
    trustedTabIds.delete(tabId)

    await enqueueTabHistoryMutation((history) => ({
      history: historyForBackgroundTabCreation(history, {
        windowId,
        tabId,
        url: effectiveUrlForHistoryIdentity(tab),
        createdAt: Date.now()
      }).history,
      commit: () => {
        trustedTabIds.add(tabId)
      }
    }))
  }

  async function recordTabNavigation(
    tabId: number,
    changeInfo: { url?: string },
    tab: chrome.tabs.Tab
  ): Promise<void> {
    if (
      changeInfo?.url === undefined ||
      typeof tabId !== 'number' ||
      tab?.id !== tabId ||
      typeof tab.windowId !== 'number'
    ) {
      return
    }

    const navigatedEntry = historyEntryForTab(tab)
    if (!navigatedEntry) return
    await enqueueTabHistoryMutation((history) => ({
      // A URL update alone cannot distinguish a legitimate navigation from a
      // reused ID after a missed browser-startup event. Creation, activation,
      // replacement, or an identity-pruned snapshot must establish this tab's
      // current lifetime before its stored identity can move with navigation.
      history: trustedTabIds.has(tabId)
        ? historyForTabNavigation(history, navigatedEntry).history
        : history
    }))
  }

  async function findFocusedWindowId(): Promise<FocusedWindowLookup> {
    try {
      return focusedWindowLookupFromWindows(await chromeApi.windows.getAll())
    } catch {
      return { id: null, known: false }
    }
  }

  async function findLastFocusedActiveTab(): Promise<LastFocusedActiveTabLookup> {
    try {
      const focusedTabs = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true })
      return { tab: focusedTabs[0] || null, known: true }
    } catch {
      return { tab: null, known: false }
    }
  }

  async function findActiveTabForHistory(
    tabs: chrome.tabs.Tab[],
    history: GlobalTabHistoryInput,
    capturedFocusedWindow?: FocusedWindowLookup
  ): Promise<ActiveTabLookup> {
    const focusedWindow = capturedFocusedWindow ?? await findFocusedWindowId()
    if (!focusedWindow.known) {
      return { tab: null, chromeFocused: false, known: false }
    }

    if (focusedWindow.id != null) {
      const focusedActiveTab = tabs.find((tab) => tab.windowId === focusedWindow.id && tab.active)
      return focusedActiveTab
        ? { tab: focusedActiveTab, chromeFocused: true, known: true }
        : { tab: null, chromeFocused: true, known: false }
    }

    const tabsById = mapTabsById(tabs)
    const historyTab = findTabForHistoryEntry(history, tabsById)
    if (historyTab) return { tab: historyTab, chromeFocused: false, known: true }

    const lastFocusedTab = await findLastFocusedActiveTab()
    if (!lastFocusedTab.known) return { tab: null, chromeFocused: false, known: false }
    if (!lastFocusedTab.tab) return { tab: null, chromeFocused: false, known: true }
    const capturedTab = typeof lastFocusedTab.tab.id === 'number'
      ? tabsById.get(lastFocusedTab.tab.id)
      : null
    if (
      !capturedTab?.active ||
      capturedTab.windowId !== lastFocusedTab.tab.windowId ||
      effectiveUrlForHistoryIdentity(capturedTab) !== effectiveUrlForHistoryIdentity(lastFocusedTab.tab)
    ) {
      return { tab: null, chromeFocused: false, known: false }
    }
    return { tab: capturedTab, chromeFocused: false, known: true }
  }

  async function focusExistingTabResult(tab: chrome.tabs.Tab | null): Promise<ExistingTabFocusResult> {
    if (typeof tab?.id !== 'number') return { status: 'not-found' }
    return focusExistingTabTargetResult({
      tabId: tab.id,
      windowId: tab.windowId,
      url: unwrapSuspenderUrl(tab.url || ''),
      rawUrl: tab.url || ''
    })
  }

  async function focusExistingTab(tab: chrome.tabs.Tab | null): Promise<boolean> {
    const result = await focusExistingTabResult(tab)
    if (result.status === 'not-found') {
      if (typeof tab?.id === 'number') await removeTabFromHistory(tab.id)
    }
    return result.status === 'focused'
  }

  async function findPreviousSurvivingTabInWindow(
    history: GlobalTabHistoryInput,
    windowId: number,
    tabId: number
  ): Promise<{ currentTab: chrome.tabs.Tab; targetTab: chrome.tabs.Tab } | null> {
    const current = normalizeGlobalHistory(history)
    const previousEntries = []
    for (let i = current.index; i >= 0; i--) {
      const entry = current.stack[i]
      if (entry && entry.windowId === windowId && entry.tabId !== tabId) previousEntries.push(entry)
    }
    if (previousEntries.length === 0) return null

    let tabsInWindow: chrome.tabs.Tab[] = []
    try {
      tabsInWindow = await chromeApi.tabs.query({ windowId })
    } catch {
      return null
    }

    const tabsById = mapTabsById(tabsInWindow)
    const currentTab = tabsById.get(tabId)
    if (!currentTab) return null

    for (const entry of previousEntries) {
      const targetTab = tabsById.get(entry.tabId)
      if (targetTab && historyEntryMatchesTab(entry, targetTab)) return { currentTab, targetTab }
    }

    return null
  }

  async function primeNativeCloseTarget(windowId: number, tabId: number, history: GlobalTabHistoryInput): Promise<void> {
    const match = await findPreviousSurvivingTabInWindow(history, windowId, tabId)
    if (!match) return

    const { currentTab, targetTab } = match
    if (currentTab.openerTabId === targetTab.id) return

    try {
      await chromeApi.tabs.update(tabId, { openerTabId: targetTab.id })
    } catch {
      // Some browser-managed tabs reject opener changes; the onRemoved
      // restore path below remains the fallback.
    }
  }

  async function recordFocusedWindowActiveTab(windowId: number, capturedActiveTab?: CapturedTab): Promise<void> {
    if (windowId == null || windowId === chromeApi.windows.WINDOW_ID_NONE) return
    await enqueueTabHistoryMutation(async (history) => {
      try {
        let activeTab = capturedActiveTab ? await capturedActiveTab : null
        if (!activeTab) activeTab = (await chromeApi.tabs.query({ windowId, active: true }))[0] ?? null
        if (typeof activeTab?.id !== 'number' || activeTab.windowId !== windowId || !activeTab.active) return { history }
        return {
          history: await historyAfterTabActivation(history, activeTab),
          commit: () => {
            trustedTabIds.add(activeTab.id as number)
          }
        }
      } catch {
        // Window may have closed or be unavailable; ignore.
        return { history }
      }
    })
  }

  async function removeTabFromHistory(tabId: number): Promise<void> {
    trustedTabIds.delete(tabId)
    await enqueueTabHistoryMutation((history) => ({
      history: removeTabEntriesFromHistory(history, tabId)
    }))
  }

  async function replaceTabId(addedTabId: number, removedTabId: number): Promise<void> {
    trustedTabIds.delete(removedTabId)
    trustedTabIds.delete(addedTabId)
    await enqueueTabHistoryMutation(async (history) => {
      let replacementWindowId: number | undefined
      let replacementUrl: string | undefined
      try {
        const replacementTab = await chromeApi.tabs.get(addedTabId)
        if (typeof replacementTab?.windowId === 'number') replacementWindowId = replacementTab.windowId
        replacementUrl = effectiveUrlForHistoryIdentity(replacementTab)
      } catch {}
      return {
        history: replaceTabIdInHistory(history, addedTabId, removedTabId, replacementWindowId, replacementUrl),
        commit: () => {
          if (typeof replacementUrl === 'string') trustedTabIds.add(addedTabId)
        }
      }
    })
  }

  async function resetForBrowserStartup(): Promise<void> {
    // Browser startup invalidates every stored tab/window id. Clearing does not
    // depend on reading those stale values first, so a transient read failure
    // must not leave them available for Chrome to reuse in the new session.
    browserStartupResetPending = true
    trustedTabIds.clear()
    await enqueueTabHistoryTask(applyPendingBrowserStartupReset)
  }

  async function restorePreviousTabAfterClose(tabId: number, removeInfo: chrome.tabs.OnRemovedInfo): Promise<void> {
    trustedTabIds.delete(tabId)
    if (!removeInfo) return

    const { value: restoreTarget } = await enqueueTabHistoryMutation<chrome.tabs.Tab | null>(async (history) => {
      const nextHistory = removeTabEntriesFromHistory(history, tabId)
      if (removeInfo.isWindowClosing) return { history: nextHistory }

      const currentEntry = history.stack[history.index]
      if (!currentEntry || currentEntry.tabId !== tabId || currentEntry.windowId !== removeInfo.windowId) {
        return { history: nextHistory }
      }

      let tabsInWindow: chrome.tabs.Tab[] = []
      try {
        tabsInWindow = await chromeApi.tabs.query({ windowId: removeInfo.windowId })
      } catch {
        return { history: nextHistory }
      }

      const tabsById = mapTabsById(tabsInWindow)
      let targetOldIndex = -1
      for (let i = history.index - 1; i >= 0; i--) {
        const entry = history.stack[i]
        if (!entry) continue
        if (entry.windowId !== removeInfo.windowId) continue
        if (!historyEntryMatchesTab(entry, tabsById.get(entry.tabId))) continue
        targetOldIndex = i
        break
      }

      if (targetOldIndex === -1) return { history: nextHistory }

      const targetEntry = history.stack[targetOldIndex]
      if (!targetEntry) return { history: nextHistory }
      const targetId = targetEntry.tabId
      let targetNewIndex = -1
      for (let i = Math.min(targetOldIndex, nextHistory.stack.length - 1); i >= 0; i--) {
        const entry = nextHistory.stack[i]
        if (entry?.tabId === targetId && entry.windowId === removeInfo.windowId) {
          targetNewIndex = i
          break
        }
      }

      if (targetNewIndex === -1) return { history: nextHistory }

      const targetTab = tabsById.get(targetId)
      if (!targetTab) return { history: nextHistory }

      const finalHistory = {
        stack: nextHistory.stack,
        index: targetNewIndex,
        pending: nextHistory.pending
      }
      const activeTab = tabsInWindow.find((tab) => tab.active)
      return {
        history: finalHistory,
        value: activeTab?.id === targetId ? null : targetTab
      }
    })

    if (!restoreTarget) return
    await focusExistingTab(restoreTarget)
  }

  async function switchTabHistory(direction: number): Promise<void> {
    // Keep Chrome activation inside the serialized task. Its onActivated event
    // queues behind this operation, so a confirmed switch commits the cursor
    // first and the event becomes idempotent instead of truncating forward
    // history. A rejected activation leaves the pre-switch cursor/pending queue.
    await enqueueTabHistoryTask(async () => {
      await applyPendingBrowserStartupReset()
      const storedHistory = canonicalizeGlobalHistory(await readTabHistory()).history
      const tabs = await chromeApi.tabs.query({})
      const existingTabs = mapTabsById(tabs)
      const history = canonicalizeGlobalHistory(
        pruneMissingHistoryEntries(storedHistory, existingTabs)
      ).history
      const activeTabLookup = await findActiveTabForHistory(tabs, history)
      if (!activeTabLookup.known) throw new Error('Chrome focus state is unavailable')
      const { tab: activeTab, chromeFocused } = activeTabLookup
      let baseHistory = history
      let nextHistory = history
      let focusAction: FocusAction | null = null

      if (typeof activeTab?.id === 'number') {
        if (!chromeFocused) {
          focusAction = { tab: activeTab }
        } else if (history.stack.length === 0) {
          const activeEntry = historyEntryForTab(activeTab)
          if (activeEntry) {
            nextHistory = {
              stack: [activeEntry],
              index: 0,
              pending: history.pending
            }
          }
        } else {
          const repaired = repairHistoryCursorForActiveTab(history, activeTab)
          const navigationHistory = canonicalizeGlobalHistory(
            pruneMissingHistoryEntries(repaired.history, existingTabs)
          ).history
          baseHistory = navigationHistory
          nextHistory = navigationHistory
          const nextIndex = findHistoryTargetIndex(navigationHistory, direction, existingTabs, activeTab)

          if (nextIndex === -1 && direction > 0) {
            const pendingTarget = navigationHistory.pending.find((entry) => (
              entry.tabId !== activeTab.id &&
              existingTabs.has(entry.tabId)
            ))
            const targetTab = pendingTarget ? existingTabs.get(pendingTarget.tabId) : null
            if (typeof targetTab?.id === 'number') {
              nextHistory = historyForUserActivation(navigationHistory, {
                windowId: targetTab.windowId,
                tabId: targetTab.id,
                url: effectiveUrlForHistoryIdentity(targetTab)
              }).history
              focusAction = {
                tab: targetTab,
                openerTabId: activeTab.id
              }
            }
          } else if (nextIndex !== -1) {
            const targetEntry = navigationHistory.stack[nextIndex]
            const targetTab = targetEntry ? existingTabs.get(targetEntry.tabId) : null
            if (typeof targetTab?.id === 'number') {
              const targetTabId = targetTab.id
              nextHistory = {
                stack: navigationHistory.stack.map((entry, entryIndex) => (entryIndex === nextIndex
                  ? {
                      windowId: targetTab.windowId,
                      tabId: targetTabId,
                      url: effectiveUrlForHistoryIdentity(targetTab)
                    }
                  : entry)),
                index: nextIndex,
                pending: navigationHistory.pending
              }
              focusAction = {
                tab: targetTab,
                openerTabId: activeTab.id
              }
            }
          }
        }
      }

      if (!focusAction) {
        const cleanHistory = canonicalizeGlobalHistory(nextHistory).history
        if (historyChanged(storedHistory, cleanHistory)) await writeTabHistory(cleanHistory)
        return
      }

      const focusResult = await focusExistingTabResult(focusAction.tab)
      const activationConfirmed = focusResult.status === 'focused' || focusResult.status === 'activated'
      if (activationConfirmed && focusAction.openerTabId && typeof focusAction.tab.id === 'number') {
        try {
          await chromeApi.tabs.update(focusAction.tab.id, { openerTabId: focusAction.openerTabId })
        } catch {}
      }
      let committedHistory = activationConfirmed ? nextHistory : baseHistory
      if (focusResult.status === 'not-found' && typeof focusAction.tab.id === 'number') {
        committedHistory = removeTabEntriesFromHistory(committedHistory, focusAction.tab.id)
      }
      const cleanHistory = canonicalizeGlobalHistory(committedHistory).history
      if (historyChanged(storedHistory, cleanHistory)) await writeTabHistory(cleanHistory)
      if (!activationConfirmed) throw new Error('Could not activate tab history target')
    })
  }

  async function getTabHistorySnapshotCapture(activity?: WorkingSetActivityStore | null): Promise<TabHistorySnapshotCapture> {
    const { value: capture } = await enqueueTabHistoryMutation(async (storedHistory) => {
      const [tabs, windows] = await Promise.all([
        chromeApi.tabs.query({}),
        chromeApi.windows.getAll()
      ])
      const windowTypeById = mapWindowTypesById(windows)
      const existingTabs = mapTabsById(tabs)
      const identityPrunedHistory = canonicalizeGlobalHistory(
        pruneMissingHistoryEntries(storedHistory, existingTabs)
      ).history
      const activeTabLookup = await findActiveTabForHistory(
        tabs,
        identityPrunedHistory,
        focusedWindowLookupFromWindows(windows)
      )
      if (!activeTabLookup.known) throw new Error('Chrome focus state is unavailable')
      const { tab: activeTab } = activeTabLookup
      const repairedHistory = repairHistoryCursorForActiveTab(identityPrunedHistory, activeTab)
      const prunedHistory = pruneMissingHistoryEntries(repairedHistory.history, existingTabs)
      const cleanHistory = canonicalizeGlobalHistory(prunedHistory).history
      const previousIndex = findHistoryTargetIndex(cleanHistory, -1, existingTabs, activeTab)
      const stackNextIndex = findHistoryTargetIndex(cleanHistory, 1, existingTabs, activeTab)
      const nextIndex = stackNextIndex === -1 && cleanHistory.pending.length > 0
        ? cleanHistory.stack.length
        : stackNextIndex
      const activityTimestamps = activity ? activityTimestampsFromStore(activity) : await readActivityTimestamps()
      const indexedEntries = [
        ...cleanHistory.stack.map((entry, index) => ({
          entry,
          index,
          pending: false,
          createdAt: null
        })),
        ...cleanHistory.pending.map((entry, pendingIndex) => ({
          entry,
          index: cleanHistory.stack.length + pendingIndex,
          pending: true,
          createdAt: entry.createdAt
        }))
      ]

      return {
        history: cleanHistory,
        commit: () => {
          for (const tab of tabs) {
            if (typeof tab.id === 'number') trustedTabIds.add(tab.id)
          }
        },
        value: {
          openTabsSnapshot: { tabs, windows },
          tabHistory: {
            stackSize: cleanHistory.stack.length,
            pendingSize: cleanHistory.pending.length,
            maxSize: MAX_TAB_HISTORY,
            cursorIndex: cleanHistory.index,
            currentIndex: cleanHistory.index,
            previousIndex,
            nextIndex,
            activeTabId: activeTab?.id ?? null,
            activeWindowId: activeTab?.windowId ?? null,
            activeWasInserted: repairedHistory.activeWasInserted,
            entries: indexedEntries.map(({ entry, index, pending, createdAt }) => {
              const tab = existingTabs.get(entry.tabId)
              const rawUrl = tab?.url || ''
              const url = unwrapSuspenderUrl(rawUrl)
              const suspended = isSuspended(rawUrl, url)
              const displayUrl = displayUrlForHistory(url)
              const cleanTitle = (tab?.title || '').replace(/\u200e/g, '').trim()
              const title = unwrapSuspenderTitle(rawUrl) || (cleanTitle ? cleanTitle : displayUrl)
              const activityKey = pageIdentityForWorkingSet(url)
              return {
                index,
                tabId: entry.tabId,
                windowId: entry.windowId,
                exists: !!tab,
                active: tab?.id === activeTab?.id,
                activeInOtherWindow: !!(tab?.active && activeTab && tab.windowId !== activeTab.windowId),
                isApp: isStandaloneAppWindow(tab ? windowTypeById.get(tab.windowId) : undefined),
                pinned: !!tab?.pinned,
                discarded: !!tab?.discarded,
                suspended,
                loading: !!tab && !suspended && tab.status === 'loading',
                audible: !!tab?.audible,
                muted: !!tab?.mutedInfo?.muted,
                pending,
                createdAt,
                cursor: index === cleanHistory.index,
                current: index === cleanHistory.index,
                previousTarget: index === previousIndex,
                nextTarget: index === nextIndex,
                title: title || `Tab ${entry.tabId}`,
                url,
                rawUrl,
                displayUrl,
                favIconUrl: tab?.favIconUrl || '',
                lastActivatedAt: activityKey ? activityTimestamps.get(activityKey) ?? null : null
              }
            })
          }
        }
      }
    })

    return capture as TabHistorySnapshotCapture
  }

  async function getTabHistorySnapshot(activity?: WorkingSetActivityStore | null): Promise<TabHistorySnapshot> {
    return (await getTabHistorySnapshotCapture(activity)).tabHistory
  }

  return {
    getTabHistorySnapshot,
    getTabHistorySnapshotCapture,
    recordFocusedWindowActiveTab,
    recordTabCreation,
    recordTabNavigation,
    recordTabActivation,
    removeTabFromHistory,
    replaceTabId,
    resetForBrowserStartup,
    restorePreviousTabAfterClose,
    switchTabHistory
  }
}
