import { Schema } from 'effect'
import {
  deleteDB,
  openDB,
  type DBSchema,
  type IDBPDatabase,
} from 'idb'

import {
  pageIdentityForWorkingSet,
} from '../working-set.js'
import type {
  WorkingSetActivityEvent,
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
} from '../types'
import {
  workingSetActivityGenerationManifestSchema,
  type WorkingSetActivityGenerationManifest,
  type WorkingSetActivityIndexedDbAuthorityPort,
} from './working-set-activity-authority.js'
import type { WorkingSetActivityWrite } from './working-set-activity-storage.js'

export const WORKING_SET_ACTIVITY_INDEXED_DB_VERSION = 1
export const WORKING_SET_ACTIVITY_DATABASE_PREFIX =
  'tab-out:working-set-activity'
export const WORKING_SET_ACTIVITY_RECORDS_STORE = 'page-activity'
export const WORKING_SET_ACTIVITY_LAST_EVENT_INDEX = 'last-event-at'
export const WORKING_SET_ACTIVITY_MANIFEST_STORE = 'generation-manifest'
export const WORKING_SET_ACTIVITY_MANIFEST_KEY = 'active'

const ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const compactActivityEventSchema = Schema.Tuple([
  Schema.Literals([0, 1]),
  Schema.Finite,
])

const indexedDbActivityValueSchema = Schema.Struct({
  title: Schema.String,
  dismissedAt: Schema.optionalKey(Schema.Finite),
  dismissedUntil: Schema.optionalKey(Schema.Finite),
  events: Schema.Array(compactActivityEventSchema),
  lastEventAt: Schema.Finite,
})

const indexedDbStoredActivityValueSchema = Schema.Struct({
  title: Schema.String,
  dismissedAt: Schema.optionalKey(Schema.Finite),
  dismissedUntil: Schema.optionalKey(Schema.Finite),
  events: Schema.Array(Schema.Unknown),
  lastEventAt: Schema.Finite,
})

const generationSchema = Schema.String.check(
  Schema.isPattern(/^v1:[0-9a-f]{64}$/),
)

export { workingSetActivityGenerationManifestSchema }

export type IndexedDbActivityValue =
  typeof indexedDbActivityValueSchema.Type
type IndexedDbStoredActivityValue =
  typeof indexedDbStoredActivityValueSchema.Type

interface WorkingSetActivityDatabase extends DBSchema {
  readonly [WORKING_SET_ACTIVITY_RECORDS_STORE]: {
    readonly key: string
    readonly value: IndexedDbActivityValue
    readonly indexes: {
      readonly [WORKING_SET_ACTIVITY_LAST_EVENT_INDEX]: number
    }
  }
  readonly [WORKING_SET_ACTIVITY_MANIFEST_STORE]: {
    readonly key: typeof WORKING_SET_ACTIVITY_MANIFEST_KEY
    readonly value: WorkingSetActivityGenerationManifest
  }
}

type WorkingSetActivityDatabaseConnection =
  IDBPDatabase<WorkingSetActivityDatabase>

class InvalidWorkingSetActivityDatabaseStructureError extends Error {}

const isCompactActivityEvent = Schema.is(compactActivityEventSchema)
const isIndexedDbActivityValue = Schema.is(indexedDbActivityValueSchema)
const isIndexedDbStoredActivityValue = Schema.is(
  indexedDbStoredActivityValueSchema,
)
const isGenerationManifest = Schema.is(
  workingSetActivityGenerationManifestSchema,
)
const isGeneration = Schema.is(generationSchema)

export function databaseNameForGeneration(generation: string): string {
  if (!isGeneration(generation)) {
    throw new Error('Working Set activity generation is malformed')
  }
  return `${WORKING_SET_ACTIVITY_DATABASE_PREFIX}:${generation}`
}

