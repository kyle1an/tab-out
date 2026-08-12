import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'

import type { Page } from '@playwright/test'
import { Schema } from 'effect'

import {
  WORKING_SET_ACTIVITY_AUTHORITY_KEY,
  WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
  workingSetActivityAuthorityMarkerSchema,
} from '../../src/extension/background/working-set-activity-authority.js'
import {
  databaseNameForGeneration,
  decodeWorkingSetActivityIndexedDbEntry,
  indexedDbActivityValueSchema,
  WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
  WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
  WORKING_SET_ACTIVITY_MANIFEST_KEY,
  WORKING_SET_ACTIVITY_MANIFEST_STORE,
  WORKING_SET_ACTIVITY_RECORDS_STORE,
  workingSetActivityGenerationManifestSchema,
} from '../../src/extension/background/working-set-activity-indexed-db.js'
import {
  WORKING_SET_ACTIVITY_KEY,
} from '../../src/extension/background/working-set-activity-storage.js'
import type {
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
} from '../../src/extension/types'
import {
  emptyWorkingSetActivity,
  pageIdentityForWorkingSet,
  recordWorkingSetActivity,
} from '../../src/extension/working-set.js'
import {
  expect,
  test,
} from './installed-extension.js'
import { terminateServiceWorkerAndProveAbsent } from './service-worker-cdp.js'

interface ChromeAuthoritySnapshot {
  readonly legacy: unknown
  readonly legacyJson: string | null
  readonly marker: unknown
}

interface IndexedDbPhysicalSnapshot {
  readonly catalog: readonly {
    readonly name: string
    readonly version: number
  }[]
  readonly entries: readonly {
    readonly key: string
    readonly value: unknown
  }[]
  readonly lastEventIndexKeys: readonly string[]
  readonly manifest: unknown
  readonly manifestKeys: readonly string[]
  readonly structure: {
    readonly databaseVersion: number
    readonly manifestAutoIncrement: boolean
    readonly manifestIndexNames: readonly string[]
    readonly manifestKeyPath: string | readonly string[] | null
    readonly objectStoreNames: readonly string[]
    readonly recordsAutoIncrement: boolean
    readonly recordsIndexNames: readonly string[]
    readonly recordsKeyPath: string | readonly string[] | null
    readonly lastEventIndex: {
      readonly keyPath: string | readonly string[]
      readonly multiEntry: boolean
      readonly unique: boolean
    }
  }
}

interface LoopbackServer {
  readonly origin: string
  readonly close: () => Promise<void>
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function makeLegacyActivity(now: number): WorkingSetActivityStore {
  const guideUrl = 'https://example.test/guide'
  const workspaceUrl = 'https://example.test/workspace'
  const firstEventAt = now - 60_000
  let activity = recordWorkingSetActivity(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: firstEventAt,
    tab: { rawUrl: guideUrl, title: 'Example Guide', url: guideUrl },
  })
  activity = recordWorkingSetActivity(activity, {
    kind: 'navigation',
    at: firstEventAt + 1_000,
    tab: { rawUrl: guideUrl, title: 'Example Guide', url: guideUrl },
  })
  activity = recordWorkingSetActivity(activity, {
    kind: 'activation',
    at: firstEventAt + 2_000,
    tab: {
      rawUrl: workspaceUrl,
      title: 'Example Workspace',
      url: workspaceUrl,
    },
  })

  const workspaceKey = pageIdentityForWorkingSet(workspaceUrl)
  const workspace = activity.records[workspaceKey]
  invariant(workspace !== undefined, 'Legacy fixture omitted its workspace row')
  return {
    ...activity,
    records: {
      ...activity.records,
      [workspaceKey]: {
        ...workspace,
        dismissedAt: now - 30_000,
        dismissedUntil: now + 60 * 60_000,
      },
    },
  }
}

function expectedIndexedDbValue(record: WorkingSetActivityRecord): unknown {
  return {
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
    lastEventAt: Math.max(...record.events.map((event) => event.at)),
  }
}

function sortedActivityRecords(
  activity: WorkingSetActivityStore,
): readonly WorkingSetActivityRecord[] {
  return Object.values(activity.records)
    .toSorted((left, right) => left.key.localeCompare(right.key))
}

async function expectedSourceDigest(
  activity: WorkingSetActivityStore,
): Promise<string> {
  const canonicalRows = sortedActivityRecords(activity).map((record) => [
    record.key,
    record.title,
    record.dismissedAt ?? null,
    record.dismissedUntil ?? null,
    record.events.map((event) => [
      event.kind === 'activation' ? 0 : 1,
      event.at,
    ]),
  ])
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([
      WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
      canonicalRows,
    ])),
  )
  return new Uint8Array(digest).toHex()
}

