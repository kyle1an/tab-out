import {
  buildWorkingSetSnapshot,
  emptyWorkingSetActivity,
  normalizeWorkingSetActivity,
  recordWorkingSetActivity
} from '../working-set.js'
import { readChromeStorageValue, runChromeEffect, runChromeEffectBestEffort, writeChromeStorageValue } from './chrome-storage-effect.js'
import { createChromeApi, type ChromeApi } from './chrome-api.js'
import type { DashboardTab, WorkingSetActivityKind, WorkingSetActivityStore, WorkingSetSnapshot } from '../types'

const WORKING_SET_ACTIVITY_KEY = 'workingSetActivity'

export type WorkingSetService = {
  getWorkingSetSnapshot: () => Promise<WorkingSetSnapshot>
  recordTabActivation: (windowId: number, tabId: number) => Promise<void>
  recordTabNavigation: (tabId: number, changeInfo: { url?: string; title?: string }, tab: chrome.tabs.Tab) => Promise<void>
}

export function createWorkingSetService(chromeApi: ChromeApi = createChromeApi(chrome)): WorkingSetService {
  let activityCache: WorkingSetActivityStore | null = null
  let activityQueue: Promise<void> = Promise.resolve()
  let lastActivityAt = 0

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

    try {
      const storedActivity = await runChromeEffect(readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)) as Partial<WorkingSetActivityStore> | null | undefined
      activityCache = normalizeWorkingSetActivity(storedActivity)
    } catch {
      activityCache = emptyWorkingSetActivity()
    }
    return activityCache
  }

  async function writeActivity(nextActivity: WorkingSetActivityStore): Promise<void> {
    activityCache = normalizeWorkingSetActivity(nextActivity)
    const storage = storageArea()
    if (!storage) return
    try {
      await runChromeEffectBestEffort(writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, activityCache))
    } catch {
      // Best-effort only; the in-memory cache can still rank this session.
    }
  }

  function enqueueActivityMutation(mutator: (activity: WorkingSetActivityStore) => WorkingSetActivityStore | Promise<WorkingSetActivityStore>) {
    const task = activityQueue.catch(() => {}).then(async () => {
      const before = await readActivity()
      const next = normalizeWorkingSetActivity(await mutator(before))
      await writeActivity(next)
    })
    activityQueue = task.then(
      () => {},
      () => {}
    )
    return task
  }

  async function queryOpenTabs(): Promise<DashboardTab[]> {
    try {
      const [tabs, windows] = await Promise.all([chromeApi.tabs.query({}), chromeApi.windows.getAll()])
      const windowTypeById = new Map(windows.filter((win) => typeof win.id === 'number').map((win) => [win.id as number, win.type]))
      return tabs.map((tab) => toDashboardTab(tab, windowTypeById.get(tab.windowId)))
    } catch {
      return []
    }
  }

  async function recordTabActivity(kind: WorkingSetActivityKind, tab: chrome.tabs.Tab | DashboardTab | null | undefined): Promise<void> {
    if (!tab || typeof tab.id !== 'number') return
    const dashboardTab = isDashboardTab(tab) ? tab : toDashboardTab(tab)
    const at = Math.max(Date.now(), lastActivityAt + 1)
    lastActivityAt = at
    await enqueueActivityMutation((activity) => recordWorkingSetActivity(activity, {
      kind,
      at,
      tab: dashboardTab
    }))
  }

  async function recordTabActivation(windowId: number, tabId: number): Promise<void> {
    if (typeof windowId !== 'number' || typeof tabId !== 'number') return
    try {
      const tabs = await chromeApi.tabs.query({ windowId })
      const tab = tabs.find((candidate) => candidate.id === tabId)
      await recordTabActivity('activation', tab)
    } catch {}
  }

  async function recordTabNavigation(_tabId: number, changeInfo: { url?: string; title?: string }, tab: chrome.tabs.Tab): Promise<void> {
    if (!tab?.active) return
    if (!changeInfo?.url && !changeInfo?.title) return
    await recordTabActivity('navigation', tab)
  }

  async function getWorkingSetSnapshot(): Promise<WorkingSetSnapshot> {
    const [activity, tabs] = await Promise.all([readActivity(), queryOpenTabs()])
    const currentWindowId = await currentWindowIdOrNull()
    return buildWorkingSetSnapshot({
      tabs,
      activity,
      currentWindowId
    })
  }

  async function currentWindowIdOrNull(): Promise<number | null> {
    try {
      const windows = await chromeApi.windows.getAll()
      const focusedWindow = windows.find((win) => win.focused && typeof win.id === 'number')
      return focusedWindow?.id ?? null
    } catch {
      return null
    }
  }

  return {
    getWorkingSetSnapshot,
    recordTabActivation,
    recordTabNavigation
  }
}

function isDashboardTab(tab: chrome.tabs.Tab | DashboardTab): tab is DashboardTab {
  return 'rawUrl' in tab && 'suspended' in tab
}

function toDashboardTab(tab: chrome.tabs.Tab, windowType?: string): DashboardTab {
  const rawUrl = tab.url || ''
  const effectiveUrl = unwrapWorkingSetSuspenderUrl(rawUrl)
  const suspended = rawUrl !== effectiveUrl
  const title = tab.title || ''
  return {
    id: tab.id,
    url: effectiveUrl,
    rawUrl,
    suspended,
    title,
    favIconUrl: tab.favIconUrl || '',
    windowId: tab.windowId,
    active: !!tab.active,
    pinned: !!tab.pinned,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    isTabOut: rawUrl === 'chrome://newtab/' || rawUrl.startsWith(`chrome-extension://${globalThis.chrome?.runtime?.id}/index.html`),
    isApp: windowType === 'app' || windowType === 'popup',
    index: tab.index
  }
}

function unwrapWorkingSetSuspenderUrl(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return url || ''
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.endsWith('/suspended.html')) return url
    const fragment = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : ''
    const marker = '&uri='
    const markerIndex = fragment.indexOf(marker)
    const encoded = markerIndex >= 0 ? fragment.slice(markerIndex + marker.length) : fragment.startsWith('uri=') ? fragment.slice(4) : ''
    return encoded ? decodeURIComponent(encoded) || url : url
  } catch {
    return url
  }
}
