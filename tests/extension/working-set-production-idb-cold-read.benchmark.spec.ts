import { createHash } from 'node:crypto'
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  join,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  expect,
  test,
  type Page,
  type TestInfo,
} from '@playwright/test'

import {
  buildWorkingSetStorageBenchmarkArtifacts,
  sha256Directory,
  sha256File,
  type WorkingSetBenchmarkArtifactSidecar,
} from '../../scripts/build-working-set-storage-benchmark.js'
import {
  workingSetBenchmarkBackendModulePath,
} from '../../scripts/working-set-benchmark-build-config.js'
import {
  WORKING_SET_ACTIVITY_AUTHORITY_KEY,
} from '../../src/extension/background/working-set-activity-authority.js'
import {
  WORKING_SET_ACTIVITY_DATABASE_PREFIX,
  WORKING_SET_ACTIVITY_MANIFEST_KEY,
  WORKING_SET_ACTIVITY_MANIFEST_STORE,
} from '../../src/extension/background/working-set-activity-indexed-db.js'
import {
  WORKING_SET_ACTIVITY_KEY,
} from '../../src/extension/background/working-set-activity-storage.js'
import { chromeSupportPolicy } from '../../src/extension/chrome-support.js'
import {
  DASHBOARD_SERVICE_STATE_GET_MESSAGE,
} from '../../src/extension/runtime-messages.js'
import type { WorkingSetActivityStore } from '../../src/extension/types'
import {
  makeWorkingSetStorageProfile,
} from '../helpers/working-set-storage-profile.js'
import {
  launchInstalledExtensionFromArtifact,
  type LaunchedInstalledExtension,
} from './installed-extension.js'
import {
  terminateServiceWorkerAndProveAbsent,
} from './service-worker-cdp.js'
import {
  parseWorkingSetStorageBenchmarkResponse,
  WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
} from './working-set-storage-benchmark-protocol.js'

const PROBE_TIMEOUT_MS = 30 * 60_000
const PROFILE = '500x20' as const
const EXPECTED_RECORD_COUNT = 500
const EXPECTED_EVENT_COUNT = 10_000
const PRODUCTION_CONTROLLER_PAGE =
  'working-set-production-idb-cold-read-controller.html'
const BENCHMARK_SENTINEL = '__TAB_OUT_WORKING_SET_STORAGE_BENCHMARK__'
const REPORT_KIND = 'working-set-production-idb-cold-read-probe'
const BOOTSTRAP_REPETITIONS = 2_000
const BOOTSTRAP_SEED = 0x51f160
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const productionExtensionDirectory = resolve(repositoryRoot, 'extension')

const controllerHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Working Set production IDB cold-read probe</title>
  </head>
  <body></body>