export function makeWorkingSetActivityIndexedDb():
WorkingSetActivityIndexedDbAuthorityPort {
  type CachedConnection = {
    readonly databaseName: string
    readonly manifest: WorkingSetActivityGenerationManifest
    readonly promise: Promise<WorkingSetActivityDatabaseConnection>
    readonly token: object
  }

  let cachedConnection: CachedConnection | undefined

  const close = async (): Promise<void> => {
    const cached = cachedConnection
    cachedConnection = undefined
    if (cached === undefined) return
    try {
      const database = await cached.promise
      database.close()
    } catch {
      // A rejected open owns no connection to close.
    }
  }

  const database = async (
    manifest: WorkingSetActivityGenerationManifest,
  ): Promise<WorkingSetActivityDatabaseConnection> => {
    assertManifest(manifest)
    const databaseName = databaseNameForGeneration(manifest.generation)
    if (
      cachedConnection !== undefined &&
      cachedConnection.databaseName === databaseName &&
      manifestsEqual(cachedConnection.manifest, manifest)
    ) {
      return cachedConnection.promise
    }

    await close()
    const token = {}
    const pending = openExistingDatabase(
      manifest,
      () => {
        if (cachedConnection?.token === token) cachedConnection = undefined
      },
    ).then(async (opened) => {
      try {
        await sweepExpiredRows(opened)
        return opened
      } catch (cause) {
        opened.close()
        throw cause
      }
    })
    const next: CachedConnection = {
      databaseName,
      manifest: { ...manifest },
      promise: pending,
      token,
    }
    cachedConnection = next
    void pending.catch(() => {
      if (cachedConnection?.token === token) cachedConnection = undefined
    })
    return pending
  }

  const stage = async (
    manifest: WorkingSetActivityGenerationManifest,
    activity: WorkingSetActivityStore,
  ): Promise<void> => {
    assertManifest(manifest)
    await close()
    await deleteStaleCandidateDatabases(manifest.generation)
    const opened = await openStagingDatabase(manifest.generation)
    try {
      const transaction = opened.transaction([
        WORKING_SET_ACTIVITY_RECORDS_STORE,
        WORKING_SET_ACTIVITY_MANIFEST_STORE,
      ], 'readwrite', { durability: 'strict' })
      const records = transaction.objectStore(
        WORKING_SET_ACTIVITY_RECORDS_STORE,
      )
      const manifests = transaction.objectStore(
        WORKING_SET_ACTIVITY_MANIFEST_STORE,
      )
      const entries = Object.values(activity.records)
        .toSorted((left, right) => left.key.localeCompare(right.key))
        .map(encodeWorkingSetActivityIndexedDbEntry)
      const requests: Array<Promise<unknown>> = [
        records.clear(),
        manifests.clear(),
        ...entries.map(([key, value]) => records.put(value, key)),
        manifests.put({ ...manifest }, WORKING_SET_ACTIVITY_MANIFEST_KEY),
      ]
      await settleTransaction(requests, transaction.done)
    } finally {
      opened.close()
    }
  }

  const verify = async (
    manifest: WorkingSetActivityGenerationManifest,
  ): Promise<WorkingSetActivityStore> => {
    assertManifest(manifest)
    await close()
    const opened = await openExistingDatabase(manifest)
    try {
      const transaction = opened.transaction(
        WORKING_SET_ACTIVITY_RECORDS_STORE,
        'readonly',
      )
      const [keys, values] = await Promise.all([
        transaction.store.getAllKeys(),
        transaction.store.getAll(),
        transaction.done,
      ])
      if (keys.length !== values.length || keys.length !== manifest.recordCount) {
        throw new Error('Working Set activity generation record count is inconsistent')
      }
      const records: Record<string, WorkingSetActivityRecord> = {}
      let eventCount = 0
      for (const [index, key] of keys.entries()) {
        const record = decodeWorkingSetActivityIndexedDbEntryStrict(
          key,
          values[index],
        )
        if (record.events.some((event) => event.at < manifest.retainedAfter)) {
          throw new Error('Working Set activity generation exceeds retention')
        }
        records[record.key] = record
        eventCount += record.events.length
      }
      if (eventCount !== manifest.eventCount) {
        throw new Error('Working Set activity generation event count is inconsistent')
      }
      return { version: 1, records }
    } finally {
      opened.close()
    }
  }

  const read = async (
    manifest: WorkingSetActivityGenerationManifest,
  ): Promise<WorkingSetActivityStore> => {
    const opened = await database(manifest)
    const transaction = opened.transaction(
      WORKING_SET_ACTIVITY_RECORDS_STORE,
      'readonly',
    )
    const retained = transaction.store.index(
      WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
    )
    const retainedRange = IDBKeyRange.lowerBound(
      Date.now() - ACTIVITY_RETENTION_MS,
    )
    const [keys, values] = await Promise.all([
      retained.getAllKeys(retainedRange),
      retained.getAll(retainedRange),
      transaction.done,
    ])
    if (keys.length !== values.length) {
      throw new Error('Working Set activity index returned inconsistent rows')
    }
    const recordsByKey = new Map<string, WorkingSetActivityRecord>()
    for (const [index, key] of keys.entries()) {
      try {
        const record = decodeWorkingSetActivityIndexedDbEntryForRead(
          key,
          values[index],
        )
        recordsByKey.set(record.key, record)
      } catch {
        // A malformed row or event remains isolated from valid siblings.
      }
    }
    return {
      version: 1,
      records: Object.fromEntries(recordsByKey),
    }
  }

  const write = async (
    manifest: WorkingSetActivityGenerationManifest,
    change: WorkingSetActivityWrite,
  ): Promise<void> => {
    const upsertEntry = change.upsert === null
      ? null
      : encodeWorkingSetActivityIndexedDbEntry(change.upsert)
    const opened = await database(manifest)
    if (upsertEntry === null && change.deleteKeys.length === 0) return
    const transaction = opened.transaction(
      WORKING_SET_ACTIVITY_RECORDS_STORE,
      'readwrite',
      { durability: 'relaxed' },
    )
    const requests: Array<Promise<unknown>> = change.deleteKeys.map((key) =>
      transaction.store.delete(key),
    )
    if (upsertEntry !== null) {
      const [key, value] = upsertEntry
      requests.push(transaction.store.put(value, key))
    }
    await settleTransaction(requests, transaction.done)
  }

  const replace = async (
    manifest: WorkingSetActivityGenerationManifest,
    activity: WorkingSetActivityStore,
  ): Promise<void> => {
    const opened = await database(manifest)
    const transaction = opened.transaction(
      WORKING_SET_ACTIVITY_RECORDS_STORE,
      'readwrite',
      { durability: 'strict' },
    )
    const entries = Object.values(activity.records)
      .toSorted((left, right) => left.key.localeCompare(right.key))
      .map(encodeWorkingSetActivityIndexedDbEntry)
    const requests: Array<Promise<unknown>> = [transaction.store.clear()]
    requests.push(...entries.map(([key, value]) =>
      transaction.store.put(value, key),
    ))
    await settleTransaction(requests, transaction.done)
  }

  return { stage, verify, read, write, replace, close }
}

