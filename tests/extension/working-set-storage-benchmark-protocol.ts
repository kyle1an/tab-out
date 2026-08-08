import { Schema } from 'effect'

import type { ChromeApi } from '../../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStore } from '../../src/extension/types'
import { workingSetStorageProfileNameSchema } from '../helpers/working-set-storage-profile.js'

export const WORKING_SET_STORAGE_BENCHMARK_MESSAGE =
  '__TAB_OUT_WORKING_SET_STORAGE_BENCHMARK__'

const nonNegativeIntSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0)
)
const nonNegativeFiniteSchema = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0)
)
const nonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1))

const activityEventSchema = Schema.Struct({
  kind: Schema.Literals(['activation', 'navigation']),
  at: Schema.Finite
})

const activityRecordSchema = Schema.Struct({
  key: Schema.String,
  url: Schema.String,
  title: Schema.String,
  domain: Schema.String,
  lastSeenAt: Schema.Finite,
  lastActivatedAt: Schema.optionalKey(Schema.Finite),
  lastNavigatedAt: Schema.optionalKey(Schema.Finite),
  dismissedAt: Schema.optionalKey(Schema.Finite),
  dismissedUntil: Schema.optionalKey(Schema.Finite),
  events: Schema.mutable(Schema.Array(activityEventSchema))
})

export const workingSetActivityStoreMessageSchema = Schema.Struct({
  version: Schema.Literals([1]),
  records: Schema.Record(Schema.String, activityRecordSchema)
}) satisfies Schema.Schema<WorkingSetActivityStore>

export const workingSetStorageBenchmarkEventSchema = Schema.Struct({
  kind: Schema.Literals(['activation', 'navigation']),
  at: Schema.Finite,
  tabId: nonNegativeIntSchema,
  windowId: Schema.Int,
  url: nonEmptyStringSchema,
  title: Schema.String
})

export type WorkingSetStorageBenchmarkEvent =
  typeof workingSetStorageBenchmarkEventSchema.Type

const benchmarkOperationSchema = Schema.Literals([
  'seed-profile',
  'replace',
  'storage-read',
  'service-read',
  'domain-mutation',
  'storage-mutation',
  'navigation',
  'burst',
  'fail-next-mutation',
  'corrupt',
  'reset',
  'diagnostics'
])

export type WorkingSetStorageBenchmarkOperation =
  typeof benchmarkOperationSchema.Type

const seedProfileMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['seed-profile']),
  profile: workingSetStorageProfileNameSchema,
  now: Schema.Finite
})

const replaceMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['replace']),
  activity: workingSetActivityStoreMessageSchema
})

const storageReadMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['storage-read'])
})

const serviceReadMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['service-read'])
})

const domainMutationMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['domain-mutation']),
  event: workingSetStorageBenchmarkEventSchema
})

const storageMutationMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['storage-mutation']),
  event: workingSetStorageBenchmarkEventSchema
})

const navigationMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['navigation']),
  event: workingSetStorageBenchmarkEventSchema
})

const burstMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['burst']),
  events: Schema.mutable(Schema.Array(workingSetStorageBenchmarkEventSchema))
})

const resetMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['reset'])
})

const failNextMutationMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['fail-next-mutation'])
})

export const workingSetStorageBenchmarkCorruptionSchema = Schema.Literals([
  'row',
  'outer-version',
  'missing-required-store'
])

export type WorkingSetStorageBenchmarkCorruption =
  typeof workingSetStorageBenchmarkCorruptionSchema.Type

const corruptMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['corrupt']),
  corruption: workingSetStorageBenchmarkCorruptionSchema
})

const diagnosticsMessageSchema = Schema.Struct({
  type: Schema.Literals([WORKING_SET_STORAGE_BENCHMARK_MESSAGE]),
  operation: Schema.Literals(['diagnostics'])
})

export const workingSetStorageBenchmarkMessageSchema = Schema.Union([
  seedProfileMessageSchema,
  replaceMessageSchema,
  storageReadMessageSchema,
  serviceReadMessageSchema,
  domainMutationMessageSchema,
  storageMutationMessageSchema,
  navigationMessageSchema,
  burstMessageSchema,
  failNextMutationMessageSchema,
  corruptMessageSchema,
  resetMessageSchema,
  diagnosticsMessageSchema
])

export type WorkingSetStorageBenchmarkMessage =
  typeof workingSetStorageBenchmarkMessageSchema.Type