</html>
`

type Variant = 'current-frozen' | 'production-idb'
type SamplePhase = 'warmup' | 'measured'

interface DisposableProductionArtifact extends AsyncDisposable {
  readonly controllerPage: string
  readonly directory: string
  readonly hashes: {
    readonly backgroundBundleSha256: string
    readonly controllerSha256: string
    readonly exactProductionTreeSha256: string
    readonly probeTreeSha256: string
  }
  readonly dispose: () => Promise<void>
}

interface RunningVariant {
  readonly browser: {
    readonly actualChromeMajor: number | null
    readonly actualChromeVersion: string | null
    readonly declaredMinimumChromeMajor: number
    readonly matchesDeclaredMinimum: boolean
    readonly userAgent: string
  }
  readonly variant: Variant
  readonly controller: Page
  readonly installed: LaunchedInstalledExtension
  readonly workerUrl: string
}

interface DashboardReadResult {
  readonly canonicalActivitySha256: string
  readonly directInvocationCount: 1
  readonly durationMs: number
  readonly eventCount: number
  readonly explicitSuccess: boolean
  readonly recordCount: number
}

interface ColdReadSample extends DashboardReadResult {
  readonly browser: RunningVariant['browser']
  readonly expectedCanonicalActivitySha256: string
  readonly iteration: number
  readonly order: number
  readonly phase: SamplePhase
  readonly profile: typeof PROFILE
  readonly productionAuthorityAfter?: unknown
  readonly productionAuthorityBefore?: unknown
  readonly setupCanonicalActivitySha256: string
  readonly variant: Variant
  readonly workerAbsentBeforeRequest: true
}

interface Distribution {
  readonly count: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function chromeVersionFromUserAgent(userAgent: string): string | null {
  return /(?:HeadlessChrome|Chrome)\/([\d.]+)/.exec(userAgent)?.[1] ?? null
}

function configuredCount(
  environmentName: string,
  fallback: number,
  minimum: number,
): number {
  const raw = process.env[environmentName]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 100) {
    throw new Error(
      `${environmentName} must be an integer from ${String(minimum)} to 100`,
    )
  }
  return parsed
}

const WARMUP_RUNS = configuredCount(
  'TAB_OUT_WORKING_SET_PRODUCTION_COLD_READ_WARMUPS',
  5,
  0,
)
const MEASURED_RUNS = configuredCount(
  'TAB_OUT_WORKING_SET_PRODUCTION_COLD_READ_RUNS',
  30,
  1,
)

function percentile(values: readonly number[], fraction: number): number {
  invariant(values.length > 0, 'A percentile requires measurements')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  }
}

function canonicalActivitySha256(activity: WorkingSetActivityStore): string {
  const records = Object.keys(activity.records).sort().map((key) => {
    const record = activity.records[key]
    invariant(record !== undefined, `${key} was absent while hashing activity`)
    return [
      record.key,
      record.url,
      record.title,
      record.domain,
      record.lastSeenAt,
      record.lastActivatedAt ?? null,
      record.lastNavigatedAt ?? null,
      record.dismissedAt ?? null,
      record.dismissedUntil ?? null,
      record.events.map((event) => [event.kind, event.at]),
    ]
  })
  return createHash('sha256').update(JSON.stringify([
    activity.version,
    records,
  ])).digest('hex')
}

function phaseAndIteration(cycle: number): {
  readonly phase: SamplePhase
  readonly iteration: number
} {
  return cycle < WARMUP_RUNS
    ? { phase: 'warmup', iteration: cycle }
    : { phase: 'measured', iteration: cycle - WARMUP_RUNS }
}

function currentArtifact(
  artifacts: readonly WorkingSetBenchmarkArtifactSidecar[],
): WorkingSetBenchmarkArtifactSidecar {
  const artifact = artifacts.find((candidate) => candidate.variant === 'current')
  invariant(artifact !== undefined, 'Benchmark build omitted current artifact')
  invariant(
    artifact.instrumentation === 'none',
    'Frozen current artifact unexpectedly enabled instrumentation',
  )
  invariant(
    artifact.selectedBackendModule ===
    workingSetBenchmarkBackendModulePath(repositoryRoot, 'current'),
    'Frozen current artifact did not select its owned Chrome-envelope backend',
  )
  return artifact
}

async function makeDisposableProductionArtifact(): Promise<
  DisposableProductionArtifact
> {
  const exactProductionTreeSha256 = await sha256Directory(
    productionExtensionDirectory,
  )
  const backgroundBundleSha256 = await sha256File(resolve(
    productionExtensionDirectory,
    'dist/background.js',
  ))
  const backgroundBundle = await readFile(resolve(
    productionExtensionDirectory,
    'dist/background.js',
  ), 'utf8')
  invariant(
    !backgroundBundle.includes(BENCHMARK_SENTINEL),
    'Production background bundle contains benchmark instrumentation',
  )

  const temporaryDirectory = await mkdtemp(join(
    tmpdir(),
    'tab-out-production-idb-cold-read-',
  ))
  const directory = resolve(temporaryDirectory, 'extension')
  let disposed = false
  try {
    await cp(productionExtensionDirectory, directory, {
      errorOnExist: true,
      force: false,
      recursive: true,
    })
    const controllerPath = resolve(directory, PRODUCTION_CONTROLLER_PAGE)
    await writeFile(controllerPath, controllerHtml, {
      encoding: 'utf8',
      flag: 'wx',
    })
    const controllerSha256 = createHash('sha256')
      .update(controllerHtml)
      .digest('hex')
    const probeTreeSha256 = await sha256Directory(directory)
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      await rm(temporaryDirectory, { force: true, recursive: true })
    }
    return {
      controllerPage: PRODUCTION_CONTROLLER_PAGE,
      directory,
      hashes: {
        backgroundBundleSha256,
        controllerSha256,
        exactProductionTreeSha256,
        probeTreeSha256,
      },
      dispose,
      [Symbol.asyncDispose]: dispose,
    }
  } catch (cause) {
    await rm(temporaryDirectory, { force: true, recursive: true })
    throw cause
  }
}

async function launchVariant(
  variant: Variant,
  extensionDirectory: string,
  controllerPage: string,
): Promise<RunningVariant> {
  const installed = await launchInstalledExtensionFromArtifact(
    extensionDirectory,
  )
  try {
    const controller = await installed.context.newPage()
    await controller.goto(
      `chrome-extension://${installed.extensionId}/${controllerPage}`,
      { waitUntil: 'domcontentloaded' },
    )
    const userAgent = await controller.evaluate(() => navigator.userAgent)
    const actualChromeVersion = chromeVersionFromUserAgent(userAgent)
    const actualChromeMajor = actualChromeVersion === null
      ? null
      : Number(actualChromeVersion.split('.')[0])
    invariant(
      actualChromeMajor === chromeSupportPolicy.minimumMajor,
      `${variant} ran Chrome ${String(actualChromeVersion)}; expected major ` +
      String(chromeSupportPolicy.minimumMajor),
    )
    return {
      browser: {
        actualChromeMajor,
        actualChromeVersion,
        declaredMinimumChromeMajor: chromeSupportPolicy.minimumMajor,
        matchesDeclaredMinimum:
          actualChromeMajor === chromeSupportPolicy.minimumMajor,
        userAgent,
      },
      variant,
      controller,
      installed,
      workerUrl: installed.serviceWorker.url(),
    }
  } catch (cause) {
    await installed.dispose().catch(() => undefined)
    throw cause
  }
}

