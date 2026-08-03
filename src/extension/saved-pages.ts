import { makeDashboardItem } from './dashboard-item.js'
import type { DashboardTab } from './types'
import { isBrowserInternalUrl } from './browser-url-policy.js'

export const SAVED_PAGES_STORAGE_KEY = 'tabOutSavedPagesV1'
const SAVED_PAGES_VERSION = 1
export interface SavedPageRecord {
  key: string
  url: string
  title: string
  favIconUrl?: string
  savedAt: number
  updatedAt: number
  lastSeenOpenAt?: number
}

export interface SavedPagesStore {
  version: 1
  pages: Record<string, SavedPageRecord>
}

/**
 * A dashboard build's Saved Page metadata refresh, returned as data so builds
 * stay pure. Only page-side fetchers hand it to the writer; the worker's
 * builds discard it.
 */
export type SavedPageMetadataUpdates = {
  base: SavedPagesStore
  merged: SavedPagesStore
}

export type SavedPagesStoreLoadResult =
  | { ok: true; value: SavedPagesStore }
  | { ok: false; value: SavedPagesStore }

export type SavedPagesStoreMutation<Value> = {
  store: SavedPagesStore
  value: Value
}

export type SavedPageCandidate = Pick<DashboardTab, 'url' | 'rawUrl' | 'title' | 'favIconUrl' | 'isTabOut' | 'isApp'>

export function emptySavedPagesStore(): SavedPagesStore {
  return { version: SAVED_PAGES_VERSION, pages: {} }
}

export function savedPageKeyForUrl(url = ''): string {
  if (!url) return ''
  const parsed = URL.parse(url)
  if (!parsed || isBrowserInternalUrl(parsed.href)) return ''
  return parsed.href
}

export function isSavedPageEligible(candidate: Pick<DashboardTab, 'url'> & Partial<Pick<DashboardTab, 'isTabOut' | 'isApp'>>): boolean {
  if (candidate.isTabOut || candidate.isApp) return false
  return !!savedPageKeyForUrl(candidate.url || '')
}

export function normalizeSavedPagesStore(store: Partial<SavedPagesStore> | null | undefined): SavedPagesStore {
  if (!store || store.version !== SAVED_PAGES_VERSION || !store.pages || typeof store.pages !== 'object') {
    return emptySavedPagesStore()
  }

  const pages: Record<string, SavedPageRecord> = {}
  for (const record of Object.values(store.pages)) {
    if (!record || typeof record !== 'object') continue
    const key = savedPageKeyForUrl(record.url || record.key || '')
    if (!key || key !== record.key) continue
    const savedAt = numberOrNow(record.savedAt, 0)
    const updatedAt = numberOrNow(record.updatedAt, savedAt)
    pages[key] = {
      key,
      url: record.url || key,
      title: String(record.title || ''),
      ...(record.favIconUrl ? { favIconUrl: String(record.favIconUrl) } : {}),
      savedAt,
      updatedAt,
      ...(typeof record.lastSeenOpenAt === 'number' && Number.isFinite(record.lastSeenOpenAt) ? { lastSeenOpenAt: record.lastSeenOpenAt } : {})
    }
  }

  return { version: SAVED_PAGES_VERSION, pages }
}

export function savedPageKeysFromStore(store: Partial<SavedPagesStore> | null | undefined): string[] {
  return Object.keys(normalizeSavedPagesStore(store).pages)
}

