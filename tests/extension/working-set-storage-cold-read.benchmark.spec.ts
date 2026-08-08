import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'

import {
  expect,
  test,
  type Page,
  type TestInfo
} from '@playwright/test'

import {
  buildWorkingSetStorageBenchmarkArtifacts,
  type WorkingSetBenchmarkArtifactSidecar
} from '../../scripts/build-working-set-storage-benchmark.js'
import type { WorkingSetBenchmarkVariant } from '../../scripts/working-set-benchmark-build-config.js'
import { chromeSupportPolicy } from '../../src/extension/chrome-support.js'
import {
  makeWorkingSetStorageProfile,
  type WorkingSetStorageProfileName
} from '../helpers/working-set-storage-profile.js'
import {
  launchInstalledExtensionFromArtifact,
  type LaunchedInstalledExtension
} from './installed-extension.js'
import {
  attachToServiceWorkerCdp,
  terminateServiceWorkerAndProveAbsent,
  type ServiceWorkerHeapSamplingOptions,
  type ServiceWorkerHeapSamplingSummary,
  type ServiceWorkerHeapUsage
} from './service-worker-cdp.js'
import {
  parseWorkingSetStorageBenchmarkResponse,
  WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
  type WorkingSetStorageBenchmarkMessage,
  type WorkingSetStorageBenchmarkReadDiagnostics,
  type WorkingSetStorageBenchmarkSuccessResponse
} from './working-set-storage-benchmark-protocol.js'

const EXPLORATION_TIMEOUT_MS = 30 * 60_000
const REPORTED_VARIANTS = [
  'current',
  'shards-32',
  'idb'
] as const satisfies readonly WorkingSetBenchmarkVariant[]
const COLD_READ_PROFILES = [
  'empty',
  '50x20',
  '100x20',
  '250x20',
  '500x20',
  '500x1',
  '500x80',
  '250-live-250-expired'
] as const satisfies readonly WorkingSetStorageProfileName[]
const HEAP_PROFILES = [
  'empty',
  '500x20'
] as const satisfies readonly WorkingSetStorageProfileName[]
const HEAP_SAMPLING_OPTIONS: ServiceWorkerHeapSamplingOptions = {
  samplingInterval: 32_768,
  stackDepth: 128,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true
}
const READ_DIAGNOSTIC_KEYS = [
  'backendReadTotalMs',
  'openDatabaseMs',
  'expiryScanMs',
  'expiryDeleteMs',
  'retainedFetchMs',
  'decodeMaterializeMs',
  'fetchedRows',
  'validRows',
  'invalidRows',
  'fetchedEvents',
  'validEvents',
  'invalidEvents'
] as const satisfies readonly (keyof WorkingSetStorageBenchmarkReadDiagnostics)[]

type ReportedVariant = (typeof REPORTED_VARIANTS)[number]
type SamplePhase = 'warmup' | 'measured'

function explorationCount(
  environmentName: string,
  fallback: number,
  minimum: number
): number {
  const raw = process.env[environmentName]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 100) {
    throw new Error(
      `${environmentName} must be an integer from ${String(minimum)} to 100`
    )
  }
  return parsed
}

const WARMUP_RUNS = explorationCount(
  'TAB_OUT_WORKING_SET_COLD_READ_WARMUPS',
  1,
  0
)
const MEASURED_RUNS = explorationCount(
  'TAB_OUT_WORKING_SET_COLD_READ_RUNS',
  5,
  1
)

interface RunningVariant {
  readonly variant: ReportedVariant
  readonly artifact: WorkingSetBenchmarkArtifactSidecar
  readonly installed: LaunchedInstalledExtension
  readonly controller: Page
  readonly workerUrl: string
  readonly browser: {
    readonly userAgent: string
    readonly actualChromeMajor: number | null
    readonly declaredMinimumChromeMajor: number
    readonly matchesDeclaredMinimum: boolean
  }
}

