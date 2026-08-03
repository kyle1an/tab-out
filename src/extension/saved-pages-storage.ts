import { Schema } from 'effect'

import {
  emptySavedPagesStore,
  SAVED_PAGES_STORAGE_KEY,
  savedPageKeyForUrl,
  type SavedPageRecord,
  type SavedPagesStore,
  type SavedPagesStoreLoadResult
} from './saved-pages.js'

const savedPagesStoreEnvelopeSchema = Schema.Struct({
  version: Schema.Literals([1]),
  pages: Schema.Record(Schema.String, Schema.Unknown)
})

const savedPageRecordCandidateSchema = Schema.Struct({
  key: Schema.String,
  url: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.Unknown),
  favIconUrl: Schema.optionalKey(Schema.Unknown),
  savedAt: Schema.optionalKey(Schema.Unknown),
  updatedAt: Schema.optionalKey(Schema.Unknown),
  lastSeenOpenAt: Schema.optionalKey(Schema.Unknown)
})

type SavedPagesStoreEnvelope = typeof savedPagesStoreEnvelopeSchema.Type

const isSavedPagesStoreEnvelope = Schema.is(savedPagesStoreEnvelopeSchema)
const isSavedPageRecordCandidate = Schema.is(savedPageRecordCandidateSchema)

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeSavedPagesStoreEnvelope(store: SavedPagesStoreEnvelope): SavedPagesStore {
  const pages: Record<string, SavedPageRecord> = {}
  for (const record of Object.values(store.pages)) {
    if (!isSavedPageRecordCandidate(record)) continue
    const recordUrl = record.url || ''
    const key = savedPageKeyForUrl(recordUrl || record.key)
    if (!key || key !== record.key) continue
    const savedAt = finiteNumberOr(record.savedAt, 0)
    const updatedAt = finiteNumberOr(record.updatedAt, savedAt)
    pages[key] = {
      key,
      url: recordUrl || key,
      title: String(record.title || ''),
      ...(record.favIconUrl ? { favIconUrl: String(record.favIconUrl) } : {}),
      savedAt,
      updatedAt,
      ...(typeof record.lastSeenOpenAt === 'number' && Number.isFinite(record.lastSeenOpenAt)
        ? { lastSeenOpenAt: record.lastSeenOpenAt }
        : {})
    }
  }
  return { version: 1, pages }
}

export function parseSavedPagesStoreValue(stored: unknown): SavedPagesStoreLoadResult {
  if (stored === undefined) return { ok: true, value: emptySavedPagesStore() }
  return isSavedPagesStoreEnvelope(stored)
    ? { ok: true, value: normalizeSavedPagesStoreEnvelope(stored) }
    : { ok: false, value: emptySavedPagesStore() }
}

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
