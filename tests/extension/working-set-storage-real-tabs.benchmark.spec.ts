import { createServer, type Server } from 'node:http'
import { writeFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'

import {
  expect,
  test,
  type CDPSession,
  type Frame,
  type Page,
  type TestInfo
} from '@playwright/test'

import {
  buildWorkingSetStorageBenchmarkArtifacts,
  type WorkingSetBenchmarkArtifactSidecar
} from '../../scripts/build-working-set-storage-benchmark.js'
import type { WorkingSetBenchmarkVariant } from '../../scripts/working-set-benchmark-build-config.js'
import { chromeSupportPolicy } from '../../src/extension/chrome-support.js'
import { parseDashboardServiceStateResponse } from '../../src/extension/dashboard-service-state-schema.js'
import { DASHBOARD_SERVICE_STATE_GET_MESSAGE } from '../../src/extension/runtime-messages.js'
import {
  launchInstalledExtensionFromArtifact,
  type LaunchedInstalledExtension
} from './installed-extension.js'
import {
  attachToServiceWorkerCdp,
  terminateServiceWorkerAndProveAbsent,
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
  'idb'
] as const satisfies readonly WorkingSetBenchmarkVariant[]
const DEFAULT_TOTAL_TAB_COUNTS = [1, 50, 100, 250] as const
const FIXED_STORAGE_PROFILE = '500x20'
const TAB_CREATE_BATCH_SIZE = 25
const TAB_INVENTORY_STABILITY_MS = 250
const TAB_SETTLEMENT_TIMEOUT_MS = 60_000
const STARTUP_TRACE_KEY = '__tabOutWorkingSetRealTabsStartupTrace'

type ReportedVariant = (typeof REPORTED_VARIANTS)[number]
type TotalTabCount = (typeof DEFAULT_TOTAL_TAB_COUNTS)[number]
type SamplePhase = 'warmup' | 'measured'

interface LoopbackServer {
  readonly origin: string
  readonly close: () => Promise<void>
}

interface StartupRequestTiming {
  readonly durationMs: number
  readonly finishedAt: number
  readonly finishedAtEpochMs: number
  readonly openTabsSnapshotCount: number | null
  readonly openTabsSnapshotDiscardedCount: number | null
  readonly responseOk: boolean | null
  readonly startedAt: number
  readonly startedAtEpochMs: number
  readonly workingSetEventCount: number | null
  readonly workingSetRecordCount: number | null
}

interface StartupTrace {
  readonly headerReadyAt: number | null
  readonly latestPreHeaderRequest: StartupRequestTiming | null
  readonly preHeaderRequestCount: number
}

interface TabInventory {
  readonly totalCount: number
  readonly discardedCount: number
  readonly benchmarkLocalCount: number
  readonly benchmarkLocalDiscardedCount: number
}

interface DashboardDomCounts {
  readonly domainCardCount: number
  readonly domElementCount: number
  readonly renderedPageChipCount: number
  readonly visiblePageChipCount: number
}

interface DashboardHeapUsage {
  readonly usedSize: number
  readonly totalSize: number
  readonly embedderHeapUsedSize: number
  readonly backingStorageSize: number
}

interface SuccessfulRealTabsSample {
  readonly status: 'ok'
  readonly phase: SamplePhase
  readonly iteration: number
  readonly order: number
  readonly candidateOrderOffset: 0 | 1
  readonly variant: ReportedVariant
  readonly requestedTotalTabCount: TotalTabCount
  readonly directTabsQuery: TabInventory
  readonly openTabsSnapshotCount: number
  readonly openTabsSnapshotDiscardedCount: number
  readonly startupFrame: {
    readonly serviceStateRequestMs: number
    readonly serviceStateRequestStartedAtMs: number
    readonly serviceStateToHeaderMs: number
    readonly startupFrameReadyMs: number
    readonly wallToHeaderObservationMs: number
    readonly preHeaderServiceStateRequestCount: number
    readonly workerAbsentBeforeReload: true
  }
  readonly coldStorageReadProof: {
    readonly readInvocationCount: 1
    readonly activeTabUrlChangeCount: 0
    readonly tabActivatedCount: 0
    readonly windowFocusChangedCount: 0
    readonly tabReplacedCount: 0
    readonly workerStartedAtEpochMs: number
    readonly readStartedAtEpochMs: number
    readonly readFinishedAtEpochMs: number
    readonly readDurationMs: number
    readonly backendReadDiagnostics: WorkingSetStorageBenchmarkReadDiagnostics | null
  }
  readonly dashboardDom: DashboardDomCounts
  readonly workerHeapAfterForcedGc: ServiceWorkerHeapUsage
  readonly dashboardHeapAfterForcedGc: DashboardHeapUsage
}

interface FailedRealTabsSample {
  readonly status: 'failed'
  readonly phase: SamplePhase
  readonly iteration: number
  readonly order: number
  readonly candidateOrderOffset: 0 | 1
  readonly variant: ReportedVariant
  readonly requestedTotalTabCount: TotalTabCount
  readonly error: string
}

type RealTabsSample = SuccessfulRealTabsSample | FailedRealTabsSample

interface Distribution {
  readonly count: number
  readonly min: number
  readonly p50: number
  readonly p95: number | null
  readonly max: number
}

interface CollectedVariantSamples {
  readonly samples: readonly RealTabsSample[]
  readonly cleanupError: string | null
  readonly browser: {
    readonly userAgent: string
    readonly actualChromeMajor: number | null
    readonly declaredMinimumChromeMajor: number
    readonly matchesDeclaredMinimum: boolean
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function describeError(cause: unknown): string {
  return cause instanceof Error
    ? `${cause.name}: ${cause.message}`
    : String(cause)
}

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

function requestedTotalTabCounts(): readonly TotalTabCount[] {
  const raw = process.env.TAB_OUT_WORKING_SET_REAL_TABS_COUNTS
  if (raw === undefined) return DEFAULT_TOTAL_TAB_COUNTS
  const requested = [...new Set(raw.split(',').map((part) => Number(part.trim())))]
  if (requested.length === 0) {
    throw new Error('TAB_OUT_WORKING_SET_REAL_TABS_COUNTS cannot be empty')
  }
  for (const count of requested) {
    if (!DEFAULT_TOTAL_TAB_COUNTS.some((candidate) => candidate === count)) {
      throw new Error(
        'TAB_OUT_WORKING_SET_REAL_TABS_COUNTS must be a comma-separated ' +
        'subset of 1,50,100,250'
      )
    }
  }
  return requested.map((count) => {
    const matched = DEFAULT_TOTAL_TAB_COUNTS.find((candidate) => candidate === count)
    invariant(matched !== undefined, `Unsupported total tab count: ${String(count)}`)
    return matched
  })
}

const WARMUP_RUNS = explorationCount(
  'TAB_OUT_WORKING_SET_REAL_TABS_WARMUPS',
  1,
  0
)
const MEASURED_RUNS = explorationCount(
  'TAB_OUT_WORKING_SET_REAL_TABS_RUNS',
  5,
  1
)
const TOTAL_TAB_COUNTS = requestedTotalTabCounts()
function requestedCandidateOrderOffsets(): readonly (0 | 1)[] {
  const raw = process.env.TAB_OUT_WORKING_SET_REAL_TABS_ORDER_OFFSET
  if (raw === undefined) return [0, 1]
  const parsed = Number(raw)
  invariant(
    parsed === 0 || parsed === 1,
    'TAB_OUT_WORKING_SET_REAL_TABS_ORDER_OFFSET must be 0 or 1'
  )
  return [parsed]
}

const CANDIDATE_ORDER_OFFSETS = requestedCandidateOrderOffsets()

function phaseAndIteration(cycle: number): {
  readonly phase: SamplePhase
  readonly iteration: number
} {
  return cycle < WARMUP_RUNS
    ? { phase: 'warmup', iteration: cycle }
    : { phase: 'measured', iteration: cycle - WARMUP_RUNS }
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
    p95: values.length >= 20 ? percentile(values, 0.95) : null,
    max: Math.max(...values)
  }
}

function artifactForVariant(
  artifacts: readonly WorkingSetBenchmarkArtifactSidecar[],
  variant: ReportedVariant
): WorkingSetBenchmarkArtifactSidecar {
  const artifact = artifacts.find((candidate) => candidate.variant === variant)
  invariant(artifact !== undefined, `Build omitted ${variant} artifact`)
  return artifact
}

function requireSuccess(
  response: ReturnType<typeof parseWorkingSetStorageBenchmarkResponse>
): WorkingSetStorageBenchmarkSuccessResponse {
  if (response === null) {
    throw new Error('Real-tab controller returned an invalid response')
  }
  if (!response.ok) {
    throw new Error(
      `${response.operation} failed: ${response.error.name}: ${response.error.message}`
    )
  }
  return response
}

async function sendSuccessfulMessage(
  page: Page | Frame,
  message: WorkingSetStorageBenchmarkMessage
): Promise<WorkingSetStorageBenchmarkSuccessResponse> {
  const raw: unknown = await page.evaluate(async (request) =>
    chrome.runtime.sendMessage(request), message)
  return requireSuccess(parseWorkingSetStorageBenchmarkResponse(raw))
}

async function sendSuccessfulControllerMessage(
  page: Page,
  extensionId: string,
  controllerPage: string,
  message: WorkingSetStorageBenchmarkMessage
): Promise<WorkingSetStorageBenchmarkSuccessResponse> {
  const controllerUrl = `chrome-extension://${extensionId}/${controllerPage}`
  const frameId = 'working-set-real-tabs-controller-frame'
  await page.evaluate(async ({ id, src }) => {
    document.getElementById(id)?.remove()
    const frame = document.createElement('iframe')
    frame.id = id
    frame.hidden = true
    frame.src = src
    await new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true })
      frame.addEventListener('error', () => reject(new Error(
        'Working Set benchmark controller frame failed to load'
      )), { once: true })
      document.body.append(frame)
    })
  }, { id: frameId, src: controllerUrl })
  const controllerFrame = page.frames().find((frame) =>
    frame.url() === controllerUrl)
  invariant(controllerFrame !== undefined, 'Controller frame was not attached')
  try {
    return await sendSuccessfulMessage(controllerFrame, message)
  } finally {
    await page.evaluate((id) => document.getElementById(id)?.remove(), frameId)
  }
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
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      `<title>Example local tab ${path}</title></head>` +
      '<body><main>Example local benchmark tab</main></body></html>'
    )
  })
  const sockets = new Set<Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await listen(server)
  const address = server.address()
  invariant(address !== null && typeof address === 'object', 'Loopback server has no address')
  return {
    origin: `http://localhost:${String(address.port)}`,
    close: () => closeServer(server, sockets)
  }
}