export function encodeWorkingSetActivityIndexedDbEntry(
  record: WorkingSetActivityRecord,
): readonly [string, IndexedDbActivityValue] {
  if (pageIdentityForWorkingSet(record.key) !== record.key) {
    throw new Error('Working Set activity row key is not a page identity')
  }
  return [record.key, {
    title: record.title,
    ...(record.dismissedAt === undefined
      ? {}
      : { dismissedAt: record.dismissedAt }),
    ...(record.dismissedUntil === undefined
      ? {}
      : { dismissedUntil: record.dismissedUntil }),
    events: record.events.map((event) => [
      event.kind === 'activation' ? 0 : 1,
      event.at,
    ]),
    lastEventAt: latestEventAt(record.events),
  }]
}

export function decodeWorkingSetActivityIndexedDbEntry(
  key: unknown,
  value: unknown,
): WorkingSetActivityRecord {
  return decodeIndexedDbEntry(key, value, true, true)
}

function decodeWorkingSetActivityIndexedDbEntryStrict(
  key: unknown,
  value: unknown,
): WorkingSetActivityRecord {
  return decodeIndexedDbEntry(key, value, true, false)
}

function decodeWorkingSetActivityIndexedDbEntryForRead(
  key: unknown,
  value: unknown,
): WorkingSetActivityRecord {
  return decodeIndexedDbEntry(key, value, false, true)
}

