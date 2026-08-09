import { Schema } from 'effect'

import {
  emptyWorkingSetActivity,
  parseWorkingSetActivityStorageValue,
} from '../working-set.js'
import type { WorkingSetActivityStore } from '../types'
import type {
  WorkingSetActivityStorageBackend,
  WorkingSetActivityWrite,
} from './working-set-activity-storage.js'

export const WORKING_SET_ACTIVITY_AUTHORITY_KEY =
  'tab-out:working-set-activity-authority'
export const WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION = 1

const WORKING_SET_ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const sha256HexSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/),
)
const generationSchema = Schema.String.check(
  Schema.isPattern(/^v1:[0-9a-f]{64}$/),
)
const nonNegativeIntSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
)
const nonNegativeFiniteSchema = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
)

const workingSetActivityGenerationManifestFields = {
  schemaVersion: Schema.Literals([
    WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
  ]),
  generation: generationSchema,
  sourceDigest: sha256HexSchema,
  recordCount: nonNegativeIntSchema,
  eventCount: nonNegativeIntSchema,
  retainedAfter: Schema.Finite,
} as const

export const workingSetActivityGenerationManifestSchema = Schema.Struct(
  workingSetActivityGenerationManifestFields,
)

export const workingSetActivityAuthorityMarkerSchema = Schema.Struct({
  version: Schema.Literals([1]),
  backend: Schema.Literals(['idb']),
  ...workingSetActivityGenerationManifestFields,
  cutoverAt: nonNegativeFiniteSchema,
})

export type WorkingSetActivityAuthorityMarker =
  typeof workingSetActivityAuthorityMarkerSchema.Type

export type WorkingSetActivityGenerationManifest =
  typeof workingSetActivityGenerationManifestSchema.Type

export interface WorkingSetActivityChromeAuthorityPort {
  readonly readMarker: () => PromiseLike<unknown>
  readonly writeMarker: (
    marker: WorkingSetActivityAuthorityMarker,
  ) => PromiseLike<void>
  readonly readLegacy: () => PromiseLike<unknown>
}

/**
 * The physical IndexedDB module implements this generation-aware port. Every
 * method validates the supplied manifest before treating rows as authoritative.
 * `verify` is the stricter cutover read: it reopens the database, decodes every
 * target row, and rejects any skipped row or event.
 */
export interface WorkingSetActivityIndexedDbAuthorityPort {
  readonly stage: (
    manifest: WorkingSetActivityGenerationManifest,
    activity: WorkingSetActivityStore,
  ) => PromiseLike<void>
  readonly verify: (
    manifest: WorkingSetActivityGenerationManifest,
  ) => PromiseLike<WorkingSetActivityStore>
  readonly read: (
    manifest: WorkingSetActivityGenerationManifest,
  ) => PromiseLike<WorkingSetActivityStore>
  readonly write: (
    manifest: WorkingSetActivityGenerationManifest,
    change: WorkingSetActivityWrite,
  ) => PromiseLike<void>
  readonly replace: (
    manifest: WorkingSetActivityGenerationManifest,
    activity: WorkingSetActivityStore,
  ) => PromiseLike<void>
  readonly close?: () => PromiseLike<void>
}

