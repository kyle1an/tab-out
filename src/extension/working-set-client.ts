import { Schema } from 'effect'

import {
  WORKING_SET_DEFAULT_LIMIT,
  WORKING_SET_EXPANDED_LIMIT,
} from './working-set.js'
import type { WorkingSetItem, WorkingSetSnapshot } from './types'
import { focusExistingTabTargetResult, type ExistingTabFocusResult } from './tab-focus.js'

const workingSetSnapshotCandidateSchema = Schema.Struct({
  defaultLimit: Schema.optionalKey(Schema.Unknown),
  expandedLimit: Schema.optionalKey(Schema.Unknown),
  items: Schema.Array(Schema.Unknown),
})

const workingSetItemCandidateSchema = Schema.Struct({
  key: Schema.optionalKey(Schema.Unknown),
  tabId: Schema.Int,
  windowId: Schema.Int,
  tabUrl: Schema.optionalKey(Schema.Unknown),
  rawUrl: Schema.optionalKey(Schema.Unknown),
  title: Schema.optionalKey(Schema.Unknown),
  displayUrl: Schema.optionalKey(Schema.Unknown),
  faviconUrl: Schema.optionalKey(Schema.Unknown),
  dupeCount: Schema.optionalKey(Schema.Unknown),
  active: Schema.optionalKey(Schema.Unknown),
  activeInOtherWindow: Schema.optionalKey(Schema.Unknown),
  loading: Schema.optionalKey(Schema.Unknown),
  score: Schema.optionalKey(Schema.Unknown),
  lastActivatedAt: Schema.optionalKey(Schema.Unknown),
})

const isWorkingSetSnapshotCandidate = Schema.is(workingSetSnapshotCandidateSchema)
const isWorkingSetItemCandidate = Schema.is(workingSetItemCandidateSchema)

function emptyWorkingSetSnapshot(): WorkingSetSnapshot {
  return {
    defaultLimit: WORKING_SET_DEFAULT_LIMIT,
    expandedLimit: WORKING_SET_EXPANDED_LIMIT,
    items: [],
  }
}

export function normalizeWorkingSetSnapshot(value: unknown): WorkingSetSnapshot {
  if (!isWorkingSetSnapshotCandidate(value)) return emptyWorkingSetSnapshot()
  const defaultLimit = Number.isInteger(value.defaultLimit) ? Number(value.defaultLimit) : WORKING_SET_DEFAULT_LIMIT
  const expandedLimit = Number.isInteger(value.expandedLimit) ? Number(value.expandedLimit) : WORKING_SET_EXPANDED_LIMIT
  const items = value.items
    .map((item): WorkingSetItem | null => {
      if (!isWorkingSetItemCandidate(item)) return null
      const tabUrl = String(item.tabUrl || '')
      const key = String(item.key || tabUrl)
      if (!key || !tabUrl) return null
      return {
        key,
        tabId: item.tabId,
        windowId: item.windowId,
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
        lastActivatedAt: typeof item.lastActivatedAt === 'number' ? item.lastActivatedAt : 0,
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
    rawUrl: item.rawUrl,
  })
}