function chromeMajorFromUserAgent(userAgent: string): number | null {
  const match = /(?:HeadlessChrome|Chrome)\/(\d+)/.exec(userAgent)
  const major = match?.[1]
  return major === undefined ? null : Number(major)
}

function parseFiniteField(value: unknown, field: string): number | null {
  if (typeof value !== 'object' || value === null) return null
  const fieldValue = Reflect.get(value, field)
  return typeof fieldValue === 'number' && Number.isFinite(fieldValue)
    ? fieldValue
    : null
}

function parseRequestTiming(value: unknown): StartupRequestTiming | null {
  const durationMs = parseFiniteField(value, 'durationMs')
  const finishedAt = parseFiniteField(value, 'finishedAt')
  const finishedAtEpochMs = parseFiniteField(value, 'finishedAtEpochMs')
  const startedAt = parseFiniteField(value, 'startedAt')
  const startedAtEpochMs = parseFiniteField(value, 'startedAtEpochMs')
  if (typeof value !== 'object' || value === null) return null
  const openTabsSnapshotCount = Reflect.get(value, 'openTabsSnapshotCount')
  const openTabsSnapshotDiscardedCount = Reflect.get(
    value,
    'openTabsSnapshotDiscardedCount'
  )
  const responseOk = Reflect.get(value, 'responseOk')
  const workingSetEventCount = Reflect.get(value, 'workingSetEventCount')
  const workingSetRecordCount = Reflect.get(value, 'workingSetRecordCount')
  if (
    durationMs === null || finishedAt === null || finishedAtEpochMs === null ||
    startedAt === null || startedAtEpochMs === null ||
    (openTabsSnapshotCount !== null &&
      (!Number.isSafeInteger(openTabsSnapshotCount) || openTabsSnapshotCount < 0)) ||
    (openTabsSnapshotDiscardedCount !== null &&
      (!Number.isSafeInteger(openTabsSnapshotDiscardedCount) ||
        openTabsSnapshotDiscardedCount < 0)) ||
    (responseOk !== null && typeof responseOk !== 'boolean') ||
    (workingSetEventCount !== null &&
      (!Number.isSafeInteger(workingSetEventCount) || workingSetEventCount < 0)) ||
    (workingSetRecordCount !== null &&
      (!Number.isSafeInteger(workingSetRecordCount) || workingSetRecordCount < 0))
  ) return null
  return {
    durationMs,
    finishedAt,
    finishedAtEpochMs,
    openTabsSnapshotCount,
    openTabsSnapshotDiscardedCount,
    responseOk,
    startedAt,
    startedAtEpochMs,
    workingSetEventCount,
    workingSetRecordCount
  }
}

