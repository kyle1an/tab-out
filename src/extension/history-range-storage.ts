import { Schema } from 'effect'

import { DEFAULT_HISTORY_RANGE, HISTORY_FILTER_OFF } from './history-range.js'

export const HISTORY_RANGE_STORAGE_KEY = 'tabOutHistoryRangeV1'
const HISTORY_RANGE_STORAGE_WRITE_LOCK = 'tab-out:history-range-write'

const historyRangePreferenceSchema = Schema.Literals([
  HISTORY_FILTER_OFF,
  '1d',
  '7d',
  '30d',
  '90d',
  '180d',
  '365d',
  'all'
])

const isHistoryRangePreference = Schema.is(historyRangePreferenceSchema)

type HistoryRangePreferenceWriterAdapter = {
  write: (value: string) => Promise<void>
  runExclusive: <Value>(task: () => Promise<Value>) => Promise<Value>
}

type HistoryRangePreferenceWriter = {
  save: (historyRange: unknown) => Promise<void>
}

/**
 * Keep writes in invocation order. Production requests one origin-wide Web
 * Lock synchronously for every save, so a later page cannot publish its value
 * and then have an older delayed write overwrite it.
 */
export function createHistoryRangePreferenceWriter(
  adapter: HistoryRangePreferenceWriterAdapter
): HistoryRangePreferenceWriter {
  async function save(historyRange: unknown): Promise<void> {
    const value = isHistoryRangePreference(historyRange) ? historyRange : DEFAULT_HISTORY_RANGE
    // Calling runExclusive before the first await enqueues this request with
    // the shared lock manager at invocation time, preserving cross-context
    // ordering even while an earlier storage write is still pending.
    await adapter.runExclusive(() => adapter.write(value))
  }

  return { save }
}

const historyRangePreferenceWriter = createHistoryRangePreferenceWriter({
  async write(value) {
    await chrome.storage.local.set({ [HISTORY_RANGE_STORAGE_KEY]: value })
  },
  runExclusive: <Value>(task: () => Promise<Value>) => (
    navigator.locks.request(HISTORY_RANGE_STORAGE_WRITE_LOCK, task)
  )
})

export async function loadHistoryRangePreference(): Promise<string> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return DEFAULT_HISTORY_RANGE
  try {
    const stored = await chrome.storage.local.get(HISTORY_RANGE_STORAGE_KEY)
    const historyRange = stored[HISTORY_RANGE_STORAGE_KEY]
    return isHistoryRangePreference(historyRange) ? historyRange : DEFAULT_HISTORY_RANGE
  } catch {
    return DEFAULT_HISTORY_RANGE
  }
}

export async function saveHistoryRangePreference(historyRange: unknown): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await historyRangePreferenceWriter.save(historyRange)
}
