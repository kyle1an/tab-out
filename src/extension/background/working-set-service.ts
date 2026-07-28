import {
  emptyWorkingSetActivity,
  normalizeWorkingSetActivity,
  pageIdentityForWorkingSet,
  recordWorkingSetActivity
} from '../working-set.js'
import { normalizeChromeTabToDashboardItem } from '../dashboard-tab-normalization.js'
import { readChromeStorageValue, writeChromeStorageValue } from './chrome-storage.js'
import type { ChromeApi } from './chrome-api.js'
import type { DashboardTab, WorkingSetActivityKind, WorkingSetActivityStore } from '../types'

export const WORKING_SET_ACTIVITY_KEY = 'workingSetActivity'
const ACTIVATION_SIGNAL_DEDUPE_MS = 1000

type ActivationSignalSource = 'tab-activated' | 'window-focused'
type ActivityMutation = {
  activity: WorkingSetActivityStore
  commit?: () => void
}
type CapturedTab = Promise<chrome.tabs.Tab | null>

export type WorkingSetService = {
  getWorkingSetActivity: () => Promise<WorkingSetActivityStore>
  recordFocusedWindowActiveTab: (windowId: number, capturedActiveTab?: CapturedTab) => Promise<void>
  replaceTabId: (addedTabId: number, removedTabId: number) => Promise<void>
  recordTabActivation: (windowId: number, tabId: number, capturedTab?: CapturedTab) => Promise<void>
  recordTabNavigation: (tabId: number, changeInfo: { url?: string; title?: string }, tab: chrome.tabs.Tab) => Promise<void>
}