function parseStartupTrace(value: unknown): StartupTrace | null {
  if (typeof value !== 'object' || value === null) return null
  const headerReadyAt = Reflect.get(value, 'headerReadyAt')
  const latestPreHeaderRequestValue = Reflect.get(value, 'latestPreHeaderRequest')
  const latestPreHeaderRequest = latestPreHeaderRequestValue === null
    ? null
    : parseRequestTiming(latestPreHeaderRequestValue)
  const preHeaderRequestCount = Reflect.get(value, 'preHeaderRequestCount')
  if (
    (headerReadyAt !== null &&
      (typeof headerReadyAt !== 'number' || !Number.isFinite(headerReadyAt))) ||
    (latestPreHeaderRequestValue !== null && latestPreHeaderRequest === null) ||
    !Number.isSafeInteger(preHeaderRequestCount) ||
    preHeaderRequestCount < 0
  ) return null
  return { headerReadyAt, latestPreHeaderRequest, preHeaderRequestCount }
}

function parseDashboardHeapUsage(value: unknown): DashboardHeapUsage {
  const usedSize = parseFiniteField(value, 'usedSize')
  const totalSize = parseFiniteField(value, 'totalSize')
  const embedderHeapUsedSize = parseFiniteField(value, 'embedderHeapUsedSize')
  const backingStorageSize = parseFiniteField(value, 'backingStorageSize')
  invariant(
    usedSize !== null && totalSize !== null &&
    embedderHeapUsedSize !== null && backingStorageSize !== null,
    'Dashboard Runtime.getHeapUsage returned invalid data'
  )
  return { usedSize, totalSize, embedderHeapUsedSize, backingStorageSize }
}

async function installStartupInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(({ messageType, traceKey }) => {
    type MutableRequestTiming = {
      durationMs: number
      finishedAt: number
      finishedAtEpochMs: number
      openTabsSnapshotCount: number | null
      openTabsSnapshotDiscardedCount: number | null
      responseOk: boolean | null
      startedAt: number
      startedAtEpochMs: number
      workingSetEventCount: number | null
      workingSetRecordCount: number | null
    }
    type MutableTrace = {
      headerReadyAt: number | null
      latestPreHeaderRequest: MutableRequestTiming | null
      preHeaderRequestCount: number
    }
    const trace: MutableTrace = {
      headerReadyAt: null,
      latestPreHeaderRequest: null,
      preHeaderRequestCount: 0
    }
    Reflect.set(globalThis, traceKey, trace)

    const runtime = globalThis.chrome?.runtime
    if (runtime?.sendMessage) {
      const originalSendMessage = runtime.sendMessage.bind(runtime)
      Reflect.set(runtime, 'sendMessage', (...args: unknown[]) => {
        const message = args.find((value) =>
          typeof value === 'object' && value !== null &&
          Reflect.get(value, 'type') === messageType)
        if (message === undefined || trace.headerReadyAt !== null) {
          return Reflect.apply(originalSendMessage, runtime, args)
        }
        const startedAt = performance.now()
        trace.preHeaderRequestCount += 1
        const result = Reflect.apply(originalSendMessage, runtime, args)
        return Promise.resolve(result).then((response) => {
          const finishedAt = performance.now()
          if (
            trace.latestPreHeaderRequest === null ||
            startedAt > trace.latestPreHeaderRequest.startedAt
          ) {
            const openTabsSnapshot = typeof response === 'object' &&
                response !== null
              ? Reflect.get(response, 'openTabsSnapshot')
              : null
            const tabs = typeof openTabsSnapshot === 'object' &&
                openTabsSnapshot !== null
              ? Reflect.get(openTabsSnapshot, 'tabs')
              : null
            const workingSetActivity = typeof response === 'object' &&
                response !== null
              ? Reflect.get(response, 'workingSetActivity')
              : null
            const records = typeof workingSetActivity === 'object' &&
                workingSetActivity !== null
              ? Reflect.get(workingSetActivity, 'records')
              : null
            const recordValues = typeof records === 'object' &&
                records !== null && !Array.isArray(records)
              ? Object.values(records)
              : null
            const eventCounts = recordValues?.map((record) => {
              if (typeof record !== 'object' || record === null) return null
              const events = Reflect.get(record, 'events')
              return Array.isArray(events) ? events.length : null
            }) ?? null
            trace.latestPreHeaderRequest = {
              durationMs: finishedAt - startedAt,
              finishedAt,
              finishedAtEpochMs: performance.timeOrigin + finishedAt,
              openTabsSnapshotCount: Array.isArray(tabs) ? tabs.length : null,
              openTabsSnapshotDiscardedCount: Array.isArray(tabs)
                ? tabs.filter((tab) =>
                    typeof tab === 'object' && tab !== null &&
                    Reflect.get(tab, 'discarded') === true
                  ).length
                : null,
              responseOk: typeof response === 'object' && response !== null &&
                  typeof Reflect.get(response, 'ok') === 'boolean'
                ? Reflect.get(response, 'ok')
                : null,
              startedAt,
              startedAtEpochMs: performance.timeOrigin + startedAt,
              workingSetEventCount: eventCounts !== null &&
                  eventCounts.every((count) => count !== null)
                ? eventCounts.reduce<number>((total, count) => total + (count ?? 0), 0)
                : null,
              workingSetRecordCount: recordValues?.length ?? null
            }
          }
          return response
        })
      })
    }

    const recordHeaderReady = (observer: MutationObserver) => {
      const header = document.querySelector('[data-tabout="header-stats"]')
      if (header === null || header.getAttribute('aria-hidden') === 'true') return
      trace.headerReadyAt ??= performance.now()
      observer.disconnect()
    }
    const observer = new MutationObserver(() => recordHeaderReady(observer))
    observer.observe(document, {
      attributes: true,
      attributeFilter: ['aria-hidden'],
      childList: true,
      subtree: true
    })
    recordHeaderReady(observer)
  }, {
    messageType: DASHBOARD_SERVICE_STATE_GET_MESSAGE,
    traceKey: STARTUP_TRACE_KEY
  })
}

