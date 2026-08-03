import {
  WORKING_SET_DEFAULT_LIMIT,
  WORKING_SET_EXPANDED_LIMIT
} from './working-set.js'
import type { WorkingSetItem, WorkingSetSnapshot } from './types'
import { focusExistingTabTargetResult, type ExistingTabFocusResult } from './tab-focus.js'

function emptyWorkingSetSnapshot(): WorkingSetSnapshot {
  return {
    defaultLimit: WORKING_SET_DEFAULT_LIMIT,
    expandedLimit: WORKING_SET_EXPANDED_LIMIT,
    items: []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeWorkingSetSnapshot(value: unknown): WorkingSetSnapshot {
  if (!isRecord(value)) return emptyWorkingSetSnapshot()
  const rawItems = value.items
  if (!Array.isArray(rawItems)) return emptyWorkingSetSnapshot()
  const snapshot = value
  const defaultLimit = Number.isInteger(snapshot.defaultLimit) ? Number(snapshot.defaultLimit) : WORKING_SET_DEFAULT_LIMIT
  const expandedLimit = Number.isInteger(snapshot.expandedLimit) ? Number(snapshot.expandedLimit) : WORKING_SET_EXPANDED_LIMIT
  const items = rawItems
    .map((item): WorkingSetItem | null => {
      if (!isRecord(item) || !Number.isInteger(item.tabId) || !Number.isInteger(item.windowId)) return null
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

export async function focusWorkingSetItemResult(item: Pick<WorkingSetItem, 'tabId' | 'windowId' | 'tabUrl' | 'rawUrl'>): Promise<ExistingTabFocusResult> {
  return focusExistingTabTargetResult({
    tabId: item.tabId,
    windowId: item.windowId,
    url: item.tabUrl,
    rawUrl: item.rawUrl
  })
}
