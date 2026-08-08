import type { Layer } from 'effect'
import { Schema } from 'effect'
import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase
} from 'idb'

import type { ChromeApi } from '../../../src/extension/background/chrome-api.js'
import {
  WorkingSetActivityStorage,
  type WorkingSetActivityStorageBackend,
  type WorkingSetActivityWrite
} from '../../../src/extension/background/working-set-activity-storage.js'
import type {
  WorkingSetActivityEvent,
  WorkingSetActivityRecord,
  WorkingSetActivityStore
} from '../../../src/extension/types'
import {
  compactActivityEventSchema,
  DISPOSABLE_BENCHMARK_PREFIX,
  encodeCompactActivityRecord,
  makeMutationDiagnostics,
  makePromiseSerializer,
  makeReadDiagnostics,
  materializeCompactActivityRows,
  type CompactActivityRow,
  type WorkingSetBenchmarkBackend
} from './benchmark-backend.js'

export const DISPOSABLE_INDEXED_DB_NAME =
  `${DISPOSABLE_BENCHMARK_PREFIX}:indexed-db`
export const INDEXED_DB_RECORDS_STORE = 'page-activity'
export const INDEXED_DB_LAST_EVENT_INDEX = 'last-event-at'

const DATABASE_VERSION = 1
const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export const indexedDbActivityValueSchema = Schema.Struct({
  title: Schema.String,
  dismissedAt: Schema.optionalKey(Schema.Finite),
  dismissedUntil: Schema.optionalKey(Schema.Finite),
  events: Schema.Array(compactActivityEventSchema),
  lastEventAt: Schema.Finite
})

const indexedDbStoredActivityValueSchema = Schema.Struct({
  title: Schema.String,
  dismissedAt: Schema.optionalKey(Schema.Finite),
  dismissedUntil: Schema.optionalKey(Schema.Finite),
  events: Schema.Array(Schema.Unknown),
  lastEventAt: Schema.Finite
})

export type IndexedDbActivityValue =
  typeof indexedDbActivityValueSchema.Type

interface WorkingSetBenchmarkDatabase extends DBSchema {
  readonly [INDEXED_DB_RECORDS_STORE]: {
    readonly key: string
    readonly value: IndexedDbActivityValue
    readonly indexes: {
      readonly [INDEXED_DB_LAST_EVENT_INDEX]: number
    }
  }
}

export interface IndexedDbBenchmarkTestOptions {
  readonly shouldAbortTransaction?: () => boolean
}

const diagnostics = makeMutationDiagnostics()
const readDiagnostics = makeReadDiagnostics()
const closeConnections = new Set<() => Promise<void>>()
let failNextWrite = false

interface MutableReadDiagnostics {
  backendReadTotalMs: number
  openDatabaseMs: number
  expiryScanMs: number
  expiryDeleteMs: number
  retainedFetchMs: number
  decodeMaterializeMs: number
  fetchedRows: number
  validRows: number
  invalidRows: number
  fetchedEvents: number
  validEvents: number
  invalidEvents: number
}

interface ExpirySweepDiagnostics {
  readonly scanMs: number
  readonly deleteMs: number
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt)
}

function makeEmptyReadDiagnostics(): MutableReadDiagnostics {
  return {
    backendReadTotalMs: 0,
    openDatabaseMs: 0,
    expiryScanMs: 0,
    expiryDeleteMs: 0,
    retainedFetchMs: 0,
    decodeMaterializeMs: 0,
    fetchedRows: 0,
    validRows: 0,
    invalidRows: 0,
    fetchedEvents: 0,
    validEvents: 0,
    invalidEvents: 0
  }
}

export function makeWorkingSetActivityStorageLayer(
  _chromeApi: ChromeApi
): Layer.Layer<WorkingSetActivityStorage> {
  return makeIndexedDbStorageLayer()
}

export function makeIndexedDbStorageLayer(
  options: IndexedDbBenchmarkTestOptions = {}
): Layer.Layer<WorkingSetActivityStorage> {
  return WorkingSetActivityStorage.layer(makeIndexedDbBackend(options))
}