function decodeIndexedDbEntry(
  key: unknown,
  value: unknown,
  requireCanonicalKey: boolean,
  allowMalformedEvents: boolean,
): WorkingSetActivityRecord {
  if (
    typeof key !== 'string' ||
    (requireCanonicalKey && pageIdentityForWorkingSet(key) !== key)
  ) {
    throw new Error('IndexedDB Working Set key must be a page identity')
  }

  let stored: IndexedDbStoredActivityValue
  let compactEvents: readonly typeof compactActivityEventSchema.Type[]
  if (isIndexedDbActivityValue(value)) {
    stored = value
    compactEvents = value.events
  } else {
    if (!allowMalformedEvents || !isIndexedDbStoredActivityValue(value)) {
      throw new Error('IndexedDB Working Set row is malformed')
    }
    stored = value
    compactEvents = value.events.filter(isCompactActivityEvent)
  }
  if (compactEvents.length === 0) {
    throw new Error('IndexedDB Working Set rows require a valid event')
  }

  const events: WorkingSetActivityEvent[] = []
  let lastSeenAt: number | undefined
  let lastActivatedAt: number | undefined
  let lastNavigatedAt: number | undefined
  for (const [kindCode, at] of compactEvents) {
    const kind = kindCode === 0 ? 'activation' : 'navigation'
    events.push({ kind, at })
    lastSeenAt = lastSeenAt === undefined ? at : Math.max(lastSeenAt, at)
    if (kind === 'activation') {
      lastActivatedAt = lastActivatedAt === undefined
        ? at
        : Math.max(lastActivatedAt, at)
    } else {
      lastNavigatedAt = lastNavigatedAt === undefined
        ? at
        : Math.max(lastNavigatedAt, at)
    }
  }
  if (lastSeenAt === undefined || lastSeenAt !== stored.lastEventAt) {
    throw new Error('IndexedDB Working Set lastEventAt is inconsistent')
  }

  return {
    key,
    url: key,
    title: stored.title,
    domain: URL.parse(key)?.hostname ?? '',
    lastSeenAt,
    ...(lastActivatedAt === undefined ? {} : { lastActivatedAt }),
    ...(lastNavigatedAt === undefined ? {} : { lastNavigatedAt }),
    ...(stored.dismissedAt === undefined
      ? {}
      : { dismissedAt: stored.dismissedAt }),
    ...(stored.dismissedUntil === undefined
      ? {}
      : { dismissedUntil: stored.dismissedUntil }),
    events,
  }
}

function latestEventAt(events: readonly WorkingSetActivityEvent[]): number {
  const latest = events.reduce<number | undefined>(
    (maximum, event) => maximum === undefined
      ? event.at
      : Math.max(maximum, event.at),
    undefined,
  )
  if (latest === undefined) {
    throw new Error('IndexedDB Working Set rows require an event')
  }
  return latest
}

function assertManifest(
  manifest: WorkingSetActivityGenerationManifest,
): void {
  if (
    !isGenerationManifest(manifest) ||
    manifest.generation !== `v1:${manifest.sourceDigest}`
  ) {
    throw new Error('Working Set activity generation manifest is malformed')
  }
}

function manifestsEqual(
  left: WorkingSetActivityGenerationManifest,
  right: WorkingSetActivityGenerationManifest,
): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.generation === right.generation &&
    left.sourceDigest === right.sourceDigest &&
    left.recordCount === right.recordCount &&
    left.eventCount === right.eventCount &&
    left.retainedAfter === right.retainedAfter
}