interface Distribution {
  readonly count: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

interface SuccessfulColdReadSample {
  readonly status: 'ok'
  readonly phase: SamplePhase
  readonly iteration: number
  readonly order: number
  readonly variant: ReportedVariant
  readonly profile: WorkingSetStorageProfileName
  readonly controllerRoundTripMs: number
  readonly listenerToCommitMs: number
  readonly serviceReadMs: number
  readonly recordCount: number
  readonly eventCount: number
  readonly readDiagnostics: WorkingSetStorageBenchmarkReadDiagnostics | null
}

interface FailedColdReadSample {
  readonly status: 'failed'
  readonly phase: SamplePhase
  readonly iteration: number
  readonly order: number
  readonly variant: ReportedVariant
  readonly profile: WorkingSetStorageProfileName
  readonly error: string
}

type ColdReadSample = SuccessfulColdReadSample | FailedColdReadSample

interface HeapDelta {
  readonly usedSize: number
  readonly totalSize: number
  readonly embedderHeapUsedSize: number
  readonly backingStorageSize: number
}

interface SuccessfulHeapSample {
  readonly status: 'ok'
  readonly phase: SamplePhase
  readonly iteration: number
  readonly order: number
  readonly variant: ReportedVariant
  readonly profile: WorkingSetStorageProfileName
  readonly baseline: ServiceWorkerHeapUsage
  readonly afterRead: ServiceWorkerHeapUsage
  readonly afterIdle50Ms: ServiceWorkerHeapUsage
  readonly afterIdle250Ms: ServiceWorkerHeapUsage
  readonly afterForcedGc: ServiceWorkerHeapUsage
  readonly afterReadMinusBaseline: HeapDelta
  readonly afterIdle50MsMinusBaseline: HeapDelta
  readonly afterIdle250MsMinusBaseline: HeapDelta
  readonly afterForcedGcMinusBaseline: HeapDelta
  readonly sampling: ServiceWorkerHeapSamplingSummary
  readonly instrumentedServiceReadMs: number
  readonly readDiagnostics: WorkingSetStorageBenchmarkReadDiagnostics | null
}

interface FailedHeapSample {
  readonly status: 'failed'
  readonly phase: SamplePhase
  readonly iteration: number
  readonly order: number
  readonly variant: ReportedVariant
  readonly profile: WorkingSetStorageProfileName
  readonly error: string
}

type HeapSample = SuccessfulHeapSample | FailedHeapSample

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function describeError(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)
}

function chromeMajorFromUserAgent(userAgent: string): number | null {
  const match = /(?:HeadlessChrome|Chrome)\/(\d+)/.exec(userAgent)
  const major = match?.[1]
  return major === undefined ? null : Number(major)
}

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
    max: Math.max(...values)
  }
}

function phaseAndIteration(cycle: number): {
  readonly phase: SamplePhase
  readonly iteration: number
} {
  return cycle < WARMUP_RUNS
    ? { phase: 'warmup', iteration: cycle }
    : { phase: 'measured', iteration: cycle - WARMUP_RUNS }
}

function alternatingOrder(
  running: readonly RunningVariant[],
  cycle: number
): readonly RunningVariant[] {
  const rotation = Math.floor(cycle / 2) % REPORTED_VARIANTS.length
  const rotated = [
    ...REPORTED_VARIANTS.slice(rotation),
    ...REPORTED_VARIANTS.slice(0, rotation)
  ]
  const orderedVariants = cycle % 2 === 0 ? rotated : [...rotated].reverse()
  return orderedVariants.map((variant) => {
    const candidate = running.find((entry) => entry.variant === variant)
    invariant(candidate !== undefined, `No running artifact exists for ${variant}`)
    return candidate
  })
}

function requireSuccess(
  response: ReturnType<typeof parseWorkingSetStorageBenchmarkResponse>
): WorkingSetStorageBenchmarkSuccessResponse {
  if (response === null) {
    throw new Error('Cold-read controller returned an invalid response')
  }
  if (!response.ok) {
    throw new Error(
      `${response.operation} failed: ${response.error.name}: ${response.error.message}`
    )
  }
  return response
}

