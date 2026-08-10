import { Effect, Result, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { DEFAULT_HISTORY_RANGE, HISTORY_FILTER_OFF } from './history-range.js'
import { runPromiseExclusiveEffect } from './promise-exclusive-effect.js'

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
  'all',
])

const isHistoryRangePreference = Schema.is(historyRangePreferenceSchema)

type HistoryRangePreferenceWriterAdapter = {
  write: (value: string) => Promise<void>
  runExclusive: <Value>(task: () => Promise<Value>) => Promise<Value>
}

type HistoryRangePreferenceWriter = {
  save: (historyRange: unknown) => Promise<void>
  saveEffect: (historyRange: unknown) => Effect.Effect<void, HistoryRangePreferenceError>
}

class HistoryRangePreferenceError extends Schema.TaggedErrorClass<HistoryRangePreferenceError>()(
  'HistoryRangePreferenceError',
  { cause: Schema.Defect() },
) {}

/**
 * Keep writes in invocation order. Production requests one origin-wide Web
 * Lock synchronously for every save, so a later page cannot publish its value
 * and then have an older delayed write overwrite it.
 */
export function createHistoryRangePreferenceWriter(
  adapter: HistoryRangePreferenceWriterAdapter,
): HistoryRangePreferenceWriter {
  const saveEffect = Effect.fn('historyRange.save')(function* (historyRange: unknown) {
    const value = isHistoryRangePreference(historyRange) ? historyRange : DEFAULT_HISTORY_RANGE
    // Calling runExclusive before the first await enqueues this request with
    // the shared lock manager at invocation time, preserving cross-context
    // ordering even while an earlier storage write is still pending.
    yield* runPromiseExclusiveEffect(
      adapter.runExclusive,
      Effect.tryPromise({
        try: () => adapter.write(value),
        catch: (cause) => HistoryRangePreferenceError.make({ cause }),
      }),
      (cause) => HistoryRangePreferenceError.make({ cause }),
    )
  })

  function save(historyRange: unknown): Promise<void> {
    return getAppRuntime().runPromise(saveEffect(historyRange).pipe(
      Effect.catchTag('HistoryRangePreferenceError', (error) => Effect.fail(error.cause)),
    ))
  }

  return { save, saveEffect }
}

const historyRangePreferenceWriter = createHistoryRangePreferenceWriter({
  async write(value) {
    await chrome.storage.local.set({ [HISTORY_RANGE_STORAGE_KEY]: value })
  },
  runExclusive: <Value>(task: () => Promise<Value>) => (
    navigator.locks.request(HISTORY_RANGE_STORAGE_WRITE_LOCK, task)
  ),
})

export const loadHistoryRangePreferenceResultEffect = Effect.fn(
  'historyRange.loadResult',
)(function* () {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ok: false, value: DEFAULT_HISTORY_RANGE }
  }
  const stored = yield* Effect.result(Effect.tryPromise({
    try: () => chrome.storage.local.get(HISTORY_RANGE_STORAGE_KEY),
    catch: (cause) => HistoryRangePreferenceError.make({ cause }),
  }))
  if (Result.isFailure(stored)) {
    return { ok: false, value: DEFAULT_HISTORY_RANGE }
  }
  const historyRange = stored.success[HISTORY_RANGE_STORAGE_KEY]
  return {
    ok: true,
    value: isHistoryRangePreference(historyRange) ? historyRange : DEFAULT_HISTORY_RANGE,
  }
})

export const loadHistoryRangePreferenceEffect = Effect.fn('historyRange.load')(function* () {
  return (yield* loadHistoryRangePreferenceResultEffect()).value
})

export function loadHistoryRangePreference(): Promise<string> {
  return getAppRuntime().runPromise(loadHistoryRangePreferenceEffect())
}

export async function saveHistoryRangePreference(historyRange: unknown): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await historyRangePreferenceWriter.save(historyRange)
}
