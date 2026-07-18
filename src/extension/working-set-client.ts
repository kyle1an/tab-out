import {
  WORKING_SET_DEFAULT_LIMIT,
  WORKING_SET_DISMISS_MESSAGE,
  WORKING_SET_EXPANDED_LIMIT,
  WORKING_SET_GET_MESSAGE,
} from './working-set.js'
import type { WorkingSetItem, WorkingSetSnapshot } from './types'
import { focusExistingTabTarget } from './tab-focus.js'

function emptyWorkingSetSnapshot(): WorkingSetSnapshot {
  return {
    defaultLimit: WORKING_SET_DEFAULT_LIMIT,
    expandedLimit: WORKING_SET_EXPANDED_LIMIT,
    items: []
  }
}

export function normalizeWorkingSetSnapshot(snapshot: Partial<WorkingSetSnapshot> | null | undefined): WorkingSetSnapshot {
  if (!snapshot || !Array.isArray(snapshot.items)) return emptyWorkingSetSnapshot()
  const defaultLimit = Number.isInteger(snapshot.defaultLimit) ? Number(snapshot.defaultLimit) : WORKING_SET_DEFAULT_LIMIT
  const expandedLimit = Number.isInteger(snapshot.expandedLimit) ? Number(snapshot.expandedLimit) : WORKING_SET_EXPANDED_LIMIT
  const items = snapshot.items
    .map((item): WorkingSetItem | null => {
      if (!item || typeof item !== 'object' || !Number.isInteger(item.tabId) || !Number.isInteger(item.windowId)) return null
      const tabUrl = String(item.tabUrl || '')
      const key = String(item.key || tabUrl)
      if (!key || !tabUrl) return null
      return {
        key,
        tabId: Number(item.tabId),
        windowId: Number(item.windowId),
        tabUrl,
        rawUrl: String(item.rawUrl || tabUrl),
        title: String(item.title || item.displayUrl || tabUrl),
        displayUrl: String(item.displayUrl || tabUrl),
        faviconUrl: String(item.faviconUrl || ''),
        dupeCount: Number.isInteger(item.dupeCount) ? Math.max(1, Number(item.dupeCount)) : 1,
        active: !!item.active,
        activeInOtherWindow: !!item.activeInOtherWindow,
        loading: !!item.loading,
        score: typeof item.score === 'number' ? item.score : 0,
        lastActivatedAt: typeof item.lastActivatedAt === 'number' ? item.lastActivatedAt : 0
      }
    })
    .filter((item): item is WorkingSetItem => !!item)
  return { defaultLimit, expandedLimit, items }
}

export async function fetchWorkingSetSnapshot(): Promise<WorkingSetSnapshot> {
  if (!globalThis.chrome?.runtime?.sendMessage) return emptyWorkingSetSnapshot()
  try {
    const response = await chrome.runtime.sendMessage({ type: WORKING_SET_GET_MESSAGE })
    if (!response?.ok) return emptyWorkingSetSnapshot()
    return normalizeWorkingSetSnapshot(response.snapshot)
  } catch {
    return emptyWorkingSetSnapshot()
  }
}

export async function focusWorkingSetItem(item: Pick<WorkingSetItem, 'tabId' | 'windowId' | 'tabUrl' | 'rawUrl'>): Promise<boolean> {
  return focusExistingTabTarget({
    tabId: item.tabId,
    windowId: item.windowId,
    url: item.tabUrl,
    rawUrl: item.rawUrl
  })
}

export async function dismissWorkingSetItem(item: Pick<WorkingSetItem, 'key' | 'tabUrl'>): Promise<WorkingSetSnapshot> {
  if (!globalThis.chrome?.runtime?.sendMessage) return emptyWorkingSetSnapshot()
  try {
    const response = await chrome.runtime.sendMessage({
      type: WORKING_SET_DISMISS_MESSAGE,
      key: item.key,
      url: item.tabUrl
    })
    if (!response?.ok) return emptyWorkingSetSnapshot()
    return normalizeWorkingSetSnapshot(response.snapshot)
  } catch {
    return emptyWorkingSetSnapshot()
  }
}
