import { fileURLToPath } from 'node:url'

import {
  expect,
  test,
  type Page
} from '@playwright/test'
import { Schema } from 'effect'

import {
  WORKING_SET_ACTIVITY_AUTHORITY_KEY,
  WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
  type WorkingSetActivityAuthorityMarker,
  workingSetActivityAuthorityMarkerSchema
} from '../../src/extension/background/working-set-activity-authority.js'
import {
  databaseNameForGeneration,
  WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
  WORKING_SET_ACTIVITY_LAST_EVENT_INDEX,
  WORKING_SET_ACTIVITY_MANIFEST_KEY,
  WORKING_SET_ACTIVITY_MANIFEST_STORE,
  WORKING_SET_ACTIVITY_RECORDS_STORE
} from '../../src/extension/background/working-set-activity-indexed-db.js'
import {
  WORKING_SET_ACTIVITY_KEY
} from '../../src/extension/background/working-set-activity-storage.js'
import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from '../../src/extension/runtime-messages.js'
import type {
  WorkingSetActivityRecord,
  WorkingSetActivityStore
} from '../../src/extension/types'
import {
  emptyWorkingSetActivity,
  recordWorkingSetActivity
} from '../../src/extension/working-set.js'
import {
  launchInstalledExtensionFromArtifact,
  type LaunchedInstalledExtension
} from './installed-extension.js'
import { terminateServiceWorkerAndProveAbsent } from './service-worker-cdp.js'

const builtExtensionDirectory = fileURLToPath(
  new URL('../../extension/', import.meta.url)
)
const startupTraceKey = '__tabOutWorkingSetActivityFailureTrace'
const markedSentinelStore = 'marked-schema-sentinel'
const candidateSentinelStore = 'candidate-schema-sentinel'
const futureSentinelStore = 'future-schema-sentinel'

interface Scenario {
  readonly controller: Page
  readonly initialMarker: WorkingSetActivityAuthorityMarker
  readonly installed: LaunchedInstalledExtension
  readonly workerUrl: string
}

interface AuthorityStorageSnapshot {
  readonly legacy: unknown
  readonly legacyJson: string | null
  readonly marker: unknown
}

interface PhysicalDatabaseSnapshot {
  readonly exists: boolean
  readonly manifest: unknown
  readonly recordCount: number | null
  readonly recordIndexNames: readonly string[] | null
  readonly storeNames: readonly string[]
  readonly version: number | null
}

interface StartupTrace {
  readonly requestCount: number
  readonly responseOk: boolean | null
  readonly settled: boolean
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function dashboardUrl(installed: LaunchedInstalledExtension): string {
  return `chrome-extension://${installed.extensionId}/index.html`
}

function staticControllerUrl(installed: LaunchedInstalledExtension): string {
  return `chrome-extension://${installed.extensionId}/manifest.json`
}

async function readAuthorityStorage(
  page: Page
): Promise<AuthorityStorageSnapshot> {
  return page.evaluate(async ({ authorityKey, legacyKey }) => {
    const values = await chrome.storage.local.get([authorityKey, legacyKey])
    const legacy = values[legacyKey]
    return {
      legacy,
      legacyJson: JSON.stringify(legacy) ?? null,
      marker: values[authorityKey]
    }
  }, {
    authorityKey: WORKING_SET_ACTIVITY_AUTHORITY_KEY,
    legacyKey: WORKING_SET_ACTIVITY_KEY
  })
}

async function waitForAuthorityMarker(
  page: Page
): Promise<WorkingSetActivityAuthorityMarker> {
  await expect.poll(async () =>
    (await readAuthorityStorage(page)).marker !== undefined
  ).toBe(true)
  const raw = (await readAuthorityStorage(page)).marker
  const marker = Schema.decodeUnknownSync(
    workingSetActivityAuthorityMarkerSchema
  )(raw)
  expect(raw).toEqual(marker)
  return marker
}

async function withFreshScenario(
  run: (scenario: Scenario) => Promise<void>
): Promise<void> {
  const installed = await launchInstalledExtensionFromArtifact(
    builtExtensionDirectory
  )
  try {
    const controller = installed.context.pages()[0]
      ?? await installed.context.newPage()
    await controller.goto(staticControllerUrl(installed), {
      waitUntil: 'domcontentloaded'
    })
    await expect(controller).toHaveURL(staticControllerUrl(installed))
    await expect(controller.evaluate(() => chrome.runtime.id)).resolves.toBe(
      installed.extensionId
    )
    const initialMarker = await waitForAuthorityMarker(controller)
    await run({
      controller,
      initialMarker,
      installed,
      workerUrl: installed.serviceWorker.url()
    })
    expect(installed.runtimeErrors()).toEqual([])
  } finally {
    await installed.dispose()
  }
}

async function deletePhysicalDatabase(
  page: Page,
  databaseName: string
): Promise<void> {
  await page.evaluate((name) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(
      `Deleting ${name} was blocked by a live connection`
    ))
    request.onsuccess = () => resolve()
  }), databaseName)
}

