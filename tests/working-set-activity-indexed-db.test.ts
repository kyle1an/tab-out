import assert from 'node:assert/strict'
import test from 'node:test'

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import {
  databaseNameForGeneration,
  decodeWorkingSetActivityIndexedDbEntry,
  encodeWorkingSetActivityIndexedDbEntry,
  makeWorkingSetActivityIndexedDb,
  WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
  WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
  WORKING_SET_ACTIVITY_MANIFEST_STORE,
  WORKING_SET_ACTIVITY_RECORDS_STORE
} from '../src/extension/background/working-set-activity-indexed-db.js'
import type {
  WorkingSetActivityRecord,
  WorkingSetActivityStore
} from '../src/extension/types'

const NOW = Date.UTC(2026, 7, 9, 12)

test.beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

function record(
  key: string,
  events: WorkingSetActivityRecord['events']
): WorkingSetActivityRecord {
  const lastSeenAt = Math.max(...events.map((event) => event.at))
  const activations = events.filter((event) => event.kind === 'activation')
  const navigations = events.filter((event) => event.kind === 'navigation')
  return {
    key,
    url: key,
    title: 'Example Page',
    domain: URL.parse(key)?.hostname || '',
    lastSeenAt,
    ...(activations.length === 0
      ? {}
      : { lastActivatedAt: Math.max(...activations.map((event) => event.at)) }),
    ...(navigations.length === 0
      ? {}
      : { lastNavigatedAt: Math.max(...navigations.map((event) => event.at)) }),
    events
  }
}

test('IndexedDB Working Set rows round-trip compact semantic records', () => {
  const expected: WorkingSetActivityRecord = {
    ...record('https://example.test/docs', [
      { kind: 'activation', at: NOW - 1_000 },
      { kind: 'navigation', at: NOW }
    ]),
    dismissedAt: NOW + 1_000,
    dismissedUntil: NOW + 60_000
  }

  const [key, value] = encodeWorkingSetActivityIndexedDbEntry(expected)

  assert.equal(key, expected.key)
  assert.deepEqual(value, {
    title: expected.title,
    dismissedAt: expected.dismissedAt,
    dismissedUntil: expected.dismissedUntil,
    events: [[0, NOW - 1_000], [1, NOW]],
    lastEventAt: NOW
  })
  assert.deepEqual(
    decodeWorkingSetActivityIndexedDbEntry(key, value),
    expected
  )
})

test('IndexedDB Working Set decoding isolates malformed events but rejects an inconsistent projection', () => {
  const expected = record('https://example.test/guide', [
    { kind: 'activation', at: NOW - 1_000 },
    { kind: 'navigation', at: NOW }
  ])
  const [key, value] = encodeWorkingSetActivityIndexedDbEntry(expected)

  assert.deepEqual(decodeWorkingSetActivityIndexedDbEntry(key, {
    ...value,
    events: [value.events[0], ['malformed'], value.events[1]]
  }), expected)
  assert.throws(() => decodeWorkingSetActivityIndexedDbEntry(key, {
    ...value,
    lastEventAt: NOW + 1
  }))
  assert.throws(() => decodeWorkingSetActivityIndexedDbEntry(key, {
    ...value,
    events: [['malformed']]
  }))
})

test('Working Set generation database names are deterministic and reject malformed generations', () => {
  const digest = 'a'.repeat(64)
  const generation = `v${WORKING_SET_ACTIVITY_INDEXED_DB_VERSION}:${digest}`

  assert.equal(
    databaseNameForGeneration(generation),
    `tab-out:working-set-activity:${generation}`
  )
  assert.throws(() => databaseNameForGeneration('v1:not-a-digest'))
})

test('IndexedDB Working Set codec rejects non-canonical keys and empty records', () => {
  assert.throws(() => decodeWorkingSetActivityIndexedDbEntry(
    'https://example.test/docs#fragment',
    {
      title: 'Docs',
      events: [[0, NOW]],
      lastEventAt: NOW
    }
  ))
  assert.throws(() => encodeWorkingSetActivityIndexedDbEntry({
    ...record('https://example.test/docs', [
      { kind: 'activation', at: NOW }
    ]),
    key: 'https://example.test/docs#fragment'
  }))
  assert.throws(() => encodeWorkingSetActivityIndexedDbEntry({
    key: 'https://example.test/empty',
    url: 'https://example.test/empty',
    title: 'Empty',
    domain: 'example.test',
    lastSeenAt: 0,
    events: []
  }))
})

test('a failed upsert cannot commit deletes from the same mutation', async () => {
  const at = Date.now()
  const original = record('https://example.test/original', [
    { kind: 'activation', at }
  ])
  const activity: WorkingSetActivityStore = {
    version: 1,
    records: { [original.key]: original }
  }
  const digest = 'b'.repeat(64)
  const manifest = {
    schemaVersion: 1 as const,
    generation: `v1:${digest}`,
    sourceDigest: digest,
    recordCount: 1,
    eventCount: 1,
    retainedAfter: at - 30 * 24 * 60 * 60 * 1000
  }
  const indexedDb = makeWorkingSetActivityIndexedDb()

  await indexedDb.stage(manifest, activity)
  await assert.rejects(async () => {
    await indexedDb.write(manifest, {
      activity,
      deleteKeys: [original.key],
      upsert: {
        ...original,
        key: `${original.key}#fragment`
      }
    })
  })
  assert.deepEqual(await indexedDb.read(manifest), activity)
  await indexedDb.close?.()
})