export class WorkingSetActivityAuthorityError extends Schema.TaggedErrorClass<WorkingSetActivityAuthorityError>()(
  'WorkingSetActivityAuthorityError',
  {
    phase: Schema.Literals([
      'marker-read',
      'legacy-read',
      'legacy-parse',
      'source-digest',
      'target-stage',
      'target-verify',
      'marker-write',
      'marker-readback',
      'target-read',
      'target-write',
      'target-replace',
      'target-close',
    ]),
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface WorkingSetActivityAuthorityBackendOptions {
  readonly chrome: WorkingSetActivityChromeAuthorityPort
  readonly indexedDb: WorkingSetActivityIndexedDbAuthorityPort
  readonly now?: () => number
}

export interface WorkingSetActivityAuthorityBackend
  extends WorkingSetActivityStorageBackend {
  readonly read: () => PromiseLike<WorkingSetActivityStore>
}

type AuthorityPhase = WorkingSetActivityAuthorityError['phase']

type InitializedAuthority = {
  readonly marker: WorkingSetActivityAuthorityMarker
  readonly manifest: WorkingSetActivityGenerationManifest
  readonly verifiedActivity?: WorkingSetActivityStore
}

type ActivityFingerprint = {
  readonly digest: string
  readonly recordCount: number
  readonly eventCount: number
}

const isWorkingSetActivityAuthorityMarker = Schema.is(
  workingSetActivityAuthorityMarkerSchema,
)
const workingSetActivityAuthorityMarkerKeys = new Set<PropertyKey>([
  'version',
  'backend',
  'schemaVersion',
  'generation',
  'sourceDigest',
  'recordCount',
  'eventCount',
  'retainedAfter',
  'cutoverAt',
])

function authorityError(
  phase: AuthorityPhase,
  reason: string,
  cause: unknown,
): WorkingSetActivityAuthorityError {
  return WorkingSetActivityAuthorityError.make({ phase, reason, cause })
}

async function runBoundary<Value>(
  phase: AuthorityPhase,
  reason: string,
  run: () => PromiseLike<Value>,
): Promise<Value> {
  try {
    return await run()
  } catch (cause) {
    if (cause instanceof WorkingSetActivityAuthorityError) throw cause
    throw authorityError(phase, reason, cause)
  }
}

function parseMarker(
  value: unknown,
  phase: 'marker-read' | 'marker-readback',
): WorkingSetActivityAuthorityMarker | null {
  if (value === undefined) return null
  const ownKeys = typeof value === 'object' && value !== null
    ? Reflect.ownKeys(value)
    : []
  if (
    typeof value === 'object' &&
    value !== null &&
    ownKeys.length === workingSetActivityAuthorityMarkerKeys.size &&
    ownKeys.every((key) =>
      workingSetActivityAuthorityMarkerKeys.has(key)) &&
      isWorkingSetActivityAuthorityMarker(value)
  ) return value
  throw authorityError(
    phase,
    'Working Set activity authority marker is malformed or unsupported',
    value,
  )
}

function markerMatches(
  left: WorkingSetActivityAuthorityMarker,
  right: WorkingSetActivityAuthorityMarker,
): boolean {
  return left.version === right.version &&
    left.backend === right.backend &&
    left.schemaVersion === right.schemaVersion &&
    left.generation === right.generation &&
    left.sourceDigest === right.sourceDigest &&
    left.recordCount === right.recordCount &&
    left.eventCount === right.eventCount &&
    left.retainedAfter === right.retainedAfter &&
    left.cutoverAt === right.cutoverAt
}

function manifestFromMarker(
  marker: WorkingSetActivityAuthorityMarker,
): WorkingSetActivityGenerationManifest {
  return {
    schemaVersion: marker.schemaVersion,
    generation: marker.generation,
    sourceDigest: marker.sourceDigest,
    recordCount: marker.recordCount,
    eventCount: marker.eventCount,
    retainedAfter: marker.retainedAfter,
  }
}

function canonicalActivityRows(activity: WorkingSetActivityStore): readonly unknown[] {
  return Object.values(activity.records)
    .toSorted((left, right) => left.key.localeCompare(right.key))
    .map((record) => [
      record.key,
      record.title,
      record.dismissedAt ?? null,
      record.dismissedUntil ?? null,
      record.events.map((event) => [
        event.kind === 'activation' ? 0 : 1,
        event.at,
      ]),
    ])
}

async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

async function fingerprintActivity(
  activity: WorkingSetActivityStore,
): Promise<ActivityFingerprint> {
  const rows = canonicalActivityRows(activity)
  const digest = await sha256Hex([
    WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
    rows,
  ])
  return {
    digest,
    recordCount: rows.length,
    eventCount: Object.values(activity.records).reduce(
      (count, record) => count + record.events.length,
      0,
    ),
  }
}

function assertRetentionBounds(
  activity: WorkingSetActivityStore,
  retainedAfter: number,
): void {
  for (const record of Object.values(activity.records)) {
    if (record.events.some((event) => event.at < retainedAfter)) {
      throw new Error(
        'Verified Working Set activity contains an event outside retention',
      )
    }
  }
}

async function verifyActivityMatchesManifest(
  activity: WorkingSetActivityStore,
  manifest: WorkingSetActivityGenerationManifest,
): Promise<void> {
  assertRetentionBounds(activity, manifest.retainedAfter)
  const fingerprint = await fingerprintActivity(activity)
  if (
    fingerprint.digest !== manifest.sourceDigest ||
    fingerprint.recordCount !== manifest.recordCount ||
    fingerprint.eventCount !== manifest.eventCount
  ) {
    throw new Error(
      'Verified Working Set activity does not match its migration manifest',
    )
  }
}

function makePromiseSerializer() {
  let tail: Promise<void> = Promise.resolve()

  return function serialize<Value>(
    task: () => PromiseLike<Value>,
  ): Promise<Value> {
    const result = tail.then(task, task)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export function makeWorkingSetActivityAuthorityBackend({
  chrome,
  indexedDb,
  now = Date.now,
}: WorkingSetActivityAuthorityBackendOptions): WorkingSetActivityAuthorityBackend {
  const serialize = makePromiseSerializer()
  let activeAuthority: InitializedAuthority | undefined

  async function initialize(): Promise<InitializedAuthority> {
    if (activeAuthority !== undefined) return activeAuthority

    const storedMarker = await runBoundary(
      'marker-read',
      'Unable to read Working Set activity authority marker',
      chrome.readMarker,
    )
    const marker = parseMarker(storedMarker, 'marker-read')
    if (marker !== null) {
      const manifest = manifestFromMarker(marker)
      activeAuthority = { marker, manifest }
      return activeAuthority
    }

    const migrationStartedAt = now()
    const legacyValue = await runBoundary(
      'legacy-read',
      'Unable to read legacy Working Set activity',
      chrome.readLegacy,
    )
    const parsedLegacy = parseWorkingSetActivityStorageValue(
      legacyValue,
      migrationStartedAt,
    )
    let legacyActivity: WorkingSetActivityStore
    if (parsedLegacy.status === 'missing') {
      legacyActivity = emptyWorkingSetActivity()
    } else if (parsedLegacy.status === 'valid') {
      legacyActivity = parsedLegacy.activity
    } else if (parsedLegacy.status === 'unsupported-version') {
      throw authorityError(
        'legacy-parse',
        `Unsupported legacy Working Set activity version ${parsedLegacy.version}`,
        legacyValue,
      )
    } else {
      throw authorityError(
        'legacy-parse',
        'Legacy Working Set activity is malformed',
        legacyValue,
      )
    }

    const source = await runBoundary(
      'source-digest',
      'Unable to digest legacy Working Set activity',
      () => fingerprintActivity(legacyActivity),
    )
    const manifest: WorkingSetActivityGenerationManifest = {
      schemaVersion: WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
      generation: `v1:${source.digest}`,
      sourceDigest: source.digest,
      recordCount: source.recordCount,
      eventCount: source.eventCount,
      retainedAfter: migrationStartedAt - WORKING_SET_ACTIVITY_RETENTION_MS,
    }

    await runBoundary(
      'target-stage',
      'Unable to stage IndexedDB Working Set activity generation',
      () => indexedDb.stage(manifest, legacyActivity),
    )
    const verifiedActivity = await runBoundary(
      'target-verify',
      'Unable to verify IndexedDB Working Set activity generation',
      () => indexedDb.verify(manifest),
    )
    await runBoundary(
      'target-verify',
      'IndexedDB Working Set activity verification did not match its source',
      () => verifyActivityMatchesManifest(verifiedActivity, manifest),
    )

    const nextMarker: WorkingSetActivityAuthorityMarker = {
      version: 1,
      backend: 'idb',
      schemaVersion: WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
      generation: manifest.generation,
      sourceDigest: manifest.sourceDigest,
      recordCount: manifest.recordCount,
      eventCount: manifest.eventCount,
      retainedAfter: manifest.retainedAfter,
      cutoverAt: migrationStartedAt,
    }
    await runBoundary(
      'marker-write',
      'Unable to commit Working Set activity authority marker',
      () => chrome.writeMarker(nextMarker),
    )
    const markerReadback = await runBoundary(
      'marker-readback',
      'Unable to read back Working Set activity authority marker',
      chrome.readMarker,
    )
    const confirmedMarker = parseMarker(markerReadback, 'marker-readback')
    if (
      confirmedMarker === null ||
      !markerMatches(confirmedMarker, nextMarker)
    ) {
      throw authorityError(
        'marker-readback',
        'Working Set activity authority marker readback did not match',
        markerReadback,
      )
    }

    activeAuthority = { marker: confirmedMarker, manifest }
    return { ...activeAuthority, verifiedActivity }
  }

  const backend: WorkingSetActivityAuthorityBackend = {
    read: () => serialize(async () => {
      const initialized = await initialize()
      if (initialized.verifiedActivity !== undefined) {
        return initialized.verifiedActivity
      }
      return runBoundary(
        'target-read',
        'Unable to read authoritative IndexedDB Working Set activity',
        () => indexedDb.read(initialized.manifest),
      )
    }),
    write: (change) => serialize(async () => {
      const initialized = await initialize()
      await runBoundary(
        'target-write',
        'Unable to write authoritative IndexedDB Working Set activity',
        () => indexedDb.write(initialized.manifest, change),
      )
    }),
    replace: (activity) => serialize(async () => {
      const initialized = await initialize()
      await runBoundary(
        'target-replace',
        'Unable to replace authoritative IndexedDB Working Set activity',
        () => indexedDb.replace(initialized.manifest, activity),
      )
    }),
  }

  const closeIndexedDb = indexedDb.close
  if (closeIndexedDb === undefined) return backend
  return {
    ...backend,
    close: () => serialize(() => runBoundary(
      'target-close',
      'Unable to close IndexedDB Working Set activity',
      closeIndexedDb,
    )),
  }
}