function makeIndexedDbBackend(
  options: IndexedDbBenchmarkTestOptions
): WorkingSetActivityStorageBackend {
  const serialize = makePromiseSerializer()
  let databasePromise:
    | Promise<IDBPDatabase<WorkingSetBenchmarkDatabase>>
    | undefined

  const close = async (): Promise<void> => {
    const pending = databasePromise
    databasePromise = undefined
    if (pending !== undefined) (await pending).close()
  }
  closeConnections.add(close)

  const database = (
    currentReadDiagnostics?: MutableReadDiagnostics
  ): Promise<IDBPDatabase<WorkingSetBenchmarkDatabase>> => {
    if (databasePromise !== undefined) return databasePromise
    const openStartedAt = performance.now()
    const pending = openDB<WorkingSetBenchmarkDatabase>(
      DISPOSABLE_INDEXED_DB_NAME,
      DATABASE_VERSION,
      {
        upgrade(db, oldVersion) {
          if (oldVersion >= DATABASE_VERSION) return
          createDatabaseSchema(db)
        },
        blocking() {
          void close()
        },
        terminated() {
          databasePromise = undefined
        }
      }
    ).then(async (db) => {
      if (currentReadDiagnostics !== undefined) {
        currentReadDiagnostics.openDatabaseMs = elapsedSince(openStartedAt)
      }
      try {
        const sweepDiagnostics = await sweepExpiredRows(db)
        if (currentReadDiagnostics !== undefined) {
          currentReadDiagnostics.expiryScanMs = sweepDiagnostics.scanMs
          currentReadDiagnostics.expiryDeleteMs = sweepDiagnostics.deleteMs
        }
        return db
      } catch (cause) {
        db.close()
        throw cause
      }
    })
    databasePromise = pending
    void pending.catch(() => {
      if (databasePromise === pending) databasePromise = undefined
    })
    return pending
  }

  const commit = async (
    change: WorkingSetActivityWrite
  ): Promise<void> => {
    const physicalWrites = [
      ...change.deleteKeys.map((key) => `${INDEXED_DB_RECORDS_STORE}:delete:${key}`),
      ...(change.upsert === null
        ? []
        : [`${INDEXED_DB_RECORDS_STORE}:put:${change.upsert.key}`])
    ]
    if (physicalWrites.length === 0) {
      diagnostics.commitMutation([], [])
      return
    }

    const db = await database()
    const transaction = db.transaction(
      INDEXED_DB_RECORDS_STORE,
      'readwrite',
      { durability: 'relaxed' }
    )
    const operations: Array<Promise<unknown>> = change.deleteKeys.map((key) =>
      transaction.store.delete(key)
    )
    const entries: Array<readonly [string, IndexedDbActivityValue]> = []
    if (change.upsert !== null) {
      const entry = encodeIndexedDbEntry(change.upsert)
      entries.push(entry)
      operations.push(transaction.store.put(entry[1], entry[0]))
    }
    const shouldAbort = failNextWrite ||
      options.shouldAbortTransaction?.() === true
    if (failNextWrite) failNextWrite = false
    if (shouldAbort) {
      const settledOperations = Promise.allSettled(operations)
      transaction.abort()
      try {
        await transaction.done
      } finally {
        await settledOperations
      }
      throw new Error('Aborted IndexedDB benchmark transaction completed')
    }
    await Promise.all([...operations, transaction.done])
    diagnostics.commitMutation(entries, physicalWrites)
  }

  const replace = async (
    activity: WorkingSetActivityStore
  ): Promise<void> => {
    const db = await database()
    const transaction = db.transaction(
      INDEXED_DB_RECORDS_STORE,
      'readwrite',
      { durability: 'strict' }
    )
    const entries = Object.values(activity.records)
      .toSorted((left, right) => left.key.localeCompare(right.key))
      .map(encodeIndexedDbEntry)
    const operations: Array<Promise<unknown>> = [transaction.store.clear()]
    operations.push(...entries.map(([key, value]) =>
      transaction.store.put(value, key)
    ))
    if (options.shouldAbortTransaction?.() === true) transaction.abort()
    await Promise.all([...operations, transaction.done])
    diagnostics.commitMutation(entries, [
      `${INDEXED_DB_RECORDS_STORE}:clear`,
      ...entries.map(([key]) => `${INDEXED_DB_RECORDS_STORE}:put:${key}`)
    ])
  }

  return {
    read: () => serialize(async () => {
      const readStartedAt = performance.now()
      const currentReadDiagnostics = makeEmptyReadDiagnostics()
      const db = await database(currentReadDiagnostics)
      const retainedRange = IDBKeyRange.lowerBound(
        Date.now() - ACTIVITY_RETENTION_MS
      )
      const transaction = db.transaction(
        INDEXED_DB_RECORDS_STORE,
        'readonly'
      )
      const retained = transaction.store.index(INDEXED_DB_LAST_EVENT_INDEX)
      const fetchStartedAt = performance.now()
      const [storedKeys, storedValues] = await Promise.all([
        retained.getAllKeys(retainedRange),
        retained.getAll(retainedRange),
        transaction.done
      ])
      currentReadDiagnostics.retainedFetchMs = elapsedSince(fetchStartedAt)
      currentReadDiagnostics.fetchedRows = storedKeys.length
      currentReadDiagnostics.fetchedEvents = storedValues.reduce(
        (total, value) => total + storedEventCount(value),
        0
      )
      const decodeStartedAt = performance.now()
      const decodedRecords = await Promise.allSettled(storedKeys.map(
        (key, index) => decodeIndexedDbEntry(key, storedValues[index])
      ))
      const activity: WorkingSetActivityStore = {
        version: 1,
        records: Object.fromEntries(decodedRecords.flatMap((result) =>
          result.status === 'fulfilled'
            ? [[result.value.key, result.value]]
            : []
        ))
      }
      currentReadDiagnostics.decodeMaterializeMs = elapsedSince(decodeStartedAt)
      const validRecords = Object.values(activity.records)
      currentReadDiagnostics.validRows = validRecords.length
      currentReadDiagnostics.invalidRows = Math.max(
        0,
        currentReadDiagnostics.fetchedRows - currentReadDiagnostics.validRows
      )
      currentReadDiagnostics.validEvents = validRecords.reduce(
        (total, record) => total + record.events.length,
        0
      )
      currentReadDiagnostics.invalidEvents = Math.max(
        0,
        currentReadDiagnostics.fetchedEvents - currentReadDiagnostics.validEvents
      )
      currentReadDiagnostics.backendReadTotalMs = elapsedSince(readStartedAt)
      readDiagnostics.record(currentReadDiagnostics)
      return activity
    }),
    write: (change: WorkingSetActivityWrite) => {
      diagnostics.beginWrite()
      return serialize(() => commit(change))
    },
    replace: (activity: WorkingSetActivityStore) =>
      serialize(() => replace(activity))
  }
}