async function sendDashboardServiceRead(
  controller: Page,
): Promise<DashboardReadResult> {
  return controller.evaluate(async (messageType) => {
    let directInvocationCount = 0
    const startedAt = performance.now()
    directInvocationCount += 1
    const response: unknown = await chrome.runtime.sendMessage({
      type: messageType,
    })
    // Stop the measured boundary as soon as the service-state Promise settles.
    // Canonical semantic hashing below is deliberately untimed.
    const durationMs = performance.now() - startedAt
    if (typeof response !== 'object' || response === null) {
      throw new Error('Dashboard service-state request returned no response')
    }
    const explicitSuccess = Reflect.get(response, 'ok') === true
    const activity: unknown = Reflect.get(response, 'workingSetActivity')
    if (typeof activity !== 'object' || activity === null) {
      throw new Error('Dashboard service-state response omitted activity')
    }
    const records: unknown = Reflect.get(activity, 'records')
    if (typeof records !== 'object' || records === null) {
      throw new Error('Dashboard service-state activity omitted records')
    }
    const keys = Object.keys(records).sort()
    const values = keys.map((key) => Reflect.get(records, key))
    let eventCount = 0
    const canonicalRecords = values.map((record) => {
      if (typeof record !== 'object' || record === null) {
        throw new Error('Dashboard service-state activity contained a bad row')
      }
      const events: unknown = Reflect.get(record, 'events')
      if (!Array.isArray(events)) {
        throw new Error('Dashboard service-state row omitted events')
      }
      eventCount += events.length
      return [
        Reflect.get(record, 'key'),
        Reflect.get(record, 'url'),
        Reflect.get(record, 'title'),
        Reflect.get(record, 'domain'),
        Reflect.get(record, 'lastSeenAt'),
        Reflect.get(record, 'lastActivatedAt') ?? null,
        Reflect.get(record, 'lastNavigatedAt') ?? null,
        Reflect.get(record, 'dismissedAt') ?? null,
        Reflect.get(record, 'dismissedUntil') ?? null,
        events.map((event) => {
          if (typeof event !== 'object' || event === null) {
            throw new Error('Dashboard service-state row contained a bad event')
          }
          return [Reflect.get(event, 'kind'), Reflect.get(event, 'at')]
        }),
      ]
    })
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify([
        Reflect.get(activity, 'version'),
        canonicalRecords,
      ])),
    )
    const canonicalActivitySha256 = Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
    if (directInvocationCount !== 1) {
      throw new Error('Dashboard harness invoked sendMessage more than once')
    }
    return {
      canonicalActivitySha256,
      directInvocationCount: 1 as const,
      durationMs,
      eventCount,
      explicitSuccess,
      recordCount: values.length,
    }
  }, DASHBOARD_SERVICE_STATE_GET_MESSAGE)
}