async function createPhysicalDatabase(
  page: Page,
  databaseName: string,
  version: number,
  storeNames: readonly string[]
): Promise<void> {
  await page.evaluate(({ name, storeNames, version }) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, version)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(
        `Creating ${name} was blocked by a live connection`
      ))
      request.onupgradeneeded = () => {
        for (const storeName of storeNames) {
          request.result.createObjectStore(storeName)
        }
      }
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
    }), { name: databaseName, storeNames, version })
}

async function inspectPhysicalDatabase(
  page: Page,
  databaseName: string
): Promise<PhysicalDatabaseSnapshot> {
  return page.evaluate(async ({
    databaseName,
    manifestKey,
    manifestStoreName,
    recordsStoreName
  }) => {
    function requestResult<Value>(request: IDBRequest<Value>): Promise<Value> {
      return new Promise((resolve, reject) => {
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      })
    }

    const exists = (await indexedDB.databases()).some((database) =>
      database.name === databaseName)
    if (!exists) {
      return {
        exists: false,
        manifest: null,
        recordCount: null,
        recordIndexNames: null,
        storeNames: [],
        version: null
      }
    }

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(
        `Inspecting ${databaseName} was blocked`
      ))
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        reject(new Error(
          `Inspecting ${databaseName} unexpectedly required creation`
        ))
      }
      request.onsuccess = () => resolve(request.result)
    })

    try {
      const storeNames = Array.from(database.objectStoreNames)
      let manifest: unknown = null
      let recordCount: number | null = null
      let recordIndexNames: readonly string[] | null = null
      if (storeNames.includes(manifestStoreName)) {
        const transaction = database.transaction(
          manifestStoreName,
          'readonly'
        )
        manifest = await requestResult(
          transaction.objectStore(manifestStoreName).get(manifestKey)
        ) ?? null
      }
      if (storeNames.includes(recordsStoreName)) {
        const transaction = database.transaction(
          recordsStoreName,
          'readonly'
        )
        const records = transaction.objectStore(recordsStoreName)
        recordIndexNames = Array.from(records.indexNames)
        recordCount = await requestResult(records.count())
      }
      return {
        exists: true,
        manifest,
        recordCount,
        recordIndexNames,
        storeNames,
        version: database.version
      }
    } finally {
      database.close()
    }
  }, {
    databaseName,
    manifestKey: WORKING_SET_ACTIVITY_MANIFEST_KEY,
    manifestStoreName: WORKING_SET_ACTIVITY_MANIFEST_STORE,
    recordsStoreName: WORKING_SET_ACTIVITY_RECORDS_STORE
  })
}

async function seedUnmarkedLegacy(
  page: Page,
  legacy: WorkingSetActivityStore
): Promise<AuthorityStorageSnapshot> {
  await page.evaluate(async ({ authorityKey, legacyKey, legacy }) => {
    await chrome.storage.local.set({ [legacyKey]: legacy })
    await chrome.storage.local.remove(authorityKey)
  }, {
    authorityKey: WORKING_SET_ACTIVITY_AUTHORITY_KEY,
    legacy,
    legacyKey: WORKING_SET_ACTIVITY_KEY
  })
  const snapshot = await readAuthorityStorage(page)
  expect(snapshot.marker).toBeUndefined()
  expect(snapshot.legacy).toEqual(legacy)
  return snapshot
}

function makeLegacyActivity(now: number): WorkingSetActivityStore {
  const url = 'https://example.test/native-failure'
  return recordWorkingSetActivity(emptyWorkingSetActivity(), {
    kind: 'activation',
    at: now - 1_000,
    tab: {
      rawUrl: url,
      title: 'Example Native Failure',
      url
    }
  })
}

async function sourceDigest(
  activity: WorkingSetActivityStore
): Promise<string> {
  const rows = Object.values(activity.records)
    .toSorted((left, right) => left.key.localeCompare(right.key))
    .map((record) => canonicalActivityRow(record))
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([
      WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
      rows
    ]))
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'))
    .join('')
}

function canonicalActivityRow(record: WorkingSetActivityRecord): unknown {
  return [
    record.key,
    record.title,
    record.dismissedAt ?? null,
    record.dismissedUntil ?? null,
    record.events.map((event) => [
      event.kind === 'activation' ? 0 : 1,
      event.at
    ])
  ]
}