async function openSingleControllerTab(
  installed: LaunchedInstalledExtension,
  artifact: WorkingSetBenchmarkArtifactSidecar
): Promise<Page> {
  const page = installed.context.pages()[0] ?? await installed.context.newPage()
  await page.goto(
    `chrome-extension://${installed.extensionId}/${artifact.controllerPage}`,
    { waitUntil: 'domcontentloaded' }
  )
  for (const candidate of installed.context.pages()) {
    if (candidate !== page) await candidate.close()
  }
  const totalCount = await page.evaluate(async () =>
    (await chrome.tabs.query({})).length)
  invariant(totalCount === 1, `Controller setup retained ${String(totalCount)} tabs`)
  await installStartupInstrumentation(page)
  return page
}

async function prepareDashboardForColdReload(
  installed: LaunchedInstalledExtension,
  dashboard: Page
): Promise<void> {
  await dashboard.goto(
    `chrome-extension://${installed.extensionId}/index.html`,
    { waitUntil: 'domcontentloaded' }
  )
  const header = dashboard.locator('[data-tabout="header-stats"]')
  await header.waitFor({ state: 'attached', timeout: 30_000 })
  await expect(header).not.toHaveAttribute('aria-hidden', 'true')
}

async function createBenchmarkTabs(
  controller: Page,
  origin: string,
  requestedTotalTabCount: TotalTabCount
): Promise<void> {
  const additionalTabCount = requestedTotalTabCount - 1
  await controller.evaluate(async ({ batchSize, count, urlOrigin }) => {
    for (let offset = 0; offset < count; offset += batchSize) {
      const batchCount = Math.min(batchSize, count - offset)
      await Promise.all(Array.from({ length: batchCount }, (_, index) =>
        chrome.tabs.create({
          active: false,
          url: `${urlOrigin}/tab/${String(offset + index).padStart(4, '0')}`
        })
      ))
    }
  }, {
    batchSize: TAB_CREATE_BATCH_SIZE,
    count: additionalTabCount,
    urlOrigin: origin
  })
  await controller.evaluate(async ({ expectedCount, stabilityMs, timeoutMs, urlOrigin }) => {
    const deadline = performance.now() + timeoutMs
    let stableSince: number | null = null
    while (performance.now() < deadline) {
      const tabs = await chrome.tabs.query({})
      const localTabs = tabs.filter((tab) =>
        (tab.url ?? tab.pendingUrl ?? '').startsWith(urlOrigin))
      const isStable =
        tabs.length === expectedCount &&
        localTabs.length === expectedCount - 1 &&
        localTabs.every((tab) => tab.status === 'complete' || tab.discarded)
      if (isStable) {
        stableSince ??= performance.now()
        if (performance.now() - stableSince >= stabilityMs) return
      } else {
        stableSince = null
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(
      `Timed out waiting for exactly ${String(expectedCount)} real Chrome tabs`
    )
  }, {
    expectedCount: requestedTotalTabCount,
    stabilityMs: TAB_INVENTORY_STABILITY_MS,
    timeoutMs: TAB_SETTLEMENT_TIMEOUT_MS,
    urlOrigin: origin
  })
}

async function awaitProductQueueBarrier(
  controller: Page,
  requestedTotalTabCount: TotalTabCount
): Promise<void> {
  const raw: unknown = await controller.evaluate(async (messageType) =>
    chrome.runtime.sendMessage({ type: messageType }),
  DASHBOARD_SERVICE_STATE_GET_MESSAGE)
  const response = parseDashboardServiceStateResponse(raw)
  invariant(response !== null, 'Product queue barrier returned invalid service state')
  invariant(
    response.openTabsSnapshot.tabs.length === requestedTotalTabCount,
    'Product queue barrier observed the wrong open-tab count'
  )
}

async function readDirectTabInventory(
  dashboard: Page,
  origin: string
): Promise<TabInventory> {
  return dashboard.evaluate(async (urlOrigin) => {
    const tabs = await chrome.tabs.query({})
    const localTabs = tabs.filter((tab) =>
      (tab.url ?? tab.pendingUrl ?? '').startsWith(urlOrigin))
    return {
      totalCount: tabs.length,
      discardedCount: tabs.filter((tab) => tab.discarded).length,
      benchmarkLocalCount: localTabs.length,
      benchmarkLocalDiscardedCount:
        localTabs.filter((tab) => tab.discarded).length
    }
  }, origin)
}

async function readDashboardDomCounts(page: Page): Promise<DashboardDomCounts> {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ))
  return page.evaluate(() => {
    const chips = [...document.querySelectorAll<HTMLElement>(
      '[data-tabout="page-chip"]'
    )]
    const visiblePageChipCount = chips.filter((chip) => {
      const style = getComputedStyle(chip)
      const bounds = chip.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        bounds.width > 0 && bounds.height > 0
    }).length
    return {
      domainCardCount: document.querySelectorAll('[data-tabout="domain-card"]').length,
      domElementCount: document.getElementsByTagName('*').length,
      renderedPageChipCount: chips.length,
      visiblePageChipCount
    }
  })
}

