import { Schema } from 'effect'

import { emptyWorkingSetActivity } from '../working-set.js'
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
}

/**
 * The physical IndexedDB module implements this generation-aware port. Every
 * method validates the supplied manifest before treating rows as authoritative.
 * `verify` is the stricter bootstrap read: it reopens the database, decodes every
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

export class WorkingSetActivityAuthorityError extends Schema.TaggedError<WorkingSetActivityAuthorityError>()(
  'WorkingSetActivityAuthorityError',
  {
    phase: Schema.Literals([
      'marker-read',
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
  readonly manifest: WorkingSetActivityGenerationManifest
  readonly verifiedActivity?: WorkingSetActivityStore
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

async function emptyActivitySourceDigest(): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
    [],
  ]))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(digest).toHex()
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
      activeAuthority = { manifest }
      return activeAuthority
    }

    const initializedAt = now()
    const initialActivity = emptyWorkingSetActivity()

    const sourceDigest = await runBoundary(
      'source-digest',
      'Unable to digest initial Working Set activity',
      emptyActivitySourceDigest,
    )
    const manifest: WorkingSetActivityGenerationManifest = {
      schemaVersion: WORKING_SET_ACTIVITY_INDEXED_DB_SCHEMA_VERSION,
      generation: `v1:${sourceDigest}`,
      sourceDigest,
      recordCount: 0,
      eventCount: 0,
      retainedAfter: initializedAt - WORKING_SET_ACTIVITY_RETENTION_MS,
    }

    await runBoundary(
      'target-stage',
      'Unable to stage IndexedDB Working Set activity generation',
      () => indexedDb.stage(manifest, initialActivity),
    )
    const verifiedActivity = await runBoundary(
      'target-verify',
      'Unable to verify IndexedDB Working Set activity generation',
      () => indexedDb.verify(manifest),
    )
    await runBoundary(
      'target-verify',
      'IndexedDB Working Set activity verification did not match its source',
      async () => {
        if (Object.keys(verifiedActivity.records).length !== 0) {
          throw new Error(
            'Verified Working Set activity bootstrap is not empty',
          )
        }
      },
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
      cutoverAt: initializedAt,
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

    activeAuthority = { manifest }
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