async function installStartupTrace(page: Page): Promise<void> {
  await page.addInitScript(({ messageType, traceKey }) => {
    type MutableStartupTrace = {
      requestCount: number
      responseOk: boolean | null
      settled: boolean
    }
    const trace: MutableStartupTrace = {
      requestCount: 0,
      responseOk: null,
      settled: false
    }
    Reflect.set(globalThis, traceKey, trace)
    const runtime = globalThis.chrome?.runtime
    if (!runtime?.sendMessage) return
    const originalSendMessage = runtime.sendMessage.bind(runtime)
    Reflect.set(runtime, 'sendMessage', (...args: unknown[]) => {
      const message = args.find((value) =>
        typeof value === 'object' && value !== null &&
        Reflect.get(value, 'type') === messageType)
      const result = Reflect.apply(originalSendMessage, runtime, args)
      if (message === undefined || trace.settled) return result
      trace.requestCount += 1
      return Promise.resolve(result).then(
        (response) => {
          trace.responseOk = typeof response === 'object' && response !== null &&
              typeof Reflect.get(response, 'ok') === 'boolean'
            ? Reflect.get(response, 'ok')
            : null
          trace.settled = true
          return response
        },
        (cause: unknown) => {
          trace.settled = true
          throw cause
        }
      )
    })
  }, {
    messageType: DASHBOARD_SERVICE_STATE_GET_MESSAGE,
    traceKey: startupTraceKey
  })
}

function parseStartupTrace(value: unknown): StartupTrace | null {
  if (typeof value !== 'object' || value === null) return null
  const requestCount = Reflect.get(value, 'requestCount')
  const responseOk = Reflect.get(value, 'responseOk')
  const settled = Reflect.get(value, 'settled')
  return Number.isSafeInteger(requestCount) && requestCount >= 0 &&
    (typeof responseOk === 'boolean' || responseOk === null) &&
    typeof settled === 'boolean'
    ? { requestCount, responseOk, settled }
    : null
}

async function assertFailedStartupFrame(
  page: Page,
  url: string
): Promise<void> {
  if (page.url() === url) {
    await page.reload({ waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
  }
  const header = page.locator('[data-tabout="header-stats"]')
  await expect(header).toBeAttached()
  await page.waitForFunction((traceKey) => {
    const trace = Reflect.get(globalThis, traceKey)
    return typeof trace === 'object' && trace !== null &&
      Reflect.get(trace, 'settled') === true
  }, startupTraceKey)
  const trace = parseStartupTrace(await page.evaluate((traceKey) =>
    Reflect.get(globalThis, traceKey), startupTraceKey))
  invariant(trace !== null, 'Startup failure trace was malformed')
  expect(trace.requestCount).toBeGreaterThan(0)
  expect(trace.responseOk).toBe(false)
  await expect(header).toHaveAttribute('aria-hidden', 'true')
  await page.waitForTimeout(500)
  await expect(header).toHaveAttribute('aria-hidden', 'true')
}

async function assertSuccessfulStartupFrame(
  page: Page,
  url: string
): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  const header = page.locator('[data-tabout="header-stats"]')
  await expect(header).toBeAttached()
  await expect(header).not.toHaveAttribute('aria-hidden', 'true')
  const response: unknown = await page.evaluate(async (type) =>
    chrome.runtime.sendMessage({ type }), DASHBOARD_SERVICE_STATE_GET_MESSAGE)
  expect(response).toMatchObject({ ok: true })
}

async function terminateScenarioWorker(scenario: Scenario): Promise<void> {
  await terminateServiceWorkerAndProveAbsent(
    scenario.installed.context,
    scenario.controller,
    scenario.workerUrl
  )
}

test.describe.configure({ timeout: 90_000 })

test('marked missing database fails Startup Frame and stays absent after restart', async () => {
  await withFreshScenario(async (scenario) => {
    const databaseName = databaseNameForGeneration(
      scenario.initialMarker.generation
    )
    const authorityBefore = await readAuthorityStorage(scenario.controller)
    expect((await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )).exists).toBe(true)
    await terminateScenarioWorker(scenario)
    await deletePhysicalDatabase(scenario.controller, databaseName)
    expect(await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )).toEqual({
      exists: false,
      manifest: null,
      recordCount: null,
      recordIndexNames: null,
      storeNames: [],
      version: null
    })

    await installStartupTrace(scenario.controller)
    const url = dashboardUrl(scenario.installed)
    await assertFailedStartupFrame(scenario.controller, url)
    expect(await readAuthorityStorage(scenario.controller)).toEqual(
      authorityBefore
    )
    expect((await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )).exists).toBe(false)

    await terminateScenarioWorker(scenario)
    await assertFailedStartupFrame(scenario.controller, url)
    expect(await readAuthorityStorage(scenario.controller)).toEqual(
      authorityBefore
    )
    expect((await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )).exists).toBe(false)
  })
})