function expectedIndexedDbEntries(
  activity: WorkingSetActivityStore,
): IndexedDbPhysicalSnapshot['entries'] {
  return sortedActivityRecords(activity).map((record) => ({
    key: record.key,
    value: expectedIndexedDbValue(record),
  }))
}

async function readChromeAuthoritySnapshot(
  page: Page,
): Promise<ChromeAuthoritySnapshot> {
  return page.evaluate(async ({ authorityKey, legacyKey }) => {
    const values = await chrome.storage.local.get([authorityKey, legacyKey])
    const legacy = values[legacyKey]
    return {
      legacy,
      legacyJson: JSON.stringify(legacy) ?? null,
      marker: values[authorityKey],
    }
  }, {
    authorityKey: WORKING_SET_ACTIVITY_AUTHORITY_KEY,
    legacyKey: WORKING_SET_ACTIVITY_KEY,
  })
}

async function readIndexedDbPhysicalSnapshot(
  page: Page,
  databaseName: string,
): Promise<IndexedDbPhysicalSnapshot> {
  return page.evaluate(async ({
    databaseName,
    lastEventIndexName,
    manifestKey,
    manifestStoreName,
    recordsStoreName,
  }) => {
    function requestResult<Value>(request: IDBRequest<Value>): Promise<Value> {
      return new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      })
    }

    const catalog = (await indexedDB.databases()).flatMap((database) =>
      typeof database.name === 'string' && typeof database.version === 'number'
        ? [{ name: database.name, version: database.version }]
        : [])
      .toSorted((left, right) => left.name.localeCompare(right.name))
    if (!catalog.some((database) => database.name === databaseName)) {
      throw new Error(`IndexedDB generation ${databaseName} does not exist`)
    }

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(
        `IndexedDB generation ${databaseName} was blocked`,
      ))
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        reject(new Error(
          `IndexedDB generation ${databaseName} unexpectedly required creation`,
        ))
      }
      request.onsuccess = () => resolve(request.result)
    })

    try {
      const transaction = database.transaction(
        [recordsStoreName, manifestStoreName],
        'readonly',
      )
      const transactionDone = new Promise<void>((resolve, reject) => {
        transaction.onabort = () => reject(
          transaction.error ?? new DOMException('Transaction aborted', 'AbortError'),
        )
        transaction.onerror = () => reject(transaction.error)
        transaction.oncomplete = () => resolve()
      })
      const records = transaction.objectStore(recordsStoreName)
      const manifestStore = transaction.objectStore(manifestStoreName)
      const lastEventIndex = records.index(lastEventIndexName)
      const [recordKeys, recordValues, lastEventIndexKeys, manifestKeys, manifest] =
        await Promise.all([
          requestResult(records.getAllKeys()),
          requestResult(records.getAll()),
          requestResult(lastEventIndex.getAllKeys()),
          requestResult(manifestStore.getAllKeys()),
          requestResult(manifestStore.get(manifestKey)),
          transactionDone,
        ])
      if (
        !recordKeys.every((key): key is string => typeof key === 'string') ||
        !lastEventIndexKeys.every((key): key is string => typeof key === 'string') ||
        !manifestKeys.every((key): key is string => typeof key === 'string')
      ) {
        throw new Error('Working Set IndexedDB used a non-string out-of-line key')
      }
      if (recordKeys.length !== recordValues.length) {
        throw new Error('Working Set IndexedDB key/value cardinality diverged')
      }
      return {
        catalog,
        entries: recordKeys.map((key, index) => ({
          key,
          value: recordValues[index],
        })),
        lastEventIndexKeys,
        manifest,
        manifestKeys,
        structure: {
          databaseVersion: database.version,
          manifestAutoIncrement: manifestStore.autoIncrement,
          manifestIndexNames: Array.from(manifestStore.indexNames),
          manifestKeyPath: manifestStore.keyPath,
          objectStoreNames: Array.from(database.objectStoreNames),
          recordsAutoIncrement: records.autoIncrement,
          recordsIndexNames: Array.from(records.indexNames),
          recordsKeyPath: records.keyPath,
          lastEventIndex: {
            keyPath: lastEventIndex.keyPath,
            multiEntry: lastEventIndex.multiEntry,
            unique: lastEventIndex.unique,
          },
        },
      }
    } finally {
      database.close()
    }
  }, {
    databaseName,
    lastEventIndexName: WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
    manifestKey: WORKING_SET_ACTIVITY_MANIFEST_KEY,
    manifestStoreName: WORKING_SET_ACTIVITY_MANIFEST_STORE,
    recordsStoreName: WORKING_SET_ACTIVITY_RECORDS_STORE,
  })
}

