export const DEFAULT_HISTORY_RANGE = '1d'
export const HISTORY_FILTER_OFF = 'off'
export const HISTORY_RANGE_STORAGE_KEY = 'tabOutHistoryRangeV1'
const HISTORY_RANGE_STORAGE_WRITE_LOCK = 'tab-out:history-range-write'
export const HISTORY_RANGE_OPTIONS = [
  { value: HISTORY_FILTER_OFF, label: 'History off', days: 0 },
  { value: '1d', label: 'Last day', days: 1 },
  { value: '7d', label: 'Last week', days: 7 },
  { value: '30d', label: 'Last month', days: 30 },
  { value: '90d', label: 'Last 3 months', days: 90 },
  { value: '180d', label: 'Last 6 months', days: 180 },
  { value: '365d', label: 'Last year', days: 365 },
  { value: 'all', label: 'All time', days: null }
]

type HistoryRangePreferenceWriterAdapter = {
  write: (value: string) => Promise<void>
  runExclusive: <Value>(task: () => Promise<Value>) => Promise<Value>
}

type HistoryRangePreferenceWriter = {
  save: (historyRange: unknown) => Promise<void>
}

export function isHistoryRangeValue(value: unknown): value is string {
  return typeof value === 'string' && HISTORY_RANGE_OPTIONS.some((option) => option.value === value)
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
    const value = isHistoryRangeValue(historyRange) ? historyRange : DEFAULT_HISTORY_RANGE
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
    return isHistoryRangeValue(historyRange) ? historyRange : DEFAULT_HISTORY_RANGE
  } catch {
    return DEFAULT_HISTORY_RANGE
  }
}

export async function saveHistoryRangePreference(historyRange: unknown): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await historyRangePreferenceWriter.save(historyRange)
}

export function isHistoryFilterEnabled(range = DEFAULT_HISTORY_RANGE): boolean {
  return range !== HISTORY_FILTER_OFF
}