export type WorkingSetStorageBenchmarkOwnedStorage =
  | {
      readonly kind: 'chrome-storage'
      readonly keys: readonly string[]
    }
  | {
      readonly kind: 'indexed-db'
      readonly database: string
      readonly objectStores: readonly string[]
    }

export interface WorkingSetStorageBenchmarkBackend {
  readonly variant: string
  readonly ownedStorage: WorkingSetStorageBenchmarkOwnedStorage
  readonly lastMutationLogicalBytes: () => number
  readonly lastMutationPhysicalWrites: () => readonly string[]
  readonly writeInvocationCount: () => number
  readonly failNextMutation: () => void
  readonly corrupt: (
    kind: WorkingSetStorageBenchmarkCorruption,
    chromeApi: ChromeApi
  ) => Promise<void>
  readonly reset: (chromeApi: ChromeApi) => Promise<void>
  readonly close: () => void | Promise<void>
}

const ownedChromeStorageSchema = Schema.Struct({
  kind: Schema.Literals(['chrome-storage']),
  keys: Schema.Array(Schema.String)
})

const ownedIndexedDbStorageSchema = Schema.Struct({
  kind: Schema.Literals(['indexed-db']),
  database: nonEmptyStringSchema,
  objectStores: Schema.Array(nonEmptyStringSchema)
})

export const workingSetStorageBenchmarkDiagnosticsSchema = Schema.Struct({
  variant: nonEmptyStringSchema,
  ownedStorage: Schema.Union([
    ownedChromeStorageSchema,
    ownedIndexedDbStorageSchema
  ]),
  lastMutationLogicalBytes: nonNegativeFiniteSchema,
  lastMutationPhysicalWrites: Schema.Array(Schema.String),
  writeInvocationCount: nonNegativeIntSchema
})

export type WorkingSetStorageBenchmarkDiagnostics =
  typeof workingSetStorageBenchmarkDiagnosticsSchema.Type

const timingsSchema = Schema.Struct({
  listenerToCommitMs: nonNegativeFiniteSchema,
  domainMutationMs: Schema.optionalKey(nonNegativeFiniteSchema),
  storageCommitMs: Schema.optionalKey(nonNegativeFiniteSchema),
  storageReadMs: Schema.optionalKey(nonNegativeFiniteSchema),
  serviceReadMs: Schema.optionalKey(nonNegativeFiniteSchema),
  fullAppMutationMs: Schema.optionalKey(nonNegativeFiniteSchema)
})

export type WorkingSetStorageBenchmarkTimings = typeof timingsSchema.Type

const successResponseSchema = Schema.Struct({
  ok: Schema.Literals([true]),
  operation: benchmarkOperationSchema,
  timings: timingsSchema,
  diagnostics: workingSetStorageBenchmarkDiagnosticsSchema,
  activity: Schema.optionalKey(workingSetActivityStoreMessageSchema)
})

const failureResponseSchema = Schema.Struct({
  ok: Schema.Literals([false]),
  operation: benchmarkOperationSchema,
  listenerToFailureMs: nonNegativeFiniteSchema,
  error: Schema.Struct({
    name: nonEmptyStringSchema,
    message: nonEmptyStringSchema
  })
})

export type WorkingSetStorageBenchmarkSuccessResponse =
  typeof successResponseSchema.Type
export type WorkingSetStorageBenchmarkFailureResponse =
  typeof failureResponseSchema.Type

export const workingSetStorageBenchmarkResponseSchema = Schema.Union([
  successResponseSchema,
  failureResponseSchema
])

export type WorkingSetStorageBenchmarkResponse =
  typeof workingSetStorageBenchmarkResponseSchema.Type

const isWorkingSetStorageBenchmarkMessage = Schema.is(
  workingSetStorageBenchmarkMessageSchema
)
const isWorkingSetStorageBenchmarkResponse = Schema.is(
  workingSetStorageBenchmarkResponseSchema
)

export function parseWorkingSetStorageBenchmarkMessage(
  value: unknown
): WorkingSetStorageBenchmarkMessage | null {
  return isWorkingSetStorageBenchmarkMessage(value) ? value : null
}

export function parseWorkingSetStorageBenchmarkResponse(
  value: unknown
): WorkingSetStorageBenchmarkResponse | null {
  return isWorkingSetStorageBenchmarkResponse(value) ? value : null
}