function assertIndexedDbStructure(snapshot: IndexedDbPhysicalSnapshot): void {
  expect(snapshot.structure).toEqual({
    databaseVersion: WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
    manifestAutoIncrement: false,
    manifestIndexNames: [],
    manifestKeyPath: null,
    objectStoreNames: [
      WORKING_SET_ACTIVITY_MANIFEST_STORE,
      WORKING_SET_ACTIVITY_RECORDS_STORE,
    ].toSorted(),
    recordsAutoIncrement: false,
    recordsIndexNames: [WORKING_SET_ACTIVITY_LAST_EVENT_INDEX],
    recordsKeyPath: null,
    lastEventIndex: {
      keyPath: 'lastEventAt',
      multiEntry: false,
      unique: false,
    },
  })
  expect(snapshot.manifestKeys).toEqual([WORKING_SET_ACTIVITY_MANIFEST_KEY])
}

async function decodePhysicalRows(
  snapshot: IndexedDbPhysicalSnapshot,
): Promise<readonly WorkingSetActivityRecord[]> {
  return Promise.all(snapshot.entries.map(({ key, value }) =>
    decodeWorkingSetActivityIndexedDbEntry(key, value)))
}

async function expectStartupFrame(page: Page, dashboardUrl: string): Promise<void> {
  if (page.url() === dashboardUrl) {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' })
  }
  await expect(page).toHaveURL(dashboardUrl)
  await expect(page.locator('[data-tabout="dashboard-shell"]')).toBeVisible()
  const header = page.locator('[data-tabout="header-stats"]')
  await expect(header).toBeAttached()
  await expect(header).not.toHaveAttribute('aria-hidden', 'true')
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, 'localhost', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((cause) => cause === undefined ? resolve() : reject(cause))
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
  })
}

async function startLoopbackServer(): Promise<LoopbackServer> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
    })
    response.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<title>Example Activity Page</title></head>' +
      '<body><main>Example activity page</main></body></html>',
    )
  })
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await listen(server)
  const address = server.address()
  invariant(
    address !== null && typeof address === 'object',
    'Loopback server has no address',
  )
  return {
    origin: `http://localhost:${String(address.port)}`,
    close: () => closeServer(server, sockets),
  }
}