test('staging repairs an unmarked same-version database with the wrong physical layout', async () => {
  const digest = 'c'.repeat(64)
  const generation = `v1:${digest}`
  const name = databaseNameForGeneration(generation)
  await createMalformedDatabase(name)

  const at = Date.now()
  const expected = record('https://example.test/repaired', [
    { kind: 'navigation', at }
  ])
  const activity: WorkingSetActivityStore = {
    version: 1,
    records: { [expected.key]: expected }
  }
  const manifest = {
    schemaVersion: 1 as const,
    generation,
    sourceDigest: digest,
    recordCount: 1,
    eventCount: 1,
    retainedAfter: at - 30 * 24 * 60 * 60 * 1000
  }
  const indexedDb = makeWorkingSetActivityIndexedDb()

  await indexedDb.stage(manifest, activity)
  assert.deepEqual(await indexedDb.verify(manifest), activity)
  await indexedDb.close?.()
})

test('an authoritative database with the wrong physical layout fails closed without repair', async () => {
  const digest = 'd'.repeat(64)
  const generation = `v1:${digest}`
  const name = databaseNameForGeneration(generation)
  await createMalformedDatabase(name)
  const indexedDb = makeWorkingSetActivityIndexedDb()

  await assert.rejects(async () => {
    await indexedDb.read({
      schemaVersion: 1,
      generation,
      sourceDigest: digest,
      recordCount: 1,
      eventCount: 1,
      retainedAfter: Date.now() - 30 * 24 * 60 * 60 * 1000
    })
  }, /incompatible physical layout/)
  assert.equal(await readRecordsKeyPath(name), 'wrongKey')
  await indexedDb.close?.()
})

test('staging removes stale v1 candidates but preserves unknown generations', async () => {
  const at = Date.now()
  const expected = record('https://example.test/orphan-cleanup', [
    { kind: 'activation', at }
  ])
  const activity: WorkingSetActivityStore = {
    version: 1,
    records: { [expected.key]: expected }
  }
  const firstDigest = 'e'.repeat(64)
  const secondDigest = 'f'.repeat(64)
  const firstGeneration = `v1:${firstDigest}`
  const secondGeneration = `v1:${secondDigest}`
  const unknownDatabase = 'tab-out:working-set-activity:v2:unknown'
  const futureDatabase = databaseNameForGeneration(`v1:${'9'.repeat(64)}`)
  await createEmptyDatabase(unknownDatabase)
  await createEmptyDatabase(
    futureDatabase,
    WORKING_SET_ACTIVITY_INDEXED_DB_VERSION + 1
  )
  const indexedDb = makeWorkingSetActivityIndexedDb()

  await indexedDb.stage({
    schemaVersion: 1,
    generation: firstGeneration,
    sourceDigest: firstDigest,
    recordCount: 1,
    eventCount: 1,
    retainedAfter: at - 30 * 24 * 60 * 60 * 1000
  }, activity)
  await indexedDb.stage({
    schemaVersion: 1,
    generation: secondGeneration,
    sourceDigest: secondDigest,
    recordCount: 1,
    eventCount: 1,
    retainedAfter: at - 30 * 24 * 60 * 60 * 1000
  }, activity)

  const names = (await indexedDB.databases()).map(({ name }) => name)
  assert.ok(!names.includes(databaseNameForGeneration(firstGeneration)))
  assert.ok(names.includes(databaseNameForGeneration(secondGeneration)))
  assert.ok(names.includes(unknownDatabase))
  assert.ok(names.includes(futureDatabase))
  await indexedDb.close?.()
})

async function createMalformedDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, WORKING_SET_ACTIVITY_INDEXED_DB_VERSION)
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore(
        WORKING_SET_ACTIVITY_RECORDS_STORE,
        { keyPath: 'wrongKey', autoIncrement: true }
      )
      records.createIndex(
        WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
        'wrongLastEventAt',
        { unique: true, multiEntry: true }
      )
      request.result.createObjectStore(
        WORKING_SET_ACTIVITY_MANIFEST_STORE,
        { keyPath: 'wrongManifestKey' }
      )
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
  })
}

async function createEmptyDatabase(name: string, version = 1): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
  })
}

async function readRecordsKeyPath(name: string): Promise<IDBObjectStore['keyPath']> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, WORKING_SET_ACTIVITY_INDEXED_DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(
        WORKING_SET_ACTIVITY_RECORDS_STORE,
        'readonly'
      )
      const keyPath = transaction.objectStore(
        WORKING_SET_ACTIVITY_RECORDS_STORE
      ).keyPath
      transaction.oncomplete = () => {
        database.close()
        resolve(keyPath)
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}