async function collectForcedGcHeaps(
  installed: LaunchedInstalledExtension,
  dashboard: Page,
  workerUrl: string
): Promise<{
  readonly worker: ServiceWorkerHeapUsage
  readonly dashboard: DashboardHeapUsage
}> {
  await dashboard.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ))
  const workerCdp = await attachToServiceWorkerCdp(
    installed.context,
    dashboard,
    workerUrl
  )
  let dashboardCdp: CDPSession | undefined
  try {
    dashboardCdp = await installed.context.newCDPSession(dashboard)
    await dashboardCdp.send('HeapProfiler.enable')
    await Promise.all([
      workerCdp.collectGarbage(),
      dashboardCdp.send('HeapProfiler.collectGarbage')
    ])
    const [worker, rawDashboard] = await Promise.all([
      workerCdp.getHeapUsage(),
      dashboardCdp.send('Runtime.getHeapUsage')
    ])
    return {
      worker,
      dashboard: parseDashboardHeapUsage(rawDashboard)
    }
  } finally {
    await dashboardCdp?.detach().catch(() => undefined)
    await workerCdp.detach()
  }
}

async function measureColdDashboard(
  installed: LaunchedInstalledExtension,
  dashboard: Page,
  workerUrl: string,
  controllerPage: string,
  variant: ReportedVariant,
  origin: string,
  requestedTotalTabCount: TotalTabCount,
  phase: SamplePhase,
  iteration: number,
  order: number,
  candidateOrderOffset: 0 | 1,
  now: number
): Promise<SuccessfulRealTabsSample> {
  invariant(
    dashboard.url() === `chrome-extension://${installed.extensionId}/index.html`,
    'Cold cycle must start from the already-loaded Dashboard'
  )
  const seeded = await sendSuccessfulControllerMessage(
    dashboard,
    installed.extensionId,
    controllerPage,
    {
      type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
      operation: 'seed-profile',
      profile: FIXED_STORAGE_PROFILE,
      now
    }
  )
  invariant(seeded.operation === 'seed-profile', 'Seed response changed operation')
  invariant(
    seeded.diagnostics.variant === variant,
    `${variant} artifact selected ${seeded.diagnostics.variant}`
  )
  const preColdInventory = await readDirectTabInventory(dashboard, origin)
  invariant(
    preColdInventory.totalCount === requestedTotalTabCount &&
      preColdInventory.benchmarkLocalCount === requestedTotalTabCount - 1,
    'Tab inventory changed between profile seed and cold-worker boundary'
  )
  await terminateServiceWorkerAndProveAbsent(
    installed.context,
    dashboard,
    workerUrl
  )

  const wallStartedAt = performance.now()
  await dashboard.reload({ waitUntil: 'domcontentloaded' })
  const header = dashboard.locator('[data-tabout="header-stats"]')
  await header.waitFor({ state: 'attached', timeout: 30_000 })
  await expect(header).not.toHaveAttribute('aria-hidden', 'true')
  const wallToHeaderObservationMs = Math.max(0, performance.now() - wallStartedAt)
  const rawTrace: unknown = await dashboard.evaluate((traceKey) =>
    Reflect.get(globalThis, traceKey), STARTUP_TRACE_KEY)
  const trace = parseStartupTrace(rawTrace)
  invariant(trace !== null, 'Startup Frame instrumentation returned invalid data')
  invariant(trace.headerReadyAt !== null, 'Startup Frame header publication was not observed')
  invariant(
    trace.latestPreHeaderRequest !== null,
    'Startup Frame dashboard-service-state request was not observed'
  )
  invariant(
    trace.preHeaderRequestCount === 1,
    `Expected one pre-header service-state request, observed ${String(trace.preHeaderRequestCount)}`
  )
  invariant(
    trace.latestPreHeaderRequest.responseOk === true,
    'Cold dashboard-service-state request did not return explicit success'
  )
  const openTabsSnapshotCount = trace.latestPreHeaderRequest.openTabsSnapshotCount
  const openTabsSnapshotDiscardedCount =
    trace.latestPreHeaderRequest.openTabsSnapshotDiscardedCount
  invariant(openTabsSnapshotCount !== null, 'Service response omitted openTabsSnapshot tabs')
  invariant(
    openTabsSnapshotDiscardedCount !== null,
    'Service response omitted openTabsSnapshot discarded state'
  )
  invariant(
    trace.latestPreHeaderRequest.workingSetRecordCount === 500,
    'Measured Startup Frame did not read exactly 500 Working Set records'
  )
  invariant(
    trace.latestPreHeaderRequest.workingSetEventCount === 10_000,
    'Measured Startup Frame did not read exactly 10,000 Working Set events'
  )
  const proof = await sendSuccessfulControllerMessage(
    dashboard,
    installed.extensionId,
    controllerPage,
    {
      type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
      operation: 'diagnostics'
    }
  )
  const {
    activeTabUrlChangeCount,
    lastReadFinishedAtEpochMs,
    lastReadStartedAtEpochMs,
    readInvocationCount,
    tabActivatedCount,
    tabReplacedCount,
    windowFocusChangedCount,
    workerStartedAtEpochMs
  } = proof.diagnostics
  invariant(
    readInvocationCount === 1,
    `Expected one cold storage read, observed ${String(readInvocationCount)}`
  )
  invariant(
    activeTabUrlChangeCount === 0,
    'Same-URL Dashboard reload unexpectedly reported an active URL change'
  )
  invariant(
    tabActivatedCount === 0 && windowFocusChangedCount === 0 &&
      tabReplacedCount === 0,
    'A tab activation, window focus, or tab replacement could own the cold read'
  )
  invariant(
    lastReadStartedAtEpochMs !== null && lastReadFinishedAtEpochMs !== null,
    'Storage backend omitted the cold-read timeline'
  )
  invariant(
    lastReadStartedAtEpochMs >=
      trace.latestPreHeaderRequest.startedAtEpochMs - 2,
    'Working Set storage read began before the measured service-state request'
  )
  invariant(
    lastReadFinishedAtEpochMs <=
      trace.latestPreHeaderRequest.finishedAtEpochMs + 2,
    'Working Set storage read finished after the measured service-state response'
  )
  invariant(
    lastReadStartedAtEpochMs >= workerStartedAtEpochMs,
    'Working Set storage read began before this worker instance started'
  )

  const directTabsQuery = await readDirectTabInventory(dashboard, origin)
  const dashboardDom = await readDashboardDomCounts(dashboard)
  invariant(
    directTabsQuery.totalCount === requestedTotalTabCount,
    `chrome.tabs.query returned ${String(directTabsQuery.totalCount)} tabs; ` +
    `expected ${String(requestedTotalTabCount)}`
  )
  invariant(
    directTabsQuery.benchmarkLocalCount === requestedTotalTabCount - 1,
    `chrome.tabs.query returned ${String(directTabsQuery.benchmarkLocalCount)} ` +
    `benchmark-local tabs; expected ${String(requestedTotalTabCount - 1)}`
  )
  invariant(
    openTabsSnapshotCount === directTabsQuery.totalCount,
    `openTabsSnapshot returned ${String(openTabsSnapshotCount)} tabs while ` +
    `chrome.tabs.query returned ${String(directTabsQuery.totalCount)}`
  )
  invariant(
    openTabsSnapshotDiscardedCount === directTabsQuery.discardedCount,
    'openTabsSnapshot and chrome.tabs.query disagreed on discarded tabs'
  )
  invariant(
    dashboardDom.visiblePageChipCount <= dashboardDom.renderedPageChipCount,
    'Dashboard reported more visible Page Chips than rendered Page Chips'
  )

  const heaps = await collectForcedGcHeaps(installed, dashboard, workerUrl)
  return {
    status: 'ok',
    phase,
    iteration,
    order,
    candidateOrderOffset,
    variant,
    requestedTotalTabCount,
    directTabsQuery,
    openTabsSnapshotCount,
    openTabsSnapshotDiscardedCount,
    startupFrame: {
      serviceStateRequestMs: trace.latestPreHeaderRequest.durationMs,
      serviceStateRequestStartedAtMs: trace.latestPreHeaderRequest.startedAt,
      serviceStateToHeaderMs:
        trace.headerReadyAt - trace.latestPreHeaderRequest.finishedAt,
      startupFrameReadyMs: trace.headerReadyAt,
      wallToHeaderObservationMs,
      preHeaderServiceStateRequestCount: trace.preHeaderRequestCount,
      workerAbsentBeforeReload: true
    },
    coldStorageReadProof: {
      readInvocationCount,
      activeTabUrlChangeCount,
      tabActivatedCount,
      windowFocusChangedCount,
      tabReplacedCount,
      workerStartedAtEpochMs,
      readStartedAtEpochMs: lastReadStartedAtEpochMs,
      readFinishedAtEpochMs: lastReadFinishedAtEpochMs,
      readDurationMs: Math.max(
        0,
        lastReadFinishedAtEpochMs - lastReadStartedAtEpochMs
      ),
      backendReadDiagnostics: proof.diagnostics.lastReadDiagnostics
    },
    dashboardDom,
    workerHeapAfterForcedGc: heaps.worker,
    dashboardHeapAfterForcedGc: heaps.dashboard
  }
}

