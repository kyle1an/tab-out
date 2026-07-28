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

export type SavedPagesStoreLoadResult =
  | { ok: true; value: SavedPagesStore }
  | { ok: false; value: SavedPagesStore }

export type SavedPagesStoreMutation<Value> = {
  store: SavedPagesStore
  value: Value
}

export type SavedPagesStoreAdapter = {
  read: () => Promise<unknown>
  write: (store: SavedPagesStore) => Promise<void>
  runExclusive?: <Value>(task: () => Promise<Value>) => Promise<Value>
}

export type SavedPagesMutationStore = {
  mutate: <Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>
  ) => Promise<Value>
  persistMetadataUpdates: (
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined
  ) => Promise<void>
}

export type SavedPageCandidate = Pick<DashboardTab, 'url' | 'rawUrl' | 'title' | 'favIconUrl' | 'isTabOut' | 'isApp'>

export function emptySavedPagesStore(): SavedPagesStore {
  return { version: SAVED_PAGES_VERSION, pages: {} }
}

function parseSavedPagesStoreValue(stored: unknown): SavedPagesStoreLoadResult {
  if (stored === undefined) return { ok: true, value: emptySavedPagesStore() }
  if (
    !stored ||
    typeof stored !== 'object' ||
    (stored as Partial<SavedPagesStore>).version !== SAVED_PAGES_VERSION ||
    !(stored as Partial<SavedPagesStore>).pages ||
    typeof (stored as Partial<SavedPagesStore>).pages !== 'object' ||
    Array.isArray((stored as Partial<SavedPagesStore>).pages)
  ) {
    return { ok: false, value: emptySavedPagesStore() }
  }
  return {
    ok: true,
    value: normalizeSavedPagesStore(stored as Partial<SavedPagesStore>)
  }
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
    if (!baseOpenRecords.has(key)) baseOpenRecords.set(key, record)
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

function savedPageRecordsEqual(a: SavedPageRecord, b: SavedPageRecord): boolean {
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

/**
 * Serialize Saved Pages read-modify-write operations through one seam. The
 * production adapter also supplies a Web Lock, so separate Tab Out pages for
 * the same extension origin cannot both read an old store and overwrite each
 * other's user intent. A rejected read aborts the mutation before any write.
 */
export function createSavedPagesMutationStore(adapter: SavedPagesStoreAdapter): SavedPagesMutationStore {
  let mutationQueue = Promise.resolve()

  function enqueue<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = mutationQueue.then(() => (
      adapter.runExclusive ? adapter.runExclusive(task) : task()
    ))
    mutationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function mutate<Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>
  ): Promise<Value> {
    return enqueue(async () => {
      const parsed = parseSavedPagesStoreValue(await adapter.read())
      if (!parsed.ok) throw new Error('Saved Pages storage is malformed')
      const currentStore = parsed.value
      const result = mutation(currentStore)
      const nextStore = normalizeSavedPagesStore(result.store)
      if (!savedPagesStoresEqual(currentStore, nextStore)) {
        await adapter.write(nextStore)
      }
      return result.value
    })
  }

  function persistMetadataUpdates(
    baseStore: Partial<SavedPagesStore> | null | undefined,
    mergedStore: Partial<SavedPagesStore> | null | undefined
  ): Promise<void> {
    const base = normalizeSavedPagesStore(baseStore)
    const merged = normalizeSavedPagesStore(mergedStore)
    const updates = Object.keys(base.pages).flatMap((key) => {
      const before = base.pages[key]
      const after = merged.pages[key]
      return before && after && !savedPageRecordsEqual(before, after)
        ? [{ key, before, after }]
        : []
    })
    if (updates.length === 0) return Promise.resolve()

    return mutate((latestStore) => {
      const nextStore = normalizeSavedPagesStore(latestStore)
      for (const { key, before, after } of updates) {
        const latestRecord = latestStore.pages[key]
        // The render snapshot is advisory. Apply it only while the stored
        // record is still exactly the version that produced the snapshot;
        // a remove, re-save, or newer metadata refresh always wins.
        if (!latestRecord || !savedPageRecordsEqual(latestRecord, before)) continue
        nextStore.pages[key] = after
      }
      return { store: nextStore, value: undefined }
    })
  }

  return { mutate, persistMetadataUpdates }
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

export async function loadSavedPagesStoreResult(): Promise<SavedPagesStoreLoadResult> {
  try {
    return parseSavedPagesStoreValue(await readSavedPagesStoreValue())
  } catch {
    return { ok: false, value: emptySavedPagesStore() }
  }
}

/** Compatibility loader for optional consumers that intentionally accept empty fallback state. */
export async function loadSavedPagesStore(): Promise<SavedPagesStore> {
  return (await loadSavedPagesStoreResult()).value
}

const SAVED_PAGES_MUTATION_LOCK = 'tab-out:saved-pages-mutation'

function savedPagesStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Saved Pages storage is unavailable')
  }
  return chrome.storage.local
}

async function readSavedPagesStoreValue(): Promise<unknown> {
  const stored = await savedPagesStorageArea().get(SAVED_PAGES_STORAGE_KEY)
  return stored[SAVED_PAGES_STORAGE_KEY]
}

async function writeSavedPagesStoreValue(store: SavedPagesStore): Promise<void> {
  await savedPagesStorageArea().set({ [SAVED_PAGES_STORAGE_KEY]: store })
}

const savedPagesMutationStore = createSavedPagesMutationStore({
  read: readSavedPagesStoreValue,
  write: writeSavedPagesStoreValue,
  runExclusive: (task) => navigator.locks.request(SAVED_PAGES_MUTATION_LOCK, task)
})

export function mutateSavedPagesStore<Value>(
  mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>
): Promise<Value> {
  return savedPagesMutationStore.mutate(mutation)
}

export function persistSavedPageMetadataUpdates(
  baseStore: Partial<SavedPagesStore> | null | undefined,
  mergedStore: Partial<SavedPagesStore> | null | undefined
): Promise<void> {
  return savedPagesMutationStore.persistMetadataUpdates(baseStore, mergedStore)
}