export function encodeIndexedDbEntry(
  record: WorkingSetActivityRecord
): readonly [string, IndexedDbActivityValue] {
  const compactEvents = encodeCompactActivityRecord(record)[4]
  return [record.key, {
    title: record.title,
    ...(record.dismissedAt === undefined
      ? {}
      : { dismissedAt: record.dismissedAt }),
    ...(record.dismissedUntil === undefined
      ? {}
      : { dismissedUntil: record.dismissedUntil }),
    events: compactEvents,
    lastEventAt: latestEventAt(record.events)
  }]
}

export async function decodeIndexedDbEntry(
  key: unknown,
  value: unknown
): Promise<WorkingSetActivityRecord> {
  const [decodedKey, storedValue] = await Promise.all([
    Schema.decodeUnknownPromise(Schema.String)(key),
    Schema.decodeUnknownPromise(indexedDbStoredActivityValueSchema)(value)
  ])
  const decodedEvents = await Promise.allSettled(storedValue.events.map(
    (event) => Schema.decodeUnknownPromise(compactActivityEventSchema)(event)
  ))
  const validEvents = decodedEvents.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )
  const latestStoredEventAt = latestCompactEventAt(validEvents)
  if (latestStoredEventAt !== storedValue.lastEventAt) {
    throw new Error('IndexedDB Working Set lastEventAt projection is inconsistent')
  }
  const compactRow: CompactActivityRow = [
    decodedKey,
    storedValue.title,
    storedValue.dismissedAt ?? null,
    storedValue.dismissedUntil ?? null,
    validEvents
  ]
  const record = materializeCompactActivityRows([compactRow]).records[decodedKey]
  if (record === undefined) {
    throw new Error('IndexedDB Working Set row could not be materialized')
  }
  return record
}

function storedEventCount(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const events = Reflect.get(value, 'events')
  return Array.isArray(events) ? events.length : 0
}

function latestEventAt(events: readonly WorkingSetActivityEvent[]): number {
  const latest = events.reduce<number | undefined>(
    (maximum, event) => maximum === undefined
      ? event.at
      : Math.max(maximum, event.at),
    undefined
  )
  if (latest === undefined) {
    throw new Error('IndexedDB Working Set rows require at least one event')
  }
  return latest
}

function latestCompactEventAt(
  events: IndexedDbActivityValue['events']
): number {
  const latest = events.reduce<number | undefined>(
    (maximum, event) => maximum === undefined
      ? event[1]
      : Math.max(maximum, event[1]),
    undefined
  )
  if (latest === undefined) {
    throw new Error('IndexedDB Working Set rows require at least one event')
  }
  return latest
}

function fallbackRecord(): WorkingSetActivityRecord {
  const key = 'https://example.test/valid-benchmark-row'
  const lastSeenAt = Date.now()
  return {
    key,
    url: key,
    title: 'Valid benchmark sibling',
    domain: URL.parse(key)?.hostname ?? '',
    lastSeenAt,
    events: [{ kind: 'activation', at: lastSeenAt }]
  }
}

async function closeAllConnections(): Promise<void> {
  await Promise.all([...closeConnections].map((close) => close()))
}