function assertExpectedRead(
  variant: Variant,
  result: DashboardReadResult,
): void {
  invariant(result.explicitSuccess, `${variant} did not return explicit success`)
  invariant(
    result.directInvocationCount === 1,
    `${variant} harness invoked sendMessage more than once`,
  )
  invariant(
    result.recordCount === EXPECTED_RECORD_COUNT,
    `${variant} returned ${String(result.recordCount)} records; expected 500`,
  )
  invariant(
    result.eventCount === EXPECTED_EVENT_COUNT,
    `${variant} returned ${String(result.eventCount)} events; expected 10000`,
  )
}

async function seedFrozenCurrent(
  running: RunningVariant,
  now: number,
): Promise<DashboardReadResult> {
  const raw: unknown = await running.controller.evaluate(async ({
    messageType,
    now,
    profile,
  }) => chrome.runtime.sendMessage({
    type: messageType,
    operation: 'seed-profile',
    profile,
    now,
  }), {
    messageType: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
    now,
    profile: PROFILE,
  })
  const response = parseWorkingSetStorageBenchmarkResponse(raw)
  invariant(response !== null, 'Frozen current seed returned an invalid response')
  invariant(response.ok, 'Frozen current seed failed')
  invariant(response.operation === 'seed-profile', 'Frozen current seed changed operation')
  invariant(
    response.diagnostics.variant === 'current',
    'Frozen current artifact reported a different backend',
  )
  // The shared WorkingSet service may have cached an initial empty read while
  // the extension was loading. Restart before the unmeasured verification so
  // it observes the durable seed through the same cold full-service boundary
  // used by the production migration setup.
  await terminateServiceWorkerAndProveAbsent(
    running.installed.context,
    running.controller,
    running.workerUrl,
  )
  const setupRead = await sendDashboardServiceRead(running.controller)
  assertExpectedRead('current-frozen', setupRead)
  return setupRead
}

async function deleteDatabase(controller: Page, databaseName: string): Promise<void> {
  await controller.evaluate(async (name) => {
    await new Promise<void>((resolvePromise, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(
        `IndexedDB deletion was blocked: ${name}`,
      ))
      request.onsuccess = () => resolvePromise()
    })
  }, databaseName)
}

async function seedAndMigrateProduction(
  running: RunningVariant,
  activity: WorkingSetActivityStore,
): Promise<{
  readonly authorityProof: unknown
  readonly setupRead: DashboardReadResult
}> {
  // Let extension-install/startup work and its initial known-empty authority
  // settle before attempting worker termination. This mirrors the canonical
  // runner's unmeasured setup traffic and avoids racing Chrome's install wake.
  const initialRead = await sendDashboardServiceRead(running.controller)
  invariant(initialRead.explicitSuccess, 'Production initial setup read failed')
  const seeded = await running.controller.evaluate(async ({
    activity,
    authorityKey,
    legacyKey,
  }) => {
    await chrome.storage.local.remove(authorityKey)
    await chrome.storage.local.set({ [legacyKey]: activity })
    return chrome.storage.local.get([authorityKey, legacyKey])
  }, {
    activity,
    authorityKey: WORKING_SET_ACTIVITY_AUTHORITY_KEY,
    legacyKey: WORKING_SET_ACTIVITY_KEY,
  })
  invariant(
    Reflect.get(seeded, WORKING_SET_ACTIVITY_AUTHORITY_KEY) === undefined,
    'Production seed unexpectedly retained an authority marker',
  )
  invariant(
    Reflect.get(seeded, WORKING_SET_ACTIVITY_KEY) !== undefined,
    'Production seed omitted the legacy activity envelope',
  )

  // Marker removal cannot change the already-live authority coordinator.
  // Restart first, then remove its now-unowned empty generation while absent.
  await terminateServiceWorkerAndProveAbsent(
    running.installed.context,
    running.controller,
    running.workerUrl,
  )
  const existingDatabases = await running.controller.evaluate(async (prefix) =>
    (await indexedDB.databases()).flatMap((database) =>
      typeof database.name === 'string' && database.name.startsWith(`${prefix}:`)
        ? [database.name]
        : []), WORKING_SET_ACTIVITY_DATABASE_PREFIX)
  for (const databaseName of existingDatabases) {
    await deleteDatabase(running.controller, databaseName)
  }

  const migrationRead = await sendDashboardServiceRead(running.controller)
  assertExpectedRead('production-idb', migrationRead)
  const authorityProof = await readProductionAuthorityProof(running.controller)
  invariant(authorityProof.markerBackend === 'idb', 'Migration did not select IDB')
  invariant(
    authorityProof.markerRecordCount === EXPECTED_RECORD_COUNT,
    'Migration marker has the wrong record count',
  )
  invariant(
    authorityProof.markerEventCount === EXPECTED_EVENT_COUNT,
    'Migration marker has the wrong event count',
  )
  invariant(authorityProof.manifestMatchesMarker, 'IDB manifest differs from marker')
  return { authorityProof, setupRead: migrationRead }
}