async function collectVariantAtTabCount(
  artifact: WorkingSetBenchmarkArtifactSidecar,
  variant: ReportedVariant,
  requestedTotalTabCount: TotalTabCount,
  origin: string,
  order: number,
  candidateOrderOffset: 0 | 1
): Promise<CollectedVariantSamples> {
  const samples: RealTabsSample[] = []
  const installed = await launchInstalledExtensionFromArtifact(
    artifact.extensionDirectory
  )
  let collected: Omit<CollectedVariantSamples, 'cleanupError'> | undefined
  let operationError: unknown
  try {
    const workerUrl = installed.serviceWorker.url()
    const dashboard = await openSingleControllerTab(installed, artifact)
    const userAgent = await dashboard.evaluate(() => navigator.userAgent)
    const actualChromeMajor = chromeMajorFromUserAgent(userAgent)
    await createBenchmarkTabs(dashboard, origin, requestedTotalTabCount)
    await awaitProductQueueBarrier(dashboard, requestedTotalTabCount)
    await prepareDashboardForColdReload(installed, dashboard)
    const now = Date.now()
    for (let cycle = 0; cycle < WARMUP_RUNS + MEASURED_RUNS; cycle += 1) {
      const { phase, iteration } = phaseAndIteration(cycle)
      try {
        samples.push(await measureColdDashboard(
          installed,
          dashboard,
          workerUrl,
          artifact.controllerPage,
          variant,
          origin,
          requestedTotalTabCount,
          phase,
          iteration,
          order,
          candidateOrderOffset,
          now
        ))
      } catch (cause) {
        samples.push({
          status: 'failed',
          phase,
          iteration,
          order,
          candidateOrderOffset,
          variant,
          requestedTotalTabCount,
          error: describeError(cause)
        })
        break
      }
    }
    collected = {
      samples,
      browser: {
        userAgent,
        actualChromeMajor,
        declaredMinimumChromeMajor: chromeSupportPolicy.minimumMajor,
        matchesDeclaredMinimum:
          actualChromeMajor === chromeSupportPolicy.minimumMajor
      }
    }
  } catch (cause) {
    operationError = cause
  }
  let cleanupError: string | null = null
  try {
    await installed.dispose()
  } catch (cause) {
    cleanupError = describeError(cause)
  }
  if (operationError !== undefined) {
    if (cleanupError !== null) {
      throw new AggregateError(
        [operationError, new Error(cleanupError)],
        'Real-tab collection and installed-extension cleanup both failed: ' +
          `operation=${describeError(operationError)}; cleanup=${cleanupError}`
      )
    }
    throw operationError
  }
  invariant(collected !== undefined, 'Real-tab collection produced no result')
  return { ...collected, cleanupError }
}