async function sendSuccessfulMessage(
  controller: Page,
  message: WorkingSetStorageBenchmarkMessage
): Promise<WorkingSetStorageBenchmarkSuccessResponse> {
  const raw: unknown = await controller.evaluate(async (request) =>
    chrome.runtime.sendMessage(request), message)
  return requireSuccess(parseWorkingSetStorageBenchmarkResponse(raw))
}

function artifactForVariant(
  artifacts: readonly WorkingSetBenchmarkArtifactSidecar[],
  variant: ReportedVariant
): WorkingSetBenchmarkArtifactSidecar {
  const artifact = artifacts.find((candidate) => candidate.variant === variant)
  invariant(artifact !== undefined, `Build omitted ${variant} artifact`)
  return artifact
}

async function launchVariant(
  artifact: WorkingSetBenchmarkArtifactSidecar,
  variant: ReportedVariant
): Promise<RunningVariant> {
  const installed = await launchInstalledExtensionFromArtifact(
    artifact.extensionDirectory
  )
  try {
    const controller = await installed.context.newPage()
    await controller.goto(
      `chrome-extension://${installed.extensionId}/${artifact.controllerPage}`,
      { waitUntil: 'domcontentloaded' }
    )
    const userAgent = await controller.evaluate(() => navigator.userAgent)
    const actualChromeMajor = chromeMajorFromUserAgent(userAgent)
    return {
      variant,
      artifact,
      installed,
      controller,
      workerUrl: installed.serviceWorker.url(),
      browser: {
        userAgent,
        actualChromeMajor,
        declaredMinimumChromeMajor: chromeSupportPolicy.minimumMajor,
        matchesDeclaredMinimum:
          actualChromeMajor === chromeSupportPolicy.minimumMajor
      }
    }
  } catch (cause) {
    await installed.dispose().catch(() => undefined)
    throw cause
  }
}

async function seedProfile(
  candidate: RunningVariant,
  profile: WorkingSetStorageProfileName,
  now: number
): Promise<void> {
  const response = await sendSuccessfulMessage(candidate.controller, {
    type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
    operation: 'seed-profile',
    profile,
    now
  })
  invariant(response.operation === 'seed-profile', 'Seed response changed operation')
  invariant(
    response.diagnostics.variant === candidate.variant,
    `${candidate.variant} artifact selected ${response.diagnostics.variant}`
  )
}

function countEvents(
  activity: WorkingSetStorageBenchmarkSuccessResponse['activity']
): number {
  invariant(activity !== undefined, 'Service read returned no activity')
  return Object.values(activity.records).reduce(
    (total, record) => total + record.events.length,
    0
  )
}

async function measureColdRead(
  candidate: RunningVariant,
  profileName: WorkingSetStorageProfileName,
  phase: SamplePhase,
  iteration: number,
  order: number,
  now: number
): Promise<SuccessfulColdReadSample> {
  await seedProfile(candidate, profileName, now)
  await terminateServiceWorkerAndProveAbsent(
    candidate.installed.context,
    candidate.controller,
    candidate.workerUrl
  )
  const startedAt = performance.now()
  const response = await sendSuccessfulMessage(candidate.controller, {
    type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
    operation: 'service-read'
  })
  const controllerRoundTripMs = Math.max(0, performance.now() - startedAt)
  invariant(response.operation === 'service-read', 'Cold read changed operation')
  invariant(
    response.diagnostics.variant === candidate.variant,
    `${candidate.variant} artifact selected ${response.diagnostics.variant}`
  )
  const serviceReadMs = response.timings.serviceReadMs
  invariant(serviceReadMs !== undefined, 'Service read omitted serviceReadMs')
  const profile = makeWorkingSetStorageProfile(profileName, now)
  const activity = response.activity
  invariant(activity !== undefined, 'Service read returned no activity')
  const recordCount = Object.keys(activity.records).length
  const eventCount = countEvents(activity)
  invariant(
    recordCount === profile.liveRecordCount,
    `${candidate.variant}/${profileName} retained ${String(recordCount)} records; ` +
    `expected ${String(profile.liveRecordCount)}`
  )
  invariant(
    eventCount === profile.liveRecordCount * profile.eventsPerRecord,
    `${candidate.variant}/${profileName} retained ${String(eventCount)} events; ` +
    `expected ${String(profile.liveRecordCount * profile.eventsPerRecord)}`
  )
  return {
    status: 'ok',
    phase,
    iteration,
    order,
    variant: candidate.variant,
    profile: profileName,
    controllerRoundTripMs,
    listenerToCommitMs: response.timings.listenerToCommitMs,
    serviceReadMs,
    recordCount,
    eventCount,
    readDiagnostics: response.diagnostics.lastReadDiagnostics
  }
}