export function createWorkingSetService(chromeApi: ChromeApi = chrome): WorkingSetService {
  let activityCache: WorkingSetActivityStore | null = null
  let activityQueue: Promise<void> = Promise.resolve()
  let lastActivityAt = 0
  const lastPageIdentityByTabId = new Map<number, string>()
  let lastActivationSignal: {
    source: ActivationSignalSource
    tabId: number
    windowId: number
    observedAt: number
  } | null = null

  function storageArea(): chrome.storage.StorageArea | null {
    return chromeApi.storage?.local || null
  }

  async function readActivity(): Promise<WorkingSetActivityStore> {
    if (activityCache) return activityCache
    const storage = storageArea()
    if (!storage) {
      activityCache = emptyWorkingSetActivity()
      return activityCache
    }

    const storedActivity = await readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY) as Partial<WorkingSetActivityStore> | null | undefined
    activityCache = normalizeWorkingSetActivity(storedActivity)
    return activityCache
  }

  async function writeActivity(nextActivity: WorkingSetActivityStore): Promise<void> {
    const storage = storageArea()
    if (storage) await writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, nextActivity)
    activityCache = nextActivity
  }

  function enqueueActivityMutation(mutator: (activity: WorkingSetActivityStore) => ActivityMutation | Promise<ActivityMutation>) {
    const task = activityQueue.catch(() => {}).then(async () => {
      const before = await readActivity()
      const mutation = await mutator(before)
      // No-op signals (paired activation/focus events, failed tab lookups, and
      // tab-id rebases) still need their commit callback, but must not rewrite
      // the entire 30-day activity store. Real event mutations already return
      // a normalized immutable store from recordWorkingSetActivity.
      if (mutation.activity !== before) await writeActivity(mutation.activity)
      mutation.commit?.()
    })
    activityQueue = task.then(
      () => {},
      () => {}
    )
    return task
  }

  function activityAfterTabEvent(
    activity: WorkingSetActivityStore,
    kind: WorkingSetActivityKind,
    tab: chrome.tabs.Tab | DashboardTab
  ): ActivityMutation {
    const dashboardTab = isDashboardTab(tab)
      ? tab
      : normalizeChromeTabToDashboardItem(tab, { runtimeId: chromeApi.runtime?.id ?? null })
    const at = Math.max(Date.now(), lastActivityAt + 1)
    return {
      activity: recordWorkingSetActivity(activity, {
        kind,
        at,
        tab: dashboardTab
      }),
      commit: () => {
        lastActivityAt = at
      }
    }
  }

  function pageIdentityForTab(tab: chrome.tabs.Tab | DashboardTab): string {
    const dashboardTab = isDashboardTab(tab)
      ? tab
      : normalizeChromeTabToDashboardItem(tab, { runtimeId: chromeApi.runtime?.id ?? null })
    return pageIdentityForWorkingSet(dashboardTab.url || dashboardTab.rawUrl || '')
  }

  function activityAfterActivationSignal(
    activity: WorkingSetActivityStore,
    tab: chrome.tabs.Tab,
    source: ActivationSignalSource,
    observedAt: number
  ): ActivityMutation {
    if (typeof tab.id !== 'number') return { activity }
    const previousSignal = lastActivationSignal
    const nextSignal = {
      source,
      tabId: tab.id,
      windowId: tab.windowId,
      observedAt
    }
    const pageIdentity = pageIdentityForTab(tab)
    const commitSignal = () => {
      lastActivationSignal = nextSignal
      lastPageIdentityByTabId.set(tab.id as number, pageIdentity)
    }
    if (
      previousSignal &&
      previousSignal.source !== source &&
      previousSignal.tabId === tab.id &&
      previousSignal.windowId === tab.windowId &&
      Math.abs(observedAt - previousSignal.observedAt) <= ACTIVATION_SIGNAL_DEDUPE_MS
    ) {
      return {
        activity,
        commit: commitSignal
      }
    }
    const mutation = activityAfterTabEvent(activity, 'activation', tab)
    return {
      activity: mutation.activity,
      commit: () => {
        mutation.commit?.()
        commitSignal()
      }
    }
  }

  async function getWorkingSetActivity(): Promise<WorkingSetActivityStore> {
    try {
      await activityQueue
    } catch {}
    return readActivity()
  }

  async function recordTabActivation(windowId: number, tabId: number, capturedTab?: CapturedTab): Promise<void> {
    if (typeof windowId !== 'number' || typeof tabId !== 'number') return
    const observedAt = Date.now()
    await enqueueActivityMutation(async (activity) => {
      try {
        let tab = capturedTab ? await capturedTab : null
        tab ??= (await chromeApi.tabs.query({ windowId })).find((candidate) => candidate.id === tabId) ?? null
        if (tab?.id !== tabId || tab.windowId !== windowId) return { activity }
        return tab ? activityAfterActivationSignal(activity, tab, 'tab-activated', observedAt) : { activity }
      } catch {
        return { activity }
      }
    })
  }

  async function recordFocusedWindowActiveTab(windowId: number, capturedActiveTab?: CapturedTab): Promise<void> {
    if (windowId == null || windowId === chromeApi.windows.WINDOW_ID_NONE) return
    const observedAt = Date.now()
    await enqueueActivityMutation(async (activity) => {
      try {
        let activeTab = capturedActiveTab ? await capturedActiveTab : null
        activeTab ??= (await chromeApi.tabs.query({ windowId, active: true }))[0] ?? null
        if (activeTab?.windowId !== windowId || !activeTab.active) return { activity }
        return activeTab ? activityAfterActivationSignal(activity, activeTab, 'window-focused', observedAt) : { activity }
      } catch {
        return { activity }
      }
    })
  }

  async function replaceTabId(addedTabId: number, removedTabId: number): Promise<void> {
    if (
      typeof addedTabId !== 'number' ||
      typeof removedTabId !== 'number' ||
      addedTabId === removedTabId
    ) {
      return
    }
    await enqueueActivityMutation((activity) => {
      const nextSignal = lastActivationSignal?.tabId === removedTabId
        ? { ...lastActivationSignal, tabId: addedTabId }
        : lastActivationSignal
      const replacedPageIdentity = lastPageIdentityByTabId.get(removedTabId)
      return {
        activity,
        commit: () => {
          lastActivationSignal = nextSignal
          lastPageIdentityByTabId.delete(removedTabId)
          if (replacedPageIdentity !== undefined) {
            lastPageIdentityByTabId.set(addedTabId, replacedPageIdentity)
          }
        }
      }
    })
  }

  async function recordTabNavigation(tabId: number, changeInfo: { url?: string; title?: string }, tab: chrome.tabs.Tab): Promise<void> {
    if (!tab?.active) return
    if (!changeInfo?.url) return
    if (typeof tabId !== 'number' || tab.id !== tabId) return
    const nextPageIdentity = pageIdentityForTab(tab)
    await enqueueActivityMutation((activity) => {
      const commitPageIdentity = () => {
        lastPageIdentityByTabId.set(tabId, nextPageIdentity)
      }
      // Chrome can surface a URL update while reloading the same page. Only a
      // normalized page-identity change is meaningful Working Set navigation.
      if (lastPageIdentityByTabId.get(tabId) === nextPageIdentity) {
        return { activity, commit: commitPageIdentity }
      }
      const mutation = activityAfterTabEvent(activity, 'navigation', tab)
      return {
        activity: mutation.activity,
        commit: () => {
          mutation.commit?.()
          commitPageIdentity()
        }
      }
    })
  }

  return {
    getWorkingSetActivity,
    recordFocusedWindowActiveTab,
    replaceTabId,
    recordTabActivation,
    recordTabNavigation
  }
}

function isDashboardTab(tab: chrome.tabs.Tab | DashboardTab): tab is DashboardTab {
  return 'rawUrl' in tab && 'suspended' in tab
}