async function openExistingDatabase(
  manifest: WorkingSetActivityGenerationManifest,
  onInvalidated: () => void = () => {},
): Promise<WorkingSetActivityDatabaseConnection> {
  const database = await openPhysicalDatabase(
    manifest.generation,
    false,
    onInvalidated,
  )
  try {
    await validateDatabase(database, manifest)
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

async function openStagingDatabase(
  generation: string,
): Promise<WorkingSetActivityDatabaseConnection> {
  const opened = await openPhysicalDatabase(generation, true)
  try {
    await assertDatabaseStructure(opened)
    return opened
  } catch (cause) {
    opened.close()
    if (!(cause instanceof InvalidWorkingSetActivityDatabaseStructureError)) {
      throw cause
    }
  }

  // The marker is still absent while stage runs, so this exact generation is
  // only a candidate. Replacing a same-version malformed candidate is safe;
  // a future database version fails during open and never reaches this path.
  await deleteDB(databaseNameForGeneration(generation))
  const repaired = await openPhysicalDatabase(generation, true)
  try {
    await assertDatabaseStructure(repaired)
    return repaired
  } catch (cause) {
    repaired.close()
    throw cause
  }
}

async function openPhysicalDatabase(
  generation: string,
  allowCreate: boolean,
  onInvalidated: () => void = () => {},
): Promise<WorkingSetActivityDatabaseConnection> {
  const name = databaseNameForGeneration(generation)
  let opened: WorkingSetActivityDatabaseConnection | undefined
  let blocked = false
  const { promise: blockedPromise, reject: rejectBlocked } =
    Promise.withResolvers<never>()
  const opening = openDB<WorkingSetActivityDatabase>(
    name,
    WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
    {
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion !== 0) return
        if (!allowCreate) {
          transaction.abort()
          return
        }
        createDatabaseSchema(database)
      },
      blocked() {
        blocked = true
        rejectBlocked(new Error(
          `Opening Working Set activity database ${name} was blocked`,
        ))
      },
      blocking() {
        opened?.close()
        onInvalidated()
      },
      terminated() {
        onInvalidated()
      },
    },
  )
  void opening.then((database) => {
    opened = database
    if (blocked) database.close()
  }, () => {})
  return Promise.race([opening, blockedPromise])
}

function createDatabaseSchema(
  database: WorkingSetActivityDatabaseConnection,
): void {
  const records = database.createObjectStore(
    WORKING_SET_ACTIVITY_RECORDS_STORE,
  )
  records.createIndex(
    WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
    'lastEventAt',
  )
  database.createObjectStore(WORKING_SET_ACTIVITY_MANIFEST_STORE)
}

async function deleteStaleCandidateDatabases(
  targetGeneration: string,
): Promise<void> {
  const targetName = databaseNameForGeneration(targetGeneration)
  const databaseNamePrefix = `${WORKING_SET_ACTIVITY_DATABASE_PREFIX}:`
  const staleNames = (await indexedDB.databases()).flatMap(({ name, version }) => {
    if (
      typeof name !== 'string' ||
      version !== WORKING_SET_ACTIVITY_INDEXED_DB_VERSION ||
      name === targetName ||
      !name.startsWith(databaseNamePrefix) ||
      !isGeneration(name.slice(databaseNamePrefix.length))
    ) return []
    return [name]
  })
  await Promise.all(staleNames.map(deleteCandidateDatabase))
}

async function deleteCandidateDatabase(name: string): Promise<void> {
  const { promise: blocked, reject: rejectBlocked } =
    Promise.withResolvers<never>()
  const deleting = deleteDB(name, {
    blocked() {
      rejectBlocked(new Error(
        `Deleting stale Working Set activity database ${name} was blocked`,
      ))
    },
  })
  await Promise.race([deleting, blocked])
}

async function assertDatabaseStructure(
  database: WorkingSetActivityDatabaseConnection,
): Promise<void> {
  if (
    !database.objectStoreNames.contains(WORKING_SET_ACTIVITY_RECORDS_STORE) ||
    !database.objectStoreNames.contains(WORKING_SET_ACTIVITY_MANIFEST_STORE)
  ) {
    throw new InvalidWorkingSetActivityDatabaseStructureError(
      'Working Set activity database is missing a required store',
    )
  }
  const transaction = database.transaction([
    WORKING_SET_ACTIVITY_RECORDS_STORE,
    WORKING_SET_ACTIVITY_MANIFEST_STORE,
  ], 'readonly')
  const records = transaction.objectStore(WORKING_SET_ACTIVITY_RECORDS_STORE)
  const manifests = transaction.objectStore(
    WORKING_SET_ACTIVITY_MANIFEST_STORE,
  )
  if (!hasExpectedDatabaseLayout(records, manifests)) {
    transaction.abort()
    await transaction.done.catch(() => undefined)
    throw new InvalidWorkingSetActivityDatabaseStructureError(
      'Working Set activity database has an incompatible physical layout',
    )
  }
  await transaction.done
}