function heapDelta(
  measurement: ServiceWorkerHeapUsage,
  baseline: ServiceWorkerHeapUsage
): HeapDelta {
  return {
    usedSize: measurement.usedSize - baseline.usedSize,
    totalSize: measurement.totalSize - baseline.totalSize,
    embedderHeapUsedSize:
      measurement.embedderHeapUsedSize - baseline.embedderHeapUsedSize,
    backingStorageSize:
      measurement.backingStorageSize - baseline.backingStorageSize
  }
}

async function measureHeap(
  candidate: RunningVariant,
  profileName: WorkingSetStorageProfileName,
  phase: SamplePhase,
  iteration: number,
  order: number,
  now: number
): Promise<SuccessfulHeapSample> {
  await seedProfile(candidate, profileName, now)
  await terminateServiceWorkerAndProveAbsent(
    candidate.installed.context,
    candidate.controller,
    candidate.workerUrl
  )
  await sendSuccessfulMessage(candidate.controller, {
    type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
    operation: 'wake-only'
  })
  const cdp = await attachToServiceWorkerCdp(
    candidate.installed.context,
    candidate.controller,
    candidate.workerUrl
  )
  let samplingStarted = false
  try {
    await cdp.collectGarbage()
    const baseline = await cdp.getHeapUsage()
    await cdp.startSampling(HEAP_SAMPLING_OPTIONS)
    samplingStarted = true
    const response = await sendSuccessfulMessage(candidate.controller, {
      type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
      operation: 'service-read'
    })
    invariant(response.operation === 'service-read', 'Heap read changed operation')
    invariant(
      response.diagnostics.variant === candidate.variant,
      `${candidate.variant} artifact selected ${response.diagnostics.variant}`
    )
    const instrumentedServiceReadMs = response.timings.serviceReadMs
    invariant(
      instrumentedServiceReadMs !== undefined,
      'Instrumented service read omitted serviceReadMs'
    )
    const profile = makeWorkingSetStorageProfile(profileName, now)
    const activity = response.activity
    invariant(activity !== undefined, 'Heap service read returned no activity')
    invariant(
      Object.keys(activity.records).length === profile.liveRecordCount,
      `${candidate.variant}/${profileName} heap read returned the wrong record count`
    )
    const afterRead = await cdp.getHeapUsage()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const afterIdle50Ms = await cdp.getHeapUsage()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const afterIdle250Ms = await cdp.getHeapUsage()
    await cdp.collectGarbage()
    const afterForcedGc = await cdp.getHeapUsage()
    const sampling = await cdp.stopSampling()
    samplingStarted = false
    return {
      status: 'ok',
      phase,
      iteration,
      order,
      variant: candidate.variant,
      profile: profileName,
      baseline,
      afterRead,
      afterIdle50Ms,
      afterIdle250Ms,
      afterForcedGc,
      afterReadMinusBaseline: heapDelta(afterRead, baseline),
      afterIdle50MsMinusBaseline: heapDelta(afterIdle50Ms, baseline),
      afterIdle250MsMinusBaseline: heapDelta(afterIdle250Ms, baseline),
      afterForcedGcMinusBaseline: heapDelta(afterForcedGc, baseline),
      sampling,
      instrumentedServiceReadMs,
      readDiagnostics: response.diagnostics.lastReadDiagnostics
    }
  } finally {
    if (samplingStarted) await cdp.stopSampling().catch(() => undefined)
    await cdp.detach()
  }
}