export const benchmarkBackend: WorkingSetBenchmarkBackend = {
  variant: 'idb',
  ownedStorage: {
    kind: 'indexed-db',
    database: DISPOSABLE_INDEXED_DB_NAME,
    objectStores: [INDEXED_DB_RECORDS_STORE]
  },
  lastMutationLogicalBytes: diagnostics.lastMutationLogicalBytes,
  lastMutationPhysicalWrites: diagnostics.lastMutationPhysicalWrites,
  writeInvocationCount: diagnostics.writeInvocationCount,
  lastReadDiagnostics: readDiagnostics.last,
  failNextMutation() {
    failNextWrite = true
  },
  async corrupt(kind) {
    await closeAllConnections()
    if (kind === 'missing-required-store') {
      await createSchemaMissingDatabase()
      return
    }

    await ensureDatabaseSchema()
    if (kind === 'row') {
      const db = await openNativeDatabase()
      try {
        const transaction = db.transaction(
          INDEXED_DB_RECORDS_STORE,
          'readwrite',
          { durability: 'relaxed' }
        )
        const done = nativeTransactionDone(transaction)
        const records = transaction.objectStore(INDEXED_DB_RECORDS_STORE)
        const [fallbackKey, fallbackValue] = encodeIndexedDbEntry(
          fallbackRecord()
        )
        records.put(fallbackValue, fallbackKey)
        records.put({
          title: 'Malformed benchmark row',
          events: ['malformed-benchmark-event'],
          lastEventAt: Date.now()
        }, 'https://example.test/malformed-benchmark-row')
        await done
      } finally {
        db.close()
      }
      return
    }

    await openNativeDatabaseVersion(DATABASE_VERSION + 1, () => {})
  },
  async reset() {
    await closeAllConnections()
    await deleteDB(DISPOSABLE_INDEXED_DB_NAME)
    failNextWrite = false
    diagnostics.reset()
    readDiagnostics.reset()
  },
  close: closeAllConnections
}

function createDatabaseSchema(
  db: IDBPDatabase<WorkingSetBenchmarkDatabase>
): void {
  const records = db.createObjectStore(INDEXED_DB_RECORDS_STORE)
  records.createIndex(INDEXED_DB_LAST_EVENT_INDEX, 'lastEventAt')
}

async function sweepExpiredRows(
  db: IDBPDatabase<WorkingSetBenchmarkDatabase>
): Promise<ExpirySweepDiagnostics> {
  const scanStartedAt = performance.now()
  const expiredKeys = await db.getAllKeysFromIndex(
    INDEXED_DB_RECORDS_STORE,
    INDEXED_DB_LAST_EVENT_INDEX,
    IDBKeyRange.upperBound(Date.now() - ACTIVITY_RETENTION_MS, true)
  )
  const scanMs = elapsedSince(scanStartedAt)
  if (expiredKeys.length === 0) return { scanMs, deleteMs: 0 }

  const deleteStartedAt = performance.now()
  try {
    const transaction = db.transaction(
      INDEXED_DB_RECORDS_STORE,
      'readwrite',
      { durability: 'relaxed' }
    )
    const deletes = expiredKeys.map((key) => transaction.store.delete(key))
    await Promise.all([...deletes, transaction.done])
  } catch {
    // Retained-row reads still establish known state when cleanup remains pending.
  }
  return {
    scanMs,
    deleteMs: elapsedSince(deleteStartedAt)
  }
}

async function ensureDatabaseSchema(): Promise<void> {
  const db = await openDB<WorkingSetBenchmarkDatabase>(
    DISPOSABLE_INDEXED_DB_NAME,
    DATABASE_VERSION,
    {
      upgrade(database, oldVersion) {
        if (oldVersion < DATABASE_VERSION) createDatabaseSchema(database)
      }
    }
  )
  db.close()
}

async function createSchemaMissingDatabase(): Promise<void> {
  await deleteDB(DISPOSABLE_INDEXED_DB_NAME)
  await openNativeDatabaseVersion(DATABASE_VERSION, () => {})
}

function openNativeDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DISPOSABLE_INDEXED_DB_NAME)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(
      'Disposable Working Set benchmark database open was blocked'
    ))
    request.onsuccess = () => resolve(request.result)
  })
}

function openNativeDatabaseVersion(
  version: number,
  upgrade: (db: IDBDatabase) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DISPOSABLE_INDEXED_DB_NAME, version)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(
      'Disposable Working Set benchmark database upgrade was blocked'
    ))
    request.onupgradeneeded = () => upgrade(request.result)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
  })
}

function nativeTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(
      transaction.error ?? new DOMException('Transaction aborted', 'AbortError')
    )
  })
}