async function readProductionAuthorityProof(controller: Page) {
  return controller.evaluate(async ({
    authorityKey,
    databasePrefix,
    manifestKey,
    manifestStore,
  }) => {
    const stored = await chrome.storage.local.get(authorityKey)
    const marker: unknown = stored[authorityKey]
    if (typeof marker !== 'object' || marker === null) {
      throw new Error('Production authority marker is absent')
    }
    const generation = Reflect.get(marker, 'generation')
    const markerBackend = Reflect.get(marker, 'backend')
    const markerEventCount = Reflect.get(marker, 'eventCount')
    const markerRecordCount = Reflect.get(marker, 'recordCount')
    if (typeof generation !== 'string') {
      throw new Error('Production authority marker has no generation')
    }
    const databaseName = `${databasePrefix}:${generation}`
    const catalog = await indexedDB.databases()
    if (!catalog.some((database) => database.name === databaseName)) {
      throw new Error('Production authority generation database is absent')
    }
    const database = await new Promise<IDBDatabase>((resolvePromise, reject) => {
      const request = indexedDB.open(databaseName)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(
        `IndexedDB authority proof was blocked: ${databaseName}`,
      ))
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        reject(new Error('IndexedDB authority proof would create a database'))
      }
      request.onsuccess = () => resolvePromise(request.result)
    })
    try {
      const transaction = database.transaction(manifestStore, 'readonly')
      const manifest = await new Promise<unknown>((resolvePromise, reject) => {
        const request = transaction.objectStore(manifestStore).get(manifestKey)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolvePromise(request.result)
      })
      const markerManifest = {
        schemaVersion: Reflect.get(marker, 'schemaVersion'),
        generation,
        sourceDigest: Reflect.get(marker, 'sourceDigest'),
        recordCount: markerRecordCount,
        eventCount: markerEventCount,
        retainedAfter: Reflect.get(marker, 'retainedAfter'),
      }
      return {
        databaseName,
        manifestMatchesMarker:
          JSON.stringify(manifest) === JSON.stringify(markerManifest),
        markerBackend,
        markerEventCount,
        markerRecordCount,
      }
    } finally {
      database.close()
    }
  }, {
    authorityKey: WORKING_SET_ACTIVITY_AUTHORITY_KEY,
    databasePrefix: WORKING_SET_ACTIVITY_DATABASE_PREFIX,
    manifestKey: WORKING_SET_ACTIVITY_MANIFEST_KEY,
    manifestStore: WORKING_SET_ACTIVITY_MANIFEST_STORE,
  })
}

async function measureColdRead(
  running: RunningVariant,
): Promise<DashboardReadResult> {
  await terminateServiceWorkerAndProveAbsent(
    running.installed.context,
    running.controller,
    running.workerUrl,
  )
  const result = await sendDashboardServiceRead(running.controller)
  assertExpectedRead(running.variant, result)
  return result
}