async function validateDatabase(
  database: WorkingSetActivityDatabaseConnection,
  manifest: WorkingSetActivityGenerationManifest,
): Promise<void> {
  if (
    !database.objectStoreNames.contains(WORKING_SET_ACTIVITY_RECORDS_STORE) ||
    !database.objectStoreNames.contains(WORKING_SET_ACTIVITY_MANIFEST_STORE)
  ) {
    throw new InvalidWorkingSetActivityDatabaseStructureError(
      'Working Set activity database is missing a required store',
    )
  }
  const transaction = database.transaction(
    [
      WORKING_SET_ACTIVITY_RECORDS_STORE,
      WORKING_SET_ACTIVITY_MANIFEST_STORE,
    ],
    'readonly',
  )
  const records = transaction.objectStore(WORKING_SET_ACTIVITY_RECORDS_STORE)
  const manifests = transaction.objectStore(
    WORKING_SET_ACTIVITY_MANIFEST_STORE,
  )
  if (!hasExpectedDatabaseLayout(records, manifests)) {
    transaction.abort()
    await transaction.done.catch(() => undefined)
    throw new InvalidWorkingSetActivityDatabaseStructureError(
      'Working Set activity database has an incompatible physical layout',
    )
  }
  const [storedManifest] = await Promise.all([
    manifests.get(WORKING_SET_ACTIVITY_MANIFEST_KEY),
    transaction.done,
  ])
  if (
    storedManifest === undefined ||
    !isGenerationManifest(storedManifest) ||
    !manifestsEqual(storedManifest, manifest)
  ) {
    throw new Error('Working Set activity generation manifest does not match')
  }
}

function hasExpectedDatabaseLayout(
  records: {
    readonly autoIncrement: boolean
    readonly indexNames: DOMStringList
    readonly keyPath: string | string[] | null
    readonly index: (
      name: typeof WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
    ) => {
      readonly keyPath: string | string[]
      readonly multiEntry: boolean
      readonly unique: boolean
    }
  },
  manifests: {
    readonly autoIncrement: boolean
    readonly indexNames: DOMStringList
    readonly keyPath: string | string[] | null
  },
): boolean {
  if (
    records.keyPath !== null ||
    records.autoIncrement ||
    records.indexNames.length !== 1 ||
    !records.indexNames.contains(WORKING_SET_ACTIVITY_LAST_EVENT_INDEX) ||
    manifests.keyPath !== null ||
    manifests.autoIncrement ||
    manifests.indexNames.length !== 0
  ) {
    return false
  }
  const expiry = records.index(WORKING_SET_ACTIVITY_LAST_EVENT_INDEX)
  return expiry.keyPath === 'lastEventAt' &&
    !expiry.unique &&
    !expiry.multiEntry
}

async function sweepExpiredRows(
  database: WorkingSetActivityDatabaseConnection,
): Promise<void> {
  const scan = database.transaction(
    WORKING_SET_ACTIVITY_RECORDS_STORE,
    'readonly',
  )
  const expiredRange = IDBKeyRange.upperBound(
    Date.now() - ACTIVITY_RETENTION_MS,
    true,
  )
  const [expiredKeys] = await Promise.all([
    scan.store.index(WORKING_SET_ACTIVITY_LAST_EVENT_INDEX)
      .getAllKeys(expiredRange),
    scan.done,
  ])
  if (expiredKeys.length === 0) return

  try {
    const transaction = database.transaction(
      WORKING_SET_ACTIVITY_RECORDS_STORE,
      'readwrite',
      { durability: 'relaxed' },
    )
    await settleTransaction(
      expiredKeys.map((key) => transaction.store.delete(key)),
      transaction.done,
    )
  } catch {
    // Expiry is also enforced by the retained index range on semantic reads.
  }
}

async function settleTransaction(
  requests: readonly Promise<unknown>[],
  done: Promise<unknown>,
): Promise<void> {
  const results = await Promise.allSettled([...requests, done])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