async function collectColdReadSamples(
  running: readonly RunningVariant[]
): Promise<readonly ColdReadSample[]> {
  const samples: ColdReadSample[] = []
  const totalRuns = WARMUP_RUNS + MEASURED_RUNS
  for (const profile of COLD_READ_PROFILES) {
    const now = Date.now()
    for (let cycle = 0; cycle < totalRuns; cycle += 1) {
      const { phase, iteration } = phaseAndIteration(cycle)
      const ordered = alternatingOrder(running, cycle)
      for (const [order, candidate] of ordered.entries()) {
        try {
          samples.push(await measureColdRead(
            candidate,
            profile,
            phase,
            iteration,
            order,
            now
          ))
        } catch (cause) {
          samples.push({
            status: 'failed',
            phase,
            iteration,
            order,
            variant: candidate.variant,
            profile,
            error: describeError(cause)
          })
        }
      }
    }
  }
  return samples
}

async function collectHeapSamples(
  running: readonly RunningVariant[]
): Promise<readonly HeapSample[]> {
  const samples: HeapSample[] = []
  const totalRuns = WARMUP_RUNS + MEASURED_RUNS
  for (const profile of HEAP_PROFILES) {
    const now = Date.now()
    for (let cycle = 0; cycle < totalRuns; cycle += 1) {
      const { phase, iteration } = phaseAndIteration(cycle)
      const ordered = alternatingOrder(running, cycle)
      for (const [order, candidate] of ordered.entries()) {
        try {
          samples.push(await measureHeap(
            candidate,
            profile,
            phase,
            iteration,
            order,
            now
          ))
        } catch (cause) {
          samples.push({
            status: 'failed',
            phase,
            iteration,
            order,
            variant: candidate.variant,
            profile,
            error: describeError(cause)
          })
        }
      }
    }
  }
  return samples
}

function measuredColdSamples(
  samples: readonly ColdReadSample[],
  profile: WorkingSetStorageProfileName,
  variant: ReportedVariant
): readonly SuccessfulColdReadSample[] {
  return samples.filter((sample): sample is SuccessfulColdReadSample =>
    sample.status === 'ok' &&
    sample.phase === 'measured' &&
    sample.profile === profile &&
    sample.variant === variant)
}

function measuredHeapSamples(
  samples: readonly HeapSample[],
  profile: WorkingSetStorageProfileName,
  variant: ReportedVariant
): readonly SuccessfulHeapSample[] {
  return samples.filter((sample): sample is SuccessfulHeapSample =>
    sample.status === 'ok' &&
    sample.phase === 'measured' &&
    sample.profile === profile &&
    sample.variant === variant)
}

function summarizeReadDiagnostics(
  samples: readonly SuccessfulColdReadSample[]
) {
  return Object.fromEntries(READ_DIAGNOSTIC_KEYS.map((key) => [
    key,
    distribution(samples.flatMap((sample) => {
      const diagnostics = sample.readDiagnostics
      return diagnostics === null ? [] : [diagnostics[key]]
    }))
  ]))
}

function summarizeColdReads(samples: readonly ColdReadSample[]) {
  return Object.fromEntries(COLD_READ_PROFILES.map((profile) => [
    profile,
    Object.fromEntries(REPORTED_VARIANTS.map((variant) => {
      const measured = measuredColdSamples(samples, profile, variant)
      const failedCount = samples.filter((sample) =>
        sample.status === 'failed' &&
        sample.phase === 'measured' &&
        sample.profile === profile &&
        sample.variant === variant).length
      return [variant, {
        successfulCount: measured.length,
        failedCount,
        controllerRoundTripMs: distribution(
          measured.map((sample) => sample.controllerRoundTripMs)
        ),
        listenerToCommitMs: distribution(
          measured.map((sample) => sample.listenerToCommitMs)
        ),
        serviceReadMs: distribution(
          measured.map((sample) => sample.serviceReadMs)
        ),
        backendReadDiagnostics: summarizeReadDiagnostics(measured)
      }]
    }))
  ]))
}