test('marked database missing a required store fails without repair or fallback', async () => {
  await withFreshScenario(async (scenario) => {
    const databaseName = databaseNameForGeneration(
      scenario.initialMarker.generation
    )
    const authorityBefore = await readAuthorityStorage(scenario.controller)
    await terminateScenarioWorker(scenario)
    await deletePhysicalDatabase(scenario.controller, databaseName)
    await createPhysicalDatabase(
      scenario.controller,
      databaseName,
      WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
      [WORKING_SET_ACTIVITY_MANIFEST_STORE, markedSentinelStore]
    )
    const malformed = await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )
    expect(malformed.storeNames).toEqual([
      WORKING_SET_ACTIVITY_MANIFEST_STORE,
      markedSentinelStore
    ].toSorted())
    expect(malformed.version).toBe(WORKING_SET_ACTIVITY_INDEXED_DB_VERSION)

    await installStartupTrace(scenario.controller)
    await assertFailedStartupFrame(
      scenario.controller,
      dashboardUrl(scenario.installed)
    )
    expect(await readAuthorityStorage(scenario.controller)).toEqual(
      authorityBefore
    )
    expect(await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )).toEqual(malformed)
  })
})

test('same-version unmarked candidate is repaired before authority is committed', async () => {
  await withFreshScenario(async (scenario) => {
    const legacy = makeLegacyActivity(Date.now())
    const digest = await sourceDigest(legacy)
    const generation = `v1:${digest}`
    const databaseName = databaseNameForGeneration(generation)
    const unmarked = await seedUnmarkedLegacy(scenario.controller, legacy)
    await terminateScenarioWorker(scenario)
    await deletePhysicalDatabase(scenario.controller, databaseName)
    await createPhysicalDatabase(
      scenario.controller,
      databaseName,
      WORKING_SET_ACTIVITY_INDEXED_DB_VERSION,
      [candidateSentinelStore]
    )
    const malformed = await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )
    expect(malformed.storeNames).toEqual([candidateSentinelStore])
    expect((await readAuthorityStorage(scenario.controller)).marker)
      .toBeUndefined()

    await assertSuccessfulStartupFrame(
      scenario.controller,
      dashboardUrl(scenario.installed)
    )
    const authorityAfter = await readAuthorityStorage(scenario.controller)
    const marker = Schema.decodeUnknownSync(
      workingSetActivityAuthorityMarkerSchema
    )(authorityAfter.marker)
    expect(marker.sourceDigest).toBe(digest)
    expect(marker.generation).toBe(generation)
    expect(marker.recordCount).toBe(1)
    expect(marker.eventCount).toBe(1)
    expect(authorityAfter.legacy).toEqual(unmarked.legacy)
    expect(authorityAfter.legacyJson).toBe(unmarked.legacyJson)

    const repaired = await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )
    expect(repaired).toEqual({
      exists: true,
      manifest: {
        schemaVersion: marker.schemaVersion,
        generation: marker.generation,
        sourceDigest: marker.sourceDigest,
        recordCount: marker.recordCount,
        eventCount: marker.eventCount,
        retainedAfter: marker.retainedAfter
      },
      recordCount: 1,
      recordIndexNames: [WORKING_SET_ACTIVITY_LAST_EVENT_INDEX],
      storeNames: [
        WORKING_SET_ACTIVITY_MANIFEST_STORE,
        WORKING_SET_ACTIVITY_RECORDS_STORE
      ].toSorted(),
      version: WORKING_SET_ACTIVITY_INDEXED_DB_VERSION
    })
  })
})

test('future-version unmarked candidate fails closed and is left untouched', async () => {
  await withFreshScenario(async (scenario) => {
    const legacy = makeLegacyActivity(Date.now())
    const digest = await sourceDigest(legacy)
    const generation = `v1:${digest}`
    const databaseName = databaseNameForGeneration(generation)
    const unmarked = await seedUnmarkedLegacy(scenario.controller, legacy)
    await terminateScenarioWorker(scenario)
    await deletePhysicalDatabase(scenario.controller, databaseName)
    await createPhysicalDatabase(
      scenario.controller,
      databaseName,
      WORKING_SET_ACTIVITY_INDEXED_DB_VERSION + 1,
      [futureSentinelStore]
    )
    const future = await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )
    expect(future.version).toBe(WORKING_SET_ACTIVITY_INDEXED_DB_VERSION + 1)
    expect(future.storeNames).toEqual([futureSentinelStore])

    await installStartupTrace(scenario.controller)
    await assertFailedStartupFrame(
      scenario.controller,
      dashboardUrl(scenario.installed)
    )
    const authorityAfter = await readAuthorityStorage(scenario.controller)
    expect(authorityAfter.marker).toBeUndefined()
    expect(authorityAfter.legacy).toEqual(unmarked.legacy)
    expect(authorityAfter.legacyJson).toBe(unmarked.legacyJson)
    expect(await inspectPhysicalDatabase(
      scenario.controller,
      databaseName
    )).toEqual(future)
  })
})