test('migrates retained legacy activity to IndexedDB and recovers it after worker restart', async ({
  installedExtension,
}) => {
  test.setTimeout(90_000)
  const workerUrl = installedExtension.serviceWorker.url()
  const controller = installedExtension.context.pages()[0]
  invariant(controller !== undefined, 'Installed extension opened no controller page')
  const legacy = makeLegacyActivity(Date.now())
  const sourceDigest = await expectedSourceDigest(legacy)

  const seededChrome = await installedExtension.serviceWorker.evaluate(async ({
    authorityKey,
    legacyKey,
    legacyValue,
  }) => {
    await chrome.storage.local.set({ [legacyKey]: legacyValue })
    await chrome.storage.local.remove(authorityKey)
    const values = await chrome.storage.local.get([authorityKey, legacyKey])
    const storedLegacy = values[legacyKey]
    return {
      legacy: storedLegacy,
      legacyJson: JSON.stringify(storedLegacy) ?? null,
      marker: values[authorityKey],
    }
  }, {
    authorityKey: WORKING_SET_ACTIVITY_AUTHORITY_KEY,
    legacyKey: WORKING_SET_ACTIVITY_KEY,
    legacyValue: legacy,
  })
  expect(seededChrome.marker).toBeUndefined()
  expect(seededChrome.legacy).toEqual(legacy)
  invariant(
    seededChrome.legacyJson !== null,
    'Seeded legacy Working Set activity was not serializable',
  )
  const legacyJson = seededChrome.legacyJson
  await terminateServiceWorkerAndProveAbsent(
    installedExtension.context,
    controller,
    workerUrl,
  )

  const dashboardUrl =
    `chrome-extension://${installedExtension.extensionId}/index.html`
  await expectStartupFrame(controller, dashboardUrl)

  await expect.poll(async () =>
    (await readChromeAuthoritySnapshot(controller)).marker === undefined,
  ).toBe(false)
  const migratedChrome = await readChromeAuthoritySnapshot(controller)
  const marker = Schema.decodeUnknownSync(
    workingSetActivityAuthorityMarkerSchema,
  )(migratedChrome.marker)
  expect(migratedChrome.marker).toEqual(marker)
  expect(marker.sourceDigest).toBe(sourceDigest)
  expect(marker.generation).toBe(`v1:${sourceDigest}`)
  expect(marker.recordCount).toBe(Object.keys(legacy.records).length)
  expect(marker.eventCount).toBe(
    sortedActivityRecords(legacy).reduce(
      (count, record) => count + record.events.length,
      0,
    ),
  )
  expect(marker.retainedAfter).toBe(
    marker.cutoverAt - 30 * 24 * 60 * 60_000,
  )
  expect(marker.retainedAfter).toBeLessThan(
    Math.min(...sortedActivityRecords(legacy).map((record) => record.lastSeenAt)),
  )
  expect(migratedChrome.legacy).toEqual(legacy)
  expect(migratedChrome.legacyJson).toBe(legacyJson)

  const databaseName = databaseNameForGeneration(marker.generation)
  const migratedIdb = await readIndexedDbPhysicalSnapshot(
    controller,
    databaseName,
  )
  expect(WORKING_SET_ACTIVITY_INDEXED_DB_VERSION).toBe(
    WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
  )
  assertIndexedDbStructure(migratedIdb)
  expect(migratedIdb.catalog).toContainEqual({
    name: databaseName,
    version: WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
  })
  expect(migratedIdb.entries).toEqual(expectedIndexedDbEntries(legacy))
  expect([...migratedIdb.lastEventIndexKeys].toSorted()).toEqual(
    Object.keys(legacy.records).toSorted(),
  )
  for (const { value } of migratedIdb.entries) {
    expect(Schema.is(indexedDbActivityValueSchema)(value)).toBe(true)
  }
  const manifest = Schema.decodeUnknownSync(
    workingSetActivityGenerationManifestSchema,
  )(migratedIdb.manifest)
  const expectedManifest = {
    schemaVersion: marker.schemaVersion,
    generation: marker.generation,
    sourceDigest: marker.sourceDigest,
    recordCount: marker.recordCount,
    eventCount: marker.eventCount,
    retainedAfter: marker.retainedAfter,
  }
  expect(migratedIdb.manifest).toEqual(expectedManifest)
  expect(manifest).toEqual(expectedManifest)
  expect(await decodePhysicalRows(migratedIdb)).toEqual(
    sortedActivityRecords(legacy),
  )

  await terminateServiceWorkerAndProveAbsent(
    installedExtension.context,
    controller,
    workerUrl,
  )
  await expectStartupFrame(controller, dashboardUrl)
  const recoveredChrome = await readChromeAuthoritySnapshot(controller)
  expect(recoveredChrome).toEqual(migratedChrome)
  const recoveredIdb = await readIndexedDbPhysicalSnapshot(
    controller,
    databaseName,
  )
  expect(recoveredIdb).toEqual(migratedIdb)
  expect(await decodePhysicalRows(recoveredIdb)).toEqual(
    sortedActivityRecords(legacy),
  )

  const loopback = await startLoopbackServer()
  let activityPage: Page | undefined
  try {
    const activityUrl = `${loopback.origin}/working-set-activity`
    const activityKey = pageIdentityForWorkingSet(activityUrl)
    const activityStartedAt = Date.now()
    activityPage = await installedExtension.context.newPage()
    await activityPage.bringToFront()
    await activityPage.goto(activityUrl, { waitUntil: 'domcontentloaded' })

    await expect.poll(async () => {
      const snapshot = await readIndexedDbPhysicalSnapshot(
        controller,
        databaseName,
      )
      return snapshot.entries.some((entry) => entry.key === activityKey)
    }).toBe(true)
    const activeIdb = await readIndexedDbPhysicalSnapshot(
      controller,
      databaseName,
    )
    assertIndexedDbStructure(activeIdb)
    expect(activeIdb.entries).not.toEqual(migratedIdb.entries)
    expect(activeIdb.entries.map((entry) => entry.key).toSorted()).toEqual([
      ...Object.keys(legacy.records),
      activityKey,
    ].toSorted())
    expect(activeIdb.manifest).toEqual(migratedIdb.manifest)
    const activityRecord = (await decodePhysicalRows(activeIdb))
      .find((record) => record.key === activityKey)
    expect(activityRecord).toBeDefined()
    expect(activityRecord?.lastSeenAt).toBeGreaterThanOrEqual(activityStartedAt)
    expect(activityRecord?.events.length).toBeGreaterThan(0)

    const activeChrome = await readChromeAuthoritySnapshot(controller)
    expect(activeChrome.marker).toEqual(migratedChrome.marker)
    expect(activeChrome.legacy).toEqual(legacy)
    expect(activeChrome.legacyJson).toBe(legacyJson)
    expect(installedExtension.runtimeErrors()).toEqual([])
  } finally {
    await activityPage?.close()
    await loopback.close()
  }
})
