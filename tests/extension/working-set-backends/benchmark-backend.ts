import { Schema } from 'effect'

import type {
  WorkingSetActivityEvent,
  WorkingSetActivityRecord,
  WorkingSetActivityStore
} from '../../../src/extension/types'
import type {
  WorkingSetStorageBenchmarkBackend,
  WorkingSetStorageBenchmarkOwnedStorage
} from '../working-set-storage-benchmark-protocol.js'

export const DISPOSABLE_BENCHMARK_PREFIX =
  'tabOutDisposableWorkingSetStorageBenchmarkV1'

const COMPACT_ACTIVITY_ENCODING_VERSION = 1

export const compactActivityEventSchema = Schema.Tuple([
  Schema.Literals([0, 1]),
  Schema.Finite
])

export const compactActivityRowSchema = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.NullOr(Schema.Finite),
  Schema.NullOr(Schema.Finite),
  Schema.Array(compactActivityEventSchema)
])

const compactActivityStoredRowSchema = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.NullOr(Schema.Finite),
  Schema.NullOr(Schema.Finite),
  Schema.Array(Schema.Unknown)
])

export const compactActivityEnvelopeSchema = Schema.Tuple([
  Schema.Literals([COMPACT_ACTIVITY_ENCODING_VERSION]),
  Schema.Array(compactActivityRowSchema)
])

const compactActivityStorageEnvelopeSchema = Schema.Tuple([
  Schema.Literals([COMPACT_ACTIVITY_ENCODING_VERSION]),
  Schema.Array(Schema.Unknown)
])

export type CompactActivityRow = typeof compactActivityRowSchema.Type
export type CompactActivityEnvelope = typeof compactActivityEnvelopeSchema.Type

export type BenchmarkOwnedStorage = WorkingSetStorageBenchmarkOwnedStorage
export type WorkingSetBenchmarkBackend = WorkingSetStorageBenchmarkBackend

export interface BenchmarkChromeStorageArea {
  readonly get: (
    keys: string | string[]
  ) => Promise<Record<string, unknown>>
  readonly set: (items: Record<string, unknown>) => Promise<void>
  readonly remove: (keys: string | string[]) => Promise<void>
}

export interface MutationDiagnostics {
  readonly beginWrite: () => void
  readonly commitMutation: (
    values: readonly unknown[],
    physicalWrites: readonly string[]
  ) => void
  readonly lastMutationLogicalBytes: () => number
  readonly lastMutationPhysicalWrites: () => readonly string[]
  readonly writeInvocationCount: () => number
  readonly reset: () => void
}

export function makeMutationDiagnostics(): MutationDiagnostics {
  let logicalValues: readonly unknown[] = []
  let logicalBytes: number | undefined
  let physicalWrites: readonly string[] = []
  let writes = 0

  return {
    beginWrite() {
      writes += 1
    },
    commitMutation(values, nextPhysicalWrites) {
      logicalValues = [...values]
      logicalBytes = undefined
      physicalWrites = [...nextPhysicalWrites]
    },
    lastMutationLogicalBytes() {
      if (logicalBytes !== undefined) return logicalBytes
      logicalBytes = logicalValues.reduce<number>(
        (total, value) => total + jsonUtf8ByteLength(value),
        0
      )
      return logicalBytes
    },
    lastMutationPhysicalWrites: () => [...physicalWrites],
    writeInvocationCount: () => writes,
    reset() {
      logicalValues = []
      logicalBytes = undefined
      physicalWrites = []
      writes = 0
    }
  }
}

export function makePromiseSerializer() {
  let tail: Promise<void> = Promise.resolve()

  return function serialize<Value>(task: () => Promise<Value>): Promise<Value> {
    const result = tail.then(task, task)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export function encodeCompactActivityRecord(
  record: WorkingSetActivityRecord
): CompactActivityRow {
  return [
    record.key,
    record.title,
    record.dismissedAt ?? null,
    record.dismissedUntil ?? null,
    record.events.map(encodeCompactEvent)
  ]
}

export function encodeCompactActivityEnvelope(
  activity: WorkingSetActivityStore
): CompactActivityEnvelope {
  return [
    COMPACT_ACTIVITY_ENCODING_VERSION,
    Object.values(activity.records)
      .toSorted((left, right) => left.key.localeCompare(right.key))
      .map(encodeCompactActivityRecord)
  ]
}

export async function decodeCompactActivityEnvelope(
  value: unknown
): Promise<WorkingSetActivityStore> {
  const envelope = await Schema.decodeUnknownPromise(
    compactActivityStorageEnvelopeSchema
  )(value)
  const decodedRows = await Promise.allSettled(
    envelope[1].map(decodeCompactActivityRow)
  )
  return materializeCompactActivityRows(decodedRows.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  ))
}

async function decodeCompactActivityRow(
  value: unknown
): Promise<CompactActivityRow> {
  const stored = await Schema.decodeUnknownPromise(
    compactActivityStoredRowSchema
  )(value)
  const decodedEvents = await Promise.allSettled(stored[4].map((event) =>
    Schema.decodeUnknownPromise(compactActivityEventSchema)(event)
  ))
  return [
    stored[0],
    stored[1],
    stored[2],
    stored[3],
    decodedEvents.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    )
  ]
}

export function materializeCompactActivityRows(
  rows: readonly CompactActivityRow[]
): WorkingSetActivityStore {
  return {
    version: 1,
    records: Object.fromEntries(rows.map((row) => {
      const events = row[4].map(decodeCompactEvent)
      const lastSeenAt = events.reduce(
        (latest, event) => Math.max(latest, event.at),
        0
      )
      const lastActivatedAt = latestEventAt(events, 'activation')
      const lastNavigatedAt = latestEventAt(events, 'navigation')
      const record: WorkingSetActivityRecord = {
        key: row[0],
        url: row[0],
        title: row[1],
        domain: URL.parse(row[0])?.hostname || '',
        lastSeenAt,
        ...(lastActivatedAt === undefined ? {} : { lastActivatedAt }),
        ...(lastNavigatedAt === undefined ? {} : { lastNavigatedAt }),
        ...(row[2] === null ? {} : { dismissedAt: row[2] }),
        ...(row[3] === null ? {} : { dismissedUntil: row[3] }),
        events
      }
      return [record.key, record]
    }))
  }
}

export function jsonUtf8ByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function encodeCompactEvent(
  event: WorkingSetActivityEvent
): typeof compactActivityEventSchema.Type {
  return event.kind === 'activation'
    ? [0, event.at]
    : [1, event.at]
}

function decodeCompactEvent(
  event: typeof compactActivityEventSchema.Type
): WorkingSetActivityEvent {
  return {
    kind: event[0] === 0 ? 'activation' : 'navigation',
    at: event[1]
  }
}

function latestEventAt(
  events: readonly WorkingSetActivityEvent[],
  kind: WorkingSetActivityEvent['kind']
): number | undefined {
  const latest = events
    .filter((event) => event.kind === kind)
    .reduce((maximum, event) => Math.max(maximum, event.at), 0)
  return latest || undefined
}