function measuredSamples(
  samples: readonly RealTabsSample[],
  totalTabCount: TotalTabCount,
  variant: ReportedVariant
): readonly SuccessfulRealTabsSample[] {
  return samples.filter((sample): sample is SuccessfulRealTabsSample =>
    sample.status === 'ok' && sample.phase === 'measured' &&
    sample.requestedTotalTabCount === totalTabCount && sample.variant === variant)
}

function summarizeHeap(
  samples: readonly SuccessfulRealTabsSample[],
  select: (sample: SuccessfulRealTabsSample) => DashboardHeapUsage
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

function summarizeSamples(samples: readonly RealTabsSample[]) {
  return Object.fromEntries(TOTAL_TAB_COUNTS.map((totalTabCount) => [
    totalTabCount,
    Object.fromEntries(REPORTED_VARIANTS.map((variant) => {
      const measured = measuredSamples(samples, totalTabCount, variant)
      const failedCount = samples.filter((sample) =>
        sample.status === 'failed' &&
        sample.requestedTotalTabCount === totalTabCount &&
        sample.variant === variant).length
      return [variant, {
        successfulCount: measured.length,
        failedCount,
        startupFrameReadyMs: distribution(
          measured.map((sample) => sample.startupFrame.startupFrameReadyMs)
        ),
        serviceStateRequestMs: distribution(
          measured.map((sample) => sample.startupFrame.serviceStateRequestMs)
        ),
        storageReadDurationMs: distribution(
          measured.map((sample) => sample.coldStorageReadProof.readDurationMs)
        ),
        backendReadTotalMs: distribution(measured.flatMap((sample) => {
          const diagnostics = sample.coldStorageReadProof.backendReadDiagnostics
          return diagnostics === null ? [] : [diagnostics.backendReadTotalMs]
        })),
        serviceStateToHeaderMs: distribution(
          measured.map((sample) => sample.startupFrame.serviceStateToHeaderMs)
        ),
        wallToHeaderObservationMs: distribution(
          measured.map((sample) => sample.startupFrame.wallToHeaderObservationMs)
        ),
        workerHeapAfterForcedGc: summarizeHeap(
          measured,
          (sample) => sample.workerHeapAfterForcedGc
        ),
        dashboardHeapAfterForcedGc: summarizeHeap(
          measured,
          (sample) => sample.dashboardHeapAfterForcedGc
        ),
        discardedTabs: distribution(
          measured.map((sample) => sample.directTabsQuery.discardedCount)
        ),
        visiblePageChips: distribution(
          measured.map((sample) => sample.dashboardDom.visiblePageChipCount)
        ),
        domElements: distribution(
          measured.map((sample) => sample.dashboardDom.domElementCount)
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
    'working-set-storage-real-tabs-exploration.json'
  )
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  await testInfo.attach('working-set-storage-real-tabs-exploration.json', {
    path,
    contentType: 'application/json'
  })
}

test('explores cold Working Set startup across real Chrome tab counts', async ({}, testInfo) => {
  test.setTimeout(EXPLORATION_TIMEOUT_MS)
  testInfo.annotations.push({
    type: 'non-canonical exploration',
    description: 'This real-tab scaling probe records evidence but cannot select a storage backend.'
  })

  await using build = await buildWorkingSetStorageBenchmarkArtifacts({
    instrumentation: 'real-tabs'
  })
  const loopback = await startLoopbackServer()
  const samples: RealTabsSample[] = []
  const cleanupErrors: string[] = []
  let fatalError: string | null = null
  const browserEvidence: Array<{
    readonly candidateOrderOffset: 0 | 1
    readonly variant: ReportedVariant
    readonly requestedTotalTabCount: TotalTabCount
    readonly userAgent: string
    readonly actualChromeMajor: number | null
    readonly declaredMinimumChromeMajor: number
    readonly matchesDeclaredMinimum: boolean
  }> = []

  try {
    for (const candidateOrderOffset of CANDIDATE_ORDER_OFFSETS) {
      for (const [countIndex, requestedTotalTabCount] of TOTAL_TAB_COUNTS.entries()) {
        const variants = (countIndex + candidateOrderOffset) % 2 === 0
          ? REPORTED_VARIANTS
          : [...REPORTED_VARIANTS].reverse()
        for (const [order, variant] of variants.entries()) {
          console.log(JSON.stringify({
            benchmark: 'working-set-storage-real-tabs-exploration',
            stage: 'cell-start',
            candidateOrderOffset,
            requestedTotalTabCount,
            variant
          }))
          const artifact = artifactForVariant(build.sidecar.variants, variant)
          const collected = await collectVariantAtTabCount(
            artifact,
            variant,
            requestedTotalTabCount,
            loopback.origin,
            order,
            candidateOrderOffset
          )
          samples.push(...collected.samples)
          if (collected.cleanupError !== null) {
            cleanupErrors.push(
              `${variant}-${String(requestedTotalTabCount)}-offset-${String(candidateOrderOffset)}: ` +
              collected.cleanupError
            )
          }
          browserEvidence.push({
            candidateOrderOffset,
            variant,
            requestedTotalTabCount,
            ...collected.browser
          })
          console.log(JSON.stringify({
            benchmark: 'working-set-storage-real-tabs-exploration',
            stage: 'cell-complete',
            candidateOrderOffset,
            requestedTotalTabCount,
            variant,
            samples: collected.samples.length
          }))
        }
      }
    }
  } catch (cause) {
    fatalError = describeError(cause)
  } finally {
    try {
      console.log(JSON.stringify({
        benchmark: 'working-set-storage-real-tabs-exploration',
        stage: 'loopback-close'
      }))
      await loopback.close()
    } catch (cause) {
      cleanupErrors.push(`loopback-server: ${describeError(cause)}`)
    }
  }

  const failedSamples = samples.filter((sample) => sample.status === 'failed')
  const report = {
    schemaVersion: 1,
    reportKind: 'working-set-storage-real-tabs-exploration',
    generatedAt: new Date().toISOString(),
    canonicalSelection: false,
    verdict: null,
    warning:
      'Exploratory evidence only. This report does not run the canonical ' +
      'selection matrix and cannot select or reject a storage backend.',
    methodology: {
      fixedWorkingSetProfile: FIXED_STORAGE_PROFILE,
      fixedWorkingSetRecords: 500,
      fixedEventsPerRecord: 20,
      totalTabCounts: TOTAL_TAB_COUNTS,
      defaultTotalTabCounts: DEFAULT_TOTAL_TAB_COUNTS,
      totalTabCountIncludesDashboard: true,
      benchmarkLocalTabsPerCount: 'requested total minus the one Dashboard tab',
      tabCreationAuthority: 'chrome.tabs.create from the installed extension controller',
      tabCountAuthority: 'direct chrome.tabs.query({}) after Startup Frame publication',
      openTabsSnapshotAuthority:
        'openTabsSnapshot.tabs captured from the measured dashboard-service-state response',
      localhostOrigin: 'ephemeral http://localhost port with unique generic paths',
      warmupRuns: WARMUP_RUNS,
      measuredRuns: MEASURED_RUNS,
      defaultCounts: { warmupRuns: 1, measuredRuns: 5 },
      countEnvironment: {
        warmups: 'TAB_OUT_WORKING_SET_REAL_TABS_WARMUPS',
        measured: 'TAB_OUT_WORKING_SET_REAL_TABS_RUNS',
        tabCounts: 'TAB_OUT_WORKING_SET_REAL_TABS_COUNTS',
        candidateOrderOffset: 'TAB_OUT_WORKING_SET_REAL_TABS_ORDER_OFFSET'
      },
      candidateOrderOffsets: CANDIDATE_ORDER_OFFSETS,
      comparativeOrderBalanced: CANDIDATE_ORDER_OFFSETS.length === 2,
      reportedVariants: REPORTED_VARIANTS,
      builtVariants: build.sidecar.variants.map((artifact) => artifact.variant),
      omittedFromReport: ['compact', 'shards-32'],
      candidateOrdering:
        'Candidates run one browser at a time. The first candidate alternates by tab count ' +
        'and order offset. The default run executes offsets 0 and 1; an explicit single-offset ' +
        'override is smoke evidence and is not balanced comparative evidence.',
      coldBoundary:
        'Every cycle re-seeds 500x20 through a hidden authorized controller frame in an ' +
        'already-loaded Dashboard, then CDP proves the matching MV3 worker absent before a ' +
        'same-URL Dashboard reload. Each sample proves exactly one storage read occurred, ' +
        'inside the measured service-state request, ' +
        'with zero URL-change, activation, focus, or replacement events.',
      startupFrameAuthority:
        'Page-local performance.now() from reload time origin through the single ' +
        'dashboard-service-state promise and synchronous header publication.',
      percentilePolicy:
        'p95 is null below 20 samples; max remains available for exploratory tail inspection.',
      heapAuthority:
        'Runtime.getHeapUsage after HeapProfiler.collectGarbage for both the service-worker ' +
        'isolate and the Dashboard renderer.',
      countAssertions:
        'Each successful sample requires direct tabs.query and measured openTabsSnapshot ' +
        'to equal the requested total and to agree on discarded-tab count. Page Chip and ' +
        'DOM cardinality remain measured outcomes because the Dashboard tab can render.',
      canonicalMatrix: false
    },
    caveats: [
      'Loopback pages are deliberately minimal. This isolates tab cardinality but does not model renderer memory or CPU from real websites.',
      'Worker and Dashboard heap measurements cover V8/embedder/backing-store usage for those two targets, not Chrome process RSS or the aggregate memory of every tab.',
      'Forced GC establishes retained occupancy after collection; it does not describe peak allocation during Startup Frame construction.',
      'Attaching HeapProfiler adds diagnostic overhead, so heap readings are comparable probe values rather than production telemetry.',
      'The variants run sequentially to avoid holding two many-tab browsers at once. The default executes both order offsets; a forced single-offset report is not balanced comparative evidence.',
      'A smoke override that omits any default tab count or measured repetition is useful for harness validation but is not the full exploration matrix.'
    ],
    artifacts: {
      schemaVersion: build.sidecar.schemaVersion,
      createdAt: build.sidecar.createdAt,
      instrumentation: build.sidecar.instrumentation,
      trackedExtension: build.sidecar.trackedExtension,
      variants: build.sidecar.variants.map((artifact) => ({
        variant: artifact.variant,
        instrumentation: artifact.instrumentation,
        hashes: artifact.hashes,
        selectedBackendModule: artifact.selectedBackendModule
      }))
    },
    browserEvidence,
    samples,
    summaries: summarizeSamples(samples),
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
    totalTabCounts: TOTAL_TAB_COUNTS,
    candidateOrderOffsets: CANDIDATE_ORDER_OFFSETS,
    failedSamples: failedSamples.length,
    fatalError
  }))

  expect(fatalError).toBeNull()
  expect(cleanupErrors).toEqual([])
  expect(failedSamples).toEqual([])
})