async function measureFreshVariant(
  variant: Variant,
  extensionDirectory: string,
  controllerPage: string,
  phase: SamplePhase,
  iteration: number,
  order: number,
  profile: ReturnType<typeof makeWorkingSetStorageProfile>,
  expectedCanonicalActivitySha256: string,
  cleanupErrors: string[],
): Promise<ColdReadSample> {
  const running = await launchVariant(
    variant,
    extensionDirectory,
    controllerPage,
  )
  try {
    let productionAuthorityBefore: unknown
    let setupRead: DashboardReadResult
    if (variant === 'current-frozen') {
      setupRead = await seedFrozenCurrent(running, profile.now)
    } else {
      const migrated = await seedAndMigrateProduction(
        running,
        profile.activity,
      )
      setupRead = migrated.setupRead
      productionAuthorityBefore = migrated.authorityProof
    }
    invariant(
      setupRead.canonicalActivitySha256 === expectedCanonicalActivitySha256,
      `${variant} unmeasured setup read changed canonical 500x20 activity`,
    )

    const measured = await measureColdRead(running)
    invariant(
      measured.canonicalActivitySha256 === expectedCanonicalActivitySha256,
      `${variant} measured cold read changed canonical 500x20 activity`,
    )
    const productionAuthorityAfter = variant === 'production-idb'
      ? await readProductionAuthorityProof(running.controller)
      : undefined
    if (variant === 'production-idb') {
      invariant(
        JSON.stringify(productionAuthorityAfter) ===
        JSON.stringify(productionAuthorityBefore),
        'Cold production read changed the authority marker or manifest',
      )
    }
    return {
      ...measured,
      browser: running.browser,
      expectedCanonicalActivitySha256,
      iteration,
      order,
      phase,
      profile: PROFILE,
      ...(productionAuthorityAfter === undefined
        ? {}
        : { productionAuthorityAfter }),
      ...(productionAuthorityBefore === undefined
        ? {}
        : { productionAuthorityBefore }),
      setupCanonicalActivitySha256: setupRead.canonicalActivitySha256,
      variant,
      workerAbsentBeforeRequest: true,
    }
  } finally {
    try {
      await running.installed.dispose()
    } catch (cause) {
      cleanupErrors.push(
        `${variant}/${phase}/${String(iteration)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
  }
}

function summarizeSamples(samples: readonly ColdReadSample[]) {
  return Object.fromEntries(([
    'current-frozen',
    'production-idb',
  ] as const).map((variant) => {
    const measured = samples.filter((sample) =>
      sample.phase === 'measured' && sample.variant === variant)
    return [variant, {
      requestDurationMs: distribution(measured.map((sample) => sample.durationMs)),
      recordCounts: [...new Set(measured.map((sample) => sample.recordCount))],
      eventCounts: [...new Set(measured.map((sample) => sample.eventCount))],
      explicitSuccessCount: measured.filter((sample) => sample.explicitSuccess).length,
      exactlyOneDirectInvocationCount: measured.filter((sample) =>
        sample.directInvocationCount === 1).length,
      canonicalActivitySha256: [...new Set(measured.map((sample) =>
        sample.canonicalActivitySha256))],
      expectedCanonicalActivitySha256: [...new Set(measured.map((sample) =>
        sample.expectedCanonicalActivitySha256))],
      browserVersions: [...new Set(measured.map((sample) =>
        sample.browser.actualChromeVersion))],
    }]
  }))
}

function summarizeBrowserEvidence(samples: readonly ColdReadSample[]) {
  return Object.fromEntries(([
    'current-frozen',
    'production-idb',
  ] as const).map((variant) => {
    const browser = samples.find((sample) => sample.variant === variant)?.browser
    invariant(browser !== undefined, `${variant} omitted browser evidence`)
    return [variant, browser]
  }))
}

function measuredSamples(
  samples: readonly ColdReadSample[],
  variant: Variant,
): readonly ColdReadSample[] {
  return samples.filter((sample) =>
    sample.phase === 'measured' && sample.variant === variant)
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function pairedColdBootstrap(
  currentSamples: readonly ColdReadSample[],
  productionSamples: readonly ColdReadSample[],
) {
  const currentByIteration = new Map(
    currentSamples.map((sample) => [sample.iteration, sample]),
  )
  const pairs = productionSamples.flatMap((production) => {
    const current = currentByIteration.get(production.iteration)
    return current === undefined ? [] : [{ current, production }]
  })
  if (pairs.length === 0) return null
  const random = makeRandom(BOOTSTRAP_SEED)
  const p95Deltas: number[] = []
  for (let repetition = 0; repetition < BOOTSTRAP_REPETITIONS; repetition += 1) {
    const sampledCurrent: number[] = []
    const sampledProduction: number[] = []
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[Math.floor(random() * pairs.length)]
      invariant(pair !== undefined, 'Paired bootstrap selected no sample')
      sampledCurrent.push(pair.current.durationMs)
      sampledProduction.push(pair.production.durationMs)
    }
    p95Deltas.push(
      percentile(sampledProduction, 0.95) -
      percentile(sampledCurrent, 0.95),
    )
  }
  return {
    pairCount: pairs.length,
    repetitions: BOOTSTRAP_REPETITIONS,
    seed: BOOTSTRAP_SEED,
    lower95Ms: percentile(p95Deltas, 0.025),
    upper95Ms: percentile(p95Deltas, 0.975),
  }
}

function evaluateColdReadBudget(samples: readonly ColdReadSample[]) {
  const current = measuredSamples(samples, 'current-frozen')
  const production = measuredSamples(samples, 'production-idb')
  invariant(current.length > 0, 'Cold-read budget has no current measurements')
  invariant(production.length > 0, 'Cold-read budget has no production measurements')
  const currentP95Ms = percentile(current.map((sample) => sample.durationMs), 0.95)
  const productionP95Ms = percentile(
    production.map((sample) => sample.durationMs),
    0.95,
  )
  const pointRegressionMs = productionP95Ms - currentP95Ms
  const allowedRegressionMs = Math.max(currentP95Ms * 0.1, 5)
  const bootstrap = pairedColdBootstrap(current, production)
  invariant(bootstrap !== null, 'Cold-read budget has no measured pairs')
  const pointWithinBudget = pointRegressionMs <= allowedRegressionMs
  const bootstrapUpperWithinBudget =
    bootstrap.upper95Ms <= allowedRegressionMs
  const canonicalSized = WARMUP_RUNS === 5 && MEASURED_RUNS === 30 &&
    current.length === 30 && production.length === 30
  const canonicalStatus = !canonicalSized
    ? 'non-canonical-smoke'
    : pointWithinBudget && bootstrapUpperWithinBudget
      ? 'pass'
      : bootstrap.lower95Ms > allowedRegressionMs
        ? 'fail'
        : 'inconclusive'
  return {
    authority: 'direct controller service-state Promise duration after CDP-proven worker absence',
    canonicalSized,
    canonicalStatus,
    currentP95Ms,
    productionP95Ms,
    pointRegressionMs,
    allowedRegressionMs,
    allowedRule: 'max(10% of current p95, 5ms)',
    pointWithinBudget,
    pairedBootstrapP95Delta: bootstrap,
    bootstrapUpperWithinBudget,
    provisionalUpperBoundPass: pointWithinBudget && bootstrapUpperWithinBudget,
  }
}

async function writeReport(testInfo: TestInfo, report: unknown): Promise<string> {
  const path = testInfo.outputPath(`${REPORT_KIND}.json`)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  await testInfo.attach(`${REPORT_KIND}.json`, {
    path,
    contentType: 'application/json',
  })
  return path
}

test('probes frozen current against the migrated production IDB cold read', async ({}, testInfo) => {
  test.setTimeout(PROBE_TIMEOUT_MS)
  const probeStartedAt = Date.now()
  testInfo.annotations.push({
    type: 'non-selection performance probe',
    description:
      'This paired production-validation probe cannot select or reject a backend.',
  })

  await using benchmarkBuild = await buildWorkingSetStorageBenchmarkArtifacts()
  await using productionArtifact = await makeDisposableProductionArtifact()
  const frozenCurrent = currentArtifact(benchmarkBuild.sidecar.variants)
  const cleanupErrors: string[] = []
  const collected: ColdReadSample[] = []
  const totalCycles = WARMUP_RUNS + MEASURED_RUNS
  for (let cycle = 0; cycle < totalCycles; cycle += 1) {
    const { phase, iteration } = phaseAndIteration(cycle)
    const now = Date.now()
    const profile = makeWorkingSetStorageProfile(PROFILE, now)
    invariant(profile.liveRecordCount === EXPECTED_RECORD_COUNT, 'Fixture changed record count')
    invariant(profile.eventsPerRecord === 20, 'Fixture changed events per record')
    const expectedCanonicalActivitySha256 = canonicalActivitySha256(
      profile.activity,
    )
    const order: readonly Variant[] = cycle % 2 === 0
      ? ['current-frozen', 'production-idb']
      : ['production-idb', 'current-frozen']
    for (const [orderIndex, variant] of order.entries()) {
      const extensionDirectory = variant === 'current-frozen'
        ? frozenCurrent.extensionDirectory
        : productionArtifact.directory
      const controllerPage = variant === 'current-frozen'
        ? frozenCurrent.controllerPage
        : productionArtifact.controllerPage
      collected.push(await measureFreshVariant(
        variant,
        extensionDirectory,
        controllerPage,
        phase,
        iteration,
        orderIndex,
        profile,
        expectedCanonicalActivitySha256,
        cleanupErrors,
      ))
    }
  }
  const samples: readonly ColdReadSample[] = collected
  const coldReadBudget = evaluateColdReadBudget(samples)

  const report = {
    schemaVersion: 1,
    reportKind: REPORT_KIND,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - probeStartedAt,
    canonicalSelection: false,
    verdict: null,
    warning:
      'Non-selection evidence only. This probe validates the landed production ' +
      'path against the frozen current artifact and cannot select or reject a backend.',
    methodology: {
      profile: PROFILE,
      fixedRecordCount: EXPECTED_RECORD_COUNT,
      fixedEventsPerRecord: 20,
      fixedEventCount: EXPECTED_EVENT_COUNT,
      warmupRuns: WARMUP_RUNS,
      measuredRuns: MEASURED_RUNS,
      defaultCounts: { warmupRuns: 5, measuredRuns: 30 },
      countEnvironment: {
        warmups: 'TAB_OUT_WORKING_SET_PRODUCTION_COLD_READ_WARMUPS',
        measured: 'TAB_OUT_WORKING_SET_PRODUCTION_COLD_READ_RUNS',
      },
      pairing:
        'Each cycle measures both artifacts with the exact same fixture and reverses their order on the next cycle.',
      profileIsolation:
        'Every variant/sample launches and disposes a fresh persistent Chromium profile, matching the canonical runner; only built artifact files are reused.',
      requestBoundary:
        'Controller-page performance.now around one direct normal tab-out:get-dashboard-service-state invocation. The local directInvocationCount documents the harness callsite; it is not a listener trace.',
      semanticProof:
        'After stopping the duration timer, the controller hashes the full canonical activity response and compares it with the Node-side canonical SHA-256 of that pair exact 500x20 fixture. The unmeasured setup read is proved the same way.',
      currentBoundary:
        'Frozen benchmark current artifact, owned Chrome-envelope backend, normal full dashboard service-state listener.',
      productionBoundary:
        'Unaliased and uninstrumented production extension bundle after an unmeasured legacy-to-IDB migration.',
      coldProof:
        'CDP proves the matching MV3 worker target absent before every request. A fresh production worker must read the Chrome authority marker, validate the active generation manifest/layout, and complete the full service read.',
      bootstrap: {
        repetitions: BOOTSTRAP_REPETITIONS,
        seed: BOOTSTRAP_SEED,
        method:
          'Deterministic paired resampling by measured iteration, recomputing production-current cold request p95 delta.',
      },
      selectionAuthority: false,
    },
    artifacts: {
      frozenCurrent: {
        variant: frozenCurrent.variant,
        instrumentation: frozenCurrent.instrumentation,
        selectedBackendModule: frozenCurrent.selectedBackendModule,
        moduleGraphPath: frozenCurrent.moduleGraphPath,
        hashes: frozenCurrent.hashes,
      },
      production: {
        sourceDirectory: productionExtensionDirectory,
        aliasing: false,
        instrumentation: 'none',
        inertControllerAddedOutsideRepository: PRODUCTION_CONTROLLER_PAGE,
        hashes: productionArtifact.hashes,
      },
      trackedExtensionUnchangedByBenchmarkBuild:
        benchmarkBuild.sidecar.trackedExtension,
    },
    samples,
    summaries: summarizeSamples(samples),
    browserEvidence: summarizeBrowserEvidence(samples),
    coldReadBudget,
    failures: [],
    cleanupErrors,
  }
  const reportPath = await writeReport(testInfo, report)
  console.log(JSON.stringify({
    benchmark: REPORT_KIND,
    canonicalSelection: false,
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
    reportPath,
    summaries: report.summaries,
    coldReadBudget: report.coldReadBudget,
    cleanupErrors,
  }))

  expect(cleanupErrors).toEqual([])
  expect(samples).toHaveLength((WARMUP_RUNS + MEASURED_RUNS) * 2)
  if (coldReadBudget.canonicalSized) {
    expect(coldReadBudget.canonicalStatus).toBe('pass')
  }
})