function summarizeHeapUsage(
  samples: readonly SuccessfulHeapSample[],
  select: (sample: SuccessfulHeapSample) => ServiceWorkerHeapUsage | HeapDelta
) {
  return {
    usedSize: distribution(samples.map((sample) => select(sample).usedSize)),
    totalSize: distribution(samples.map((sample) => select(sample).totalSize)),
    embedderHeapUsedSize: distribution(
      samples.map((sample) => select(sample).embedderHeapUsedSize)
    ),
    backingStorageSize: distribution(
      samples.map((sample) => select(sample).backingStorageSize)
    )
  }
}

function summarizeHeap(samples: readonly HeapSample[]) {
  return Object.fromEntries(HEAP_PROFILES.map((profile) => [
    profile,
    Object.fromEntries(REPORTED_VARIANTS.map((variant) => {
      const measured = measuredHeapSamples(samples, profile, variant)
      const failedCount = samples.filter((sample) =>
        sample.status === 'failed' &&
        sample.phase === 'measured' &&
        sample.profile === profile &&
        sample.variant === variant).length
      return [variant, {
        successfulCount: measured.length,
        failedCount,
        baseline: summarizeHeapUsage(measured, (sample) => sample.baseline),
        afterRead: summarizeHeapUsage(measured, (sample) => sample.afterRead),
        afterIdle50Ms: summarizeHeapUsage(
          measured,
          (sample) => sample.afterIdle50Ms
        ),
        afterIdle250Ms: summarizeHeapUsage(
          measured,
          (sample) => sample.afterIdle250Ms
        ),
        afterForcedGc: summarizeHeapUsage(
          measured,
          (sample) => sample.afterForcedGc
        ),
        afterReadMinusBaseline: summarizeHeapUsage(
          measured,
          (sample) => sample.afterReadMinusBaseline
        ),
        afterIdle50MsMinusBaseline: summarizeHeapUsage(
          measured,
          (sample) => sample.afterIdle50MsMinusBaseline
        ),
        afterIdle250MsMinusBaseline: summarizeHeapUsage(
          measured,
          (sample) => sample.afterIdle250MsMinusBaseline
        ),
        afterForcedGcMinusBaseline: summarizeHeapUsage(
          measured,
          (sample) => sample.afterForcedGcMinusBaseline
        ),
        sampledBytes: distribution(
          measured.map((sample) => sample.sampling.sampledBytes)
        ),
        sampleCount: distribution(
          measured.map((sample) => sample.sampling.sampleCount)
        )
      }]
    }))
  ]))
}

async function writeAndAttachReport(
  testInfo: TestInfo,
  report: unknown
): Promise<void> {
  const path = testInfo.outputPath(
    'working-set-storage-cold-read-exploration.json'
  )
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  await testInfo.attach('working-set-storage-cold-read-exploration.json', {
    path,
    contentType: 'application/json'
  })
}