function numberOrNow(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function addSavedPageToStore(store: Partial<SavedPagesStore> | null | undefined, tab: SavedPageCandidate, at = Date.now()): SavedPagesStore {
  const next = normalizeSavedPagesStore(store)
  if (!isSavedPageEligible(tab)) return next
  const key = savedPageKeyForUrl(tab.url || tab.rawUrl || '')
  if (!key) return next
  const existing = next.pages[key]
  const favIconUrl = tab.favIconUrl || existing?.favIconUrl
  next.pages[key] = {
    key,
    url: tab.url || key,
    title: tab.title || existing?.title || displayUrlForSavedPage(key),
    ...(favIconUrl ? { favIconUrl } : {}),
    savedAt: existing?.savedAt || at,
    updatedAt: at,
    lastSeenOpenAt: at
  }
  return next
}

export function removeSavedPageFromStore(store: Partial<SavedPagesStore> | null | undefined, keyOrUrl: string): { store: SavedPagesStore; removed: SavedPageRecord | null } {
  const next = normalizeSavedPagesStore(store)
  const key = savedPageKeyForUrl(keyOrUrl)
  const removed = key ? next.pages[key] || null : null
  if (key) delete next.pages[key]
  return { store: next, removed }
}

export function restoreSavedPageToStore(store: Partial<SavedPagesStore> | null | undefined, record: SavedPageRecord | null | undefined): SavedPagesStore {
  const next = normalizeSavedPagesStore(store)
  if (!record) return next
  const normalized = normalizeSavedPagesStore({ version: SAVED_PAGES_VERSION, pages: { [record.key]: record } })
  const restored = normalized.pages[record.key]
  // Undo belongs to the specific removal that captured `record`. If the user
  // has since saved the same URL again, that newer record owns the key and
  // stale Undo metadata must not replace it.
  if (!restored || next.pages[record.key]) return next
  return {
    ...next,
    pages: {
      ...next.pages,
      [record.key]: restored
    }
  }
}

export function mergeSavedPagesWithTabs(tabs: DashboardTab[], store: Partial<SavedPagesStore> | null | undefined, now = Date.now()): { tabs: DashboardTab[]; store: SavedPagesStore } {
  const normalized = normalizeSavedPagesStore(store)
  const openKeys = new Set<string>()
  const baseOpenRecords = new Map<string, SavedPageRecord>()
  let changed = false

  const mergedOpenTabs = tabs.map((tab) => {
    const key = savedPageKeyForUrl(tab.url || tab.rawUrl || '')
    if (!key || !normalized.pages[key]) return tab
    openKeys.add(key)
    const record = normalized.pages[key]
    baseOpenRecords.getOrInsert(key, record)
    const nextTitle = tab.status === 'loading' ? record.title : tab.title || record.title
    const nextFavIconUrl = tab.favIconUrl || record.favIconUrl
    const metadataChanged = nextTitle !== record.title || (nextFavIconUrl || '') !== (record.favIconUrl || '')
    const needsLastSeenOpenAt = typeof record.lastSeenOpenAt !== 'number' || !Number.isFinite(record.lastSeenOpenAt)
    const nextRecord: SavedPageRecord = {
      ...record,
      title: nextTitle,
      ...(nextFavIconUrl ? { favIconUrl: nextFavIconUrl } : {}),
      updatedAt: metadataChanged ? now : record.updatedAt,
      ...(metadataChanged || needsLastSeenOpenAt
        ? { lastSeenOpenAt: now }
        : record.lastSeenOpenAt === undefined
          ? {}
          : { lastSeenOpenAt: record.lastSeenOpenAt })
    }
    if (!savedPageRecordsEqual(record, nextRecord)) {
      normalized.pages[key] = nextRecord
    }
    return {
      ...tab,
      title: nextTitle,
      saved: true,
      closedSaved: false,
      savedPageKey: key
    }
  })

  for (const [key, baseRecord] of baseOpenRecords) {
    const mergedRecord = normalized.pages[key]
    if (!mergedRecord) continue
    const metadataChanged = mergedRecord.title !== baseRecord.title || (mergedRecord.favIconUrl || '') !== (baseRecord.favIconUrl || '')
    const needsLastSeenOpenAt = typeof baseRecord.lastSeenOpenAt !== 'number' || !Number.isFinite(baseRecord.lastSeenOpenAt)
    const nextRecord: SavedPageRecord = {
      ...mergedRecord,
      updatedAt: metadataChanged ? now : baseRecord.updatedAt,
      ...(metadataChanged || needsLastSeenOpenAt
        ? { lastSeenOpenAt: now }
        : baseRecord.lastSeenOpenAt === undefined
          ? {}
          : { lastSeenOpenAt: baseRecord.lastSeenOpenAt })
    }
    normalized.pages[key] = nextRecord
    if (!savedPageRecordsEqual(baseRecord, nextRecord)) changed = true
  }

  const closedSavedTabs = Object.values(normalized.pages)
    .filter((record) => !openKeys.has(record.key))
    .map(savedPageRecordToDashboardTab)

  return {
    tabs: [...mergedOpenTabs, ...closedSavedTabs],
    store: changed ? normalizeSavedPagesStore(normalized) : normalized
  }
}

export function annotateSavedPageHints(tabs: DashboardTab[], store: Partial<SavedPagesStore> | null | undefined): DashboardTab[] {
  const normalized = normalizeSavedPagesStore(store)
  return tabs.map((tab) => {
    const key = savedPageKeyForUrl(tab.url || tab.rawUrl || '')
    if (!key || !normalized.pages[key]) return tab
    return {
      ...tab,
      saved: true,
      closedSaved: false,
      savedPageKey: key
    }
  })
}

export function savedPagesStoresEqual(a: Partial<SavedPagesStore> | null | undefined, b: Partial<SavedPagesStore> | null | undefined): boolean {
  const left = normalizeSavedPagesStore(a)
  const right = normalizeSavedPagesStore(b)
  const leftKeys = Object.keys(left.pages).sort()
  const rightKeys = Object.keys(right.pages).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let i = 0; i < leftKeys.length; i += 1) {
    const key = leftKeys[i]
    if (key === undefined || key !== rightKeys[i]) return false
    const leftRecord = left.pages[key]
    const rightRecord = right.pages[key]
    if (!leftRecord || !rightRecord || !savedPageRecordsEqual(leftRecord, rightRecord)) return false
  }
  return true
}

export function savedPageRecordsEqual(a: SavedPageRecord, b: SavedPageRecord): boolean {
  return (
    a.key === b.key &&
    a.url === b.url &&
    a.title === b.title &&
    (a.favIconUrl || '') === (b.favIconUrl || '') &&
    a.savedAt === b.savedAt &&
    a.updatedAt === b.updatedAt &&
    (a.lastSeenOpenAt || 0) === (b.lastSeenOpenAt || 0)
  )
}

function savedPageRecordToDashboardTab(record: SavedPageRecord): DashboardTab {
  return makeDashboardItem({
    id: `saved:${record.key}`,
    url: record.url,
    title: record.title || displayUrlForSavedPage(record.url),
    favIconUrl: record.favIconUrl || '',
    windowId: 0,
    sourceType: 'saved-page',
    saved: true,
    closedSaved: true,
    savedPageKey: record.key
  })
}

function displayUrlForSavedPage(url = ''): string {
  const parsed = URL.parse(url)
  if (!parsed) return url
  if (parsed.protocol === 'file:') return parsed.pathname
  return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
}
