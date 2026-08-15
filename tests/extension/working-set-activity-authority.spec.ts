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
  WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
  WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
  WORKING_SET_ACTIVITY_MANIFEST_KEY,
  WORKING_SET_ACTIVITY_MANIFEST_STORE,
  WORKING_SET_ACTIVITY_RECORDS_STORE,
  workingSetActivityGenerationManifestSchema,
} from '../../src/extension/background/working-set-activity-indexed-db.js'
import type { WorkingSetActivityRecord } from '../../src/extension/types'
import { pageIdentityForWorkingSet } from '../../src/extension/working-set.js'
import {
  expect,
  test,
} from './installed-extension.js'
import { terminateServiceWorkerAndProveAbsent } from './service-worker-cdp.js'

interface ChromeAuthoritySnapshot {
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

async function expectedEmptySourceDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([
      WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
      [],
    ])),
  )
  return new Uint8Array(digest).toHex()
}

async function readChromeAuthoritySnapshot(
  page: Page,
): Promise<ChromeAuthoritySnapshot> {
  return page.evaluate(async (authorityKey) => {
    const values = await chrome.storage.local.get(authorityKey)
    return { marker: values[authorityKey] }
  }, WORKING_SET_ACTIVITY_AUTHORITY_KEY)
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

test('bootstraps an empty IndexedDB authority and recovers activity after worker restart', async ({
  installedExtension,
}) => {
  test.setTimeout(90_000)
  const workerUrl = installedExtension.serviceWorker.url()
  const controller = installedExtension.context.pages()[0]
  invariant(controller !== undefined, 'Installed extension opened no controller page')
  const sourceDigest = await expectedEmptySourceDigest()

  const dashboardUrl =
    `chrome-extension://${installedExtension.extensionId}/index.html`
  await expectStartupFrame(controller, dashboardUrl)

  await expect.poll(async () =>
    (await readChromeAuthoritySnapshot(controller)).marker === undefined,
  ).toBe(false)
  const initialChrome = await readChromeAuthoritySnapshot(controller)
  const marker = Schema.decodeUnknownSync(
    workingSetActivityAuthorityMarkerSchema,
  )(initialChrome.marker)
  expect(initialChrome.marker).toEqual(marker)
  expect(marker.sourceDigest).toBe(sourceDigest)
  expect(marker.generation).toBe(`v1:${sourceDigest}`)
  expect(marker.recordCount).toBe(0)
  expect(marker.eventCount).toBe(0)
  expect(marker.retainedAfter).toBe(
    marker.cutoverAt - 30 * 24 * 60 * 60_000,
  )

  const databaseName = databaseNameForGeneration(marker.generation)
  const initialIdb = await readIndexedDbPhysicalSnapshot(
    controller,
    databaseName,
  )
  expect(WORKING_SET_ACTIVITY_INDEXED_DB_VERSION).toBe(
    WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
  )
  assertIndexedDbStructure(initialIdb)
  expect(initialIdb.catalog).toContainEqual({
    name: databaseName,
    version: WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
  })
  expect(initialIdb.entries).toEqual([])
  expect(initialIdb.lastEventIndexKeys).toEqual([])
  const manifest = Schema.decodeUnknownSync(
    workingSetActivityGenerationManifestSchema,
  )(initialIdb.manifest)
  const expectedManifest = {
    schemaVersion: marker.schemaVersion,
    generation: marker.generation,
    sourceDigest: marker.sourceDigest,
    recordCount: marker.recordCount,
    eventCount: marker.eventCount,
    retainedAfter: marker.retainedAfter,
  }
  expect(initialIdb.manifest).toEqual(expectedManifest)
  expect(manifest).toEqual(expectedManifest)
  expect(await decodePhysicalRows(initialIdb)).toEqual([])

  await terminateServiceWorkerAndProveAbsent(
    installedExtension.context,
    controller,
    workerUrl,
  )
  await expectStartupFrame(controller, dashboardUrl)
  const recoveredChrome = await readChromeAuthoritySnapshot(controller)
  expect(recoveredChrome).toEqual(initialChrome)
  const recoveredIdb = await readIndexedDbPhysicalSnapshot(
    controller,
    databaseName,
  )
  expect(recoveredIdb).toEqual(initialIdb)
  expect(await decodePhysicalRows(recoveredIdb)).toEqual([])

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
    expect(activeIdb.entries).not.toEqual(initialIdb.entries)
    expect(activeIdb.entries.map((entry) => entry.key)).toEqual([activityKey])
    expect(activeIdb.manifest).toEqual(initialIdb.manifest)
    const activityRecord = (await decodePhysicalRows(activeIdb))
      .find((record) => record.key === activityKey)
    expect(activityRecord).toBeDefined()
    expect(activityRecord?.lastSeenAt).toBeGreaterThanOrEqual(activityStartedAt)
    expect(activityRecord?.events.length).toBeGreaterThan(0)

    const activeChrome = await readChromeAuthoritySnapshot(controller)
    expect(activeChrome.marker).toEqual(initialChrome.marker)

    await terminateServiceWorkerAndProveAbsent(
      installedExtension.context,
      controller,
      workerUrl,
    )
    await expectStartupFrame(controller, dashboardUrl)
    const restartedIdb = await readIndexedDbPhysicalSnapshot(
      controller,
      databaseName,
    )
    expect(restartedIdb).toEqual(activeIdb)
    expect(installedExtension.runtimeErrors()).toEqual([])
  } finally {
    await activityPage?.close()
    await loopback.close()
  }
})