test('explores cold Working Set reads without selecting a backend', async ({}, testInfo) => {
  test.setTimeout(EXPLORATION_TIMEOUT_MS)
  testInfo.annotations.push({
    type: 'non-canonical exploration',
    description: 'This benchmark records evidence but cannot select a storage backend.'
  })

  await using build = await buildWorkingSetStorageBenchmarkArtifacts()
  const running: RunningVariant[] = []
  const cleanupErrors: string[] = []
  let coldReadSamples: readonly ColdReadSample[] = []
  let heapSamples: readonly HeapSample[] = []
  let fatalError: string | null = null

  try {
    for (const variant of REPORTED_VARIANTS) {
      running.push(await launchVariant(
        artifactForVariant(build.sidecar.variants, variant),
        variant
      ))
    }
    coldReadSamples = await collectColdReadSamples(running)
    heapSamples = await collectHeapSamples(running)
  } catch (cause) {
    fatalError = describeError(cause)
  } finally {
    for (const candidate of [...running].reverse()) {
      try {
        await candidate.installed.dispose()
      } catch (cause) {
        cleanupErrors.push(`${candidate.variant}: ${describeError(cause)}`)
      }
    }
  }

  const failedSamples = [
    ...coldReadSamples.filter((sample) => sample.status === 'failed'),
    ...heapSamples.filter((sample) => sample.status === 'failed')
  ]
  const report = {
    schemaVersion: 1,
    reportKind: 'working-set-storage-cold-read-exploration',
    generatedAt: new Date().toISOString(),
    canonicalSelection: false,
    verdict: null,
    warning:
      'Exploratory evidence only. This report does not run the canonical ' +
      'selection matrix and cannot select or reject a storage backend.',
    methodology: {
      warmupRuns: WARMUP_RUNS,
      measuredRuns: MEASURED_RUNS,
      defaultCounts: { warmupRuns: 1, measuredRuns: 5 },
      countEnvironment: {
        warmups: 'TAB_OUT_WORKING_SET_COLD_READ_WARMUPS',
        measured: 'TAB_OUT_WORKING_SET_COLD_READ_RUNS'
      },
      builtVariants: build.sidecar.variants.map((artifact) => artifact.variant),
      reportedVariants: REPORTED_VARIANTS,
      omittedFromReport: ['compact'],
      coldProfiles: COLD_READ_PROFILES,
      heapProfiles: HEAP_PROFILES,
      ordering:
        'Each adjacent run reverses the order; each pair rotates the first ' +
        'variant so every permutation appears over six runs.',
      coldBoundary:
        'Each measurement re-seeds its profile, then CDP proves the matching ' +
        'MV3 service-worker target absent before service-read. Re-seeding keeps ' +
        'the expiry workload identical across runs.',
      latencyAuthority:
        'Controller wall time plus listener and service-read timings from the installed extension.',
      heapAuthority:
        'Runtime.getHeapUsage for the service-worker V8 isolate through a nested CDP target session.',
      heapSequence:
        'wake-only; attach; forced GC; baseline; start sampling; service-read; ' +
        'immediate heap; 50ms natural-idle heap; 250ms cumulative natural-idle ' +
        'heap; forced GC; retained heap; stop sampling.',
      heapSamplingOptions: HEAP_SAMPLING_OPTIONS,
      heapCaveat:
        'Heap data is isolate JS/embedder/backing-store usage, not whole-browser ' +
        'RSS. Instrumented service-read timings are excluded from latency summaries.',
      realTabScaling: false
    },
    artifacts: {
      schemaVersion: build.sidecar.schemaVersion,
      createdAt: build.sidecar.createdAt,
      trackedExtension: build.sidecar.trackedExtension,
      variants: build.sidecar.variants.map((artifact) => ({
        variant: artifact.variant,
        hashes: artifact.hashes,
        selectedBackendModule: artifact.selectedBackendModule
      }))
    },
    browserEvidence: running.map((candidate) => ({
      variant: candidate.variant,
      browser: candidate.browser
    })),
    coldReadSamples,
    coldReadSummaries: summarizeColdReads(coldReadSamples),
    heapSamples,
    heapSummaries: summarizeHeap(heapSamples),
    failures: {
      fatalError,
      cleanupErrors,
      failedSamples
    }
  }

  await writeAndAttachReport(testInfo, report)
  console.log(JSON.stringify({
    benchmark: report.reportKind,
    canonicalSelection: false,
    failedSamples: failedSamples.length,
    fatalError
  }))

  expect(fatalError).toBeNull()
  expect(cleanupErrors).toEqual([])
  expect(failedSamples).toEqual([])
})
