import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from 'effect'

import {
  makeWorkingSetActivityAuthorityBackend,
  workingSetActivityAuthorityMarkerSchema,
  type WorkingSetActivityAuthorityMarker,
  type WorkingSetActivityChromeAuthorityPort,
  type WorkingSetActivityGenerationManifest,
  type WorkingSetActivityIndexedDbAuthorityPort
} from '../src/extension/background/working-set-activity-authority.js'
import type { WorkingSetActivityWrite } from '../src/extension/background/working-set-activity-storage.js'
import type {
  WorkingSetActivityRecord,
  WorkingSetActivityStore
} from '../src/extension/types'

const NOW = Date.UTC(2026, 7, 9, 12)
const isAuthorityMarker = Schema.is(workingSetActivityAuthorityMarkerSchema)

type OneShotMode = 'before' | 'after' | null

interface StoredGeneration {
  readonly manifest: WorkingSetActivityGenerationManifest
  activity: WorkingSetActivityStore
}

interface SharedAuthorityState {
  marker: unknown
  legacy: unknown
  readonly generations: Map<string, StoredGeneration>
  readonly calls: string[]
  markerReads: number
  markerWrites: number
  legacyReads: number
  stages: number
  verifies: number
  targetReads: number
  targetWrites: number
  targetReplaces: number
  closes: number
  stageFailure: OneShotMode
  markerWriteFailure: OneShotMode
  failVerificationOnce: boolean
  mismatchVerificationOnce: boolean
  failMarkerReadbackOnce: boolean
  addUnexpectedMarkerFieldOnReadbackOnce: boolean
  markerReadbackOverrideOnce: unknown | null
}

function activityRecord(
  key: string,
  title: string,
  at: number
): WorkingSetActivityRecord {
  return {
    key,
    url: key,
    title,
    domain: URL.parse(key)?.hostname ?? '',
    lastSeenAt: at,
    lastActivatedAt: at,
    events: [{ kind: 'activation', at }]
  }
}

function activityStore(
  records: readonly WorkingSetActivityRecord[]
): WorkingSetActivityStore {
  return {
    version: 1,
    records: Object.fromEntries(records.map((record) => [record.key, record]))
  }
}

function makeLegacyActivity(): WorkingSetActivityStore {
  return activityStore([
    activityRecord('https://example.test/docs', 'Example Docs', NOW - 1000),
    activityRecord('https://example.test/tasks', 'Example Tasks', NOW - 2000)
  ])
}

function makeSharedState(
  legacy: unknown = makeLegacyActivity()
): SharedAuthorityState {
  return {
    marker: undefined,
    legacy: structuredClone(legacy),
    generations: new Map(),
    calls: [],
    markerReads: 0,
    markerWrites: 0,
    legacyReads: 0,
    stages: 0,
    verifies: 0,
    targetReads: 0,
    targetWrites: 0,
    targetReplaces: 0,
    closes: 0,
    stageFailure: null,
    markerWriteFailure: null,
    failVerificationOnce: false,
    mismatchVerificationOnce: false,
    failMarkerReadbackOnce: false,
    addUnexpectedMarkerFieldOnReadbackOnce: false,
    markerReadbackOverrideOnce: null
  }
}

function fakeChromePort(
  state: SharedAuthorityState
): WorkingSetActivityChromeAuthorityPort {
  return {
    async readMarker() {
      state.calls.push('marker:read')
      state.markerReads += 1
      if (state.markerWrites > 0 && state.failMarkerReadbackOnce) {
        state.failMarkerReadbackOnce = false
        throw new Error('synthetic marker readback failure')
      }
      if (
        state.markerWrites > 0 &&
        state.addUnexpectedMarkerFieldOnReadbackOnce
      ) {
        state.addUnexpectedMarkerFieldOnReadbackOnce = false
        const marker = structuredClone(state.marker)
        assert.ok(typeof marker === 'object' && marker !== null)
        return { ...marker, unexpected: true }
      }
      if (
        state.markerWrites > 0 &&
        state.markerReadbackOverrideOnce !== null
      ) {
        const override = state.markerReadbackOverrideOnce
        state.markerReadbackOverrideOnce = null
        return structuredClone(override)
      }
      return structuredClone(state.marker)
    },
    async writeMarker(marker) {
      state.calls.push('marker:write')
      state.markerWrites += 1
      const failure = state.markerWriteFailure
      state.markerWriteFailure = null
      if (failure === 'before') {
        throw new Error('synthetic marker write failure')
      }
      state.marker = structuredClone(marker)
      if (failure === 'after') {
        throw new Error('synthetic marker commit-then-reject ambiguity')
      }
    },
    async readLegacy() {
      state.calls.push('legacy:read')
      state.legacyReads += 1
      return structuredClone(state.legacy)
    }
  }
}

function fakeIndexedDbPort(
  state: SharedAuthorityState
): WorkingSetActivityIndexedDbAuthorityPort {
  return {
    async stage(manifest, activity) {
      state.calls.push('idb:stage')
      state.stages += 1
      const failure = state.stageFailure
      state.stageFailure = null
      if (failure === 'before') {
        throw new Error('synthetic target stage failure')
      }
      state.generations.set(manifest.generation, {
        manifest: structuredClone(manifest),
        activity: structuredClone(activity)
      })
      if (failure === 'after') {
        throw new Error('synthetic target commit-then-reject ambiguity')
      }
    },
    async verify(manifest) {
      state.calls.push('idb:verify')
      state.verifies += 1
      if (state.failVerificationOnce) {
        state.failVerificationOnce = false
        throw new Error('synthetic target verification failure')
      }
      const stored = state.generations.get(manifest.generation)
      if (stored === undefined) throw new Error('target generation is missing')
      if (state.mismatchVerificationOnce) {
        state.mismatchVerificationOnce = false
        return activityStore([
          activityRecord(
            'https://example.test/mismatch',
            'Mismatched generation',
            NOW
          )
        ])
      }
      return structuredClone(stored.activity)
    },
    async read(manifest) {
      state.calls.push('idb:read')
      state.targetReads += 1
      const stored = state.generations.get(manifest.generation)
      if (stored === undefined) throw new Error('target generation is missing')
      if (stored.manifest.sourceDigest !== manifest.sourceDigest) {
        throw new Error('target generation manifest does not match marker')
      }
      return structuredClone(stored.activity)
    },
    async write(manifest, change) {
      state.calls.push('idb:write')
      state.targetWrites += 1
      const stored = state.generations.get(manifest.generation)
      if (stored === undefined) throw new Error('target generation is missing')
      stored.activity = structuredClone(change.activity)
    },
    async replace(manifest, activity) {
      state.calls.push('idb:replace')
      state.targetReplaces += 1
      const stored = state.generations.get(manifest.generation)
      if (stored === undefined) throw new Error('target generation is missing')
      stored.activity = structuredClone(activity)
    },
    async close() {
      state.calls.push('idb:close')
      state.closes += 1
    }
  }
}

function makeBackend(state: SharedAuthorityState) {
  return makeWorkingSetActivityAuthorityBackend({
    chrome: fakeChromePort(state),
    indexedDb: fakeIndexedDbPort(state),
    now: () => NOW
  })
}

function persistedMarker(
  state: SharedAuthorityState
): WorkingSetActivityAuthorityMarker {
  assert.ok(isAuthorityMarker(state.marker))
  return state.marker
}

function updatedActivity(before: WorkingSetActivityStore): WorkingSetActivityWrite {
  const key = 'https://example.test/docs'
  const existing = before.records[key]
  assert.ok(existing !== undefined)
  const at = NOW + 1000
  const upsert: WorkingSetActivityRecord = {
    ...existing,
    title: 'Updated docs',
    lastSeenAt: at,
    lastNavigatedAt: at,
    events: [...existing.events, { kind: 'navigation', at }]
  }
  const activity = activityStore([
    upsert,
    ...Object.values(before.records).filter((record) => record.key !== key)
  ])
  return { activity, upsert, deleteKeys: [] }
}

test('migration commits and verifies the target before writing and reading back the marker', async () => {
  const legacy = makeLegacyActivity()
  const state = makeSharedState(legacy)
  const backend = makeBackend(state)

  assert.deepEqual(await backend.read(), legacy)

  const marker = persistedMarker(state)
  assert.equal(marker.cutoverAt, NOW)
  assert.equal(state.generations.get(marker.generation)?.manifest.sourceDigest, marker.sourceDigest)
  assert.deepEqual(state.legacy, legacy)
  assert.deepEqual(state.calls, [
    'marker:read',
    'legacy:read',
    'idb:stage',
    'idb:verify',
    'marker:write',
    'marker:read'
  ])
})

test('concurrent first operations serialize behind one migration', async () => {
  const state = makeSharedState()
  const backend = makeBackend(state)

  const results = await Promise.all([
    backend.read(),
    backend.read(),
    backend.read()
  ])

  assert.deepEqual(results, [state.legacy, state.legacy, state.legacy])
  assert.equal(state.legacyReads, 1)
  assert.equal(state.stages, 1)
  assert.equal(state.verifies, 1)
  assert.equal(state.markerWrites, 1)
  assert.equal(state.markerReads, 2)
  assert.equal(state.targetReads, 2)
})

const stageFailureModes: readonly Exclude<OneShotMode, null>[] = [
  'before',
  'after'
]

for (const failure of stageFailureModes) {
  test(`a target stage ${failure}-commit failure leaves the marker absent and retries idempotently after restart`, async () => {
    const legacy = makeLegacyActivity()
    const state = makeSharedState(legacy)
    state.stageFailure = failure

    await assert.rejects(async () => makeBackend(state).read())

    assert.equal(state.marker, undefined)
    assert.deepEqual(state.legacy, legacy)
    assert.equal(state.markerWrites, 0)
    assert.equal(state.generations.size, failure === 'after' ? 1 : 0)

    assert.deepEqual(await makeBackend(state).read(), legacy)
    assert.equal(state.stages, 2)
    assert.equal(state.markerWrites, 1)
    persistedMarker(state)
  })
}

test('verification failure leaves a committed target ignored until a fresh coordinator retries', async () => {
  const state = makeSharedState()
  state.failVerificationOnce = true

  await assert.rejects(async () => makeBackend(state).read())

  assert.equal(state.generations.size, 1)
  assert.equal(state.marker, undefined)
  assert.deepEqual(await makeBackend(state).read(), state.legacy)
  assert.equal(state.stages, 2)
  assert.equal(state.verifies, 2)
})

test('verification digest mismatch fails before authority handoff', async () => {
  const state = makeSharedState()
  state.mismatchVerificationOnce = true

  await assert.rejects(async () => makeBackend(state).read())

  assert.equal(state.marker, undefined)
  assert.equal(state.markerWrites, 0)
  assert.equal(state.generations.size, 1)
})

test('marker write failure leaves the verified generation non-authoritative', async () => {
  const state = makeSharedState()
  state.markerWriteFailure = 'before'

  await assert.rejects(async () => makeBackend(state).read())

  assert.equal(state.generations.size, 1)
  assert.equal(state.marker, undefined)
  assert.equal(state.markerReads, 1)
  assert.deepEqual(await makeBackend(state).read(), state.legacy)
  assert.equal(state.stages, 2)
})

test('commit-then-reject marker ambiguity is resolved by re-reading the marker after restart', async () => {
  const state = makeSharedState()
  state.markerWriteFailure = 'after'

  await assert.rejects(async () => makeBackend(state).read())

  const marker = persistedMarker(state)
  const legacyReadsBeforeRestart = state.legacyReads
  assert.deepEqual(await makeBackend(state).read(), state.legacy)
  assert.equal(state.legacyReads, legacyReadsBeforeRestart)
  assert.equal(state.stages, 1)
  assert.equal(state.targetReads, 1)
  assert.equal(persistedMarker(state).generation, marker.generation)
})

test('commit-then-reject marker ambiguity also re-reads authority on the next same-worker operation', async () => {
  const state = makeSharedState()
  state.markerWriteFailure = 'after'
  const backend = makeBackend(state)

  await assert.rejects(async () => backend.read())
  const legacyReadsBeforeRetry = state.legacyReads
  assert.deepEqual(await backend.read(), state.legacy)

  assert.equal(state.legacyReads, legacyReadsBeforeRetry)
  assert.equal(state.markerReads, 2)
  assert.equal(state.stages, 1)
  assert.equal(state.targetReads, 1)
})

test('failed marker readback never activates an in-memory fallback', async () => {
  const state = makeSharedState()
  state.failMarkerReadbackOnce = true

  await assert.rejects(async () => makeBackend(state).read())

  persistedMarker(state)
  const legacyReadsBeforeRestart = state.legacyReads
  assert.deepEqual(await makeBackend(state).read(), state.legacy)
  assert.equal(state.legacyReads, legacyReadsBeforeRestart)
  assert.equal(state.targetReads, 1)
})

test('missing legacy state migrates as a verified known-empty generation', async () => {
  const state = makeSharedState()
  state.legacy = undefined

  assert.deepEqual(await makeBackend(state).read(), {
    version: 1,
    records: {}
  })

  const marker = persistedMarker(state)
  assert.deepEqual(state.generations.get(marker.generation)?.activity, {
    version: 1,
    records: {}
  })
  assert.equal(state.stages, 1)
  assert.equal(state.markerWrites, 1)
})

test('mismatched marker readback fails even when the durable marker is valid', async () => {
  const state = makeSharedState()
  state.markerReadbackOverrideOnce = {
    version: 1,
    backend: 'idb',
    schemaVersion: 1,
    generation: `v1:${'f'.repeat(64)}`,
    sourceDigest: 'f'.repeat(64),
    recordCount: 2,
    eventCount: 2,
    retainedAfter: NOW - 30 * 24 * 60 * 60 * 1000,
    cutoverAt: NOW
  }

  await assert.rejects(async () => makeBackend(state).read())

  persistedMarker(state)
  assert.deepEqual(await makeBackend(state).read(), state.legacy)
  assert.equal(state.stages, 1)
})

test('marker readback rejects unexpected fields before activating the generation', async () => {
  const state = makeSharedState()
  state.addUnexpectedMarkerFieldOnReadbackOnce = true

  await assert.rejects(async () => makeBackend(state).read())

  persistedMarker(state)
  assert.equal(state.targetReads, 0)
  assert.deepEqual(await makeBackend(state).read(), state.legacy)
  assert.equal(state.stages, 1)
})

test('a cold marker with unexpected fields fails without reading legacy or target', async () => {
  const state = makeSharedState()
  await makeBackend(state).read()
  state.marker = { ...persistedMarker(state), unexpected: true }
  const legacyReadsBeforeRestart = state.legacyReads
  const targetReadsBeforeRestart = state.targetReads

  await assert.rejects(async () => makeBackend(state).read())

  assert.equal(state.legacyReads, legacyReadsBeforeRestart)
  assert.equal(state.targetReads, targetReadsBeforeRestart)
})

test('a valid marker with a missing target fails without reading legacy', async () => {
  const state = makeSharedState()
  await makeBackend(state).read()
  state.generations.clear()
  const legacyReadsBeforeRestart = state.legacyReads

  await assert.rejects(async () => makeBackend(state).read())

  assert.equal(state.legacyReads, legacyReadsBeforeRestart)
  assert.equal(state.stages, 1)
})

for (const marker of [
  { version: 2, backend: 'idb', schemaVersion: 1, generation: `v1:${'0'.repeat(64)}`, sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'legacy', schemaVersion: 1, generation: `v1:${'0'.repeat(64)}`, sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'idb', schemaVersion: 2, generation: `v1:${'0'.repeat(64)}`, sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'idb', schemaVersion: 1, generation: 'invalid-generation', sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'idb', schemaVersion: 1, generation: `v1:${'0'.repeat(64)}`, sourceDigest: 'not-a-digest', recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW }
]) {
  test(`malformed or unsupported marker fails closed: ${JSON.stringify(marker)}`, async () => {
    const state = makeSharedState()
    state.marker = marker

    await assert.rejects(async () => makeBackend(state).read())

    assert.equal(state.legacyReads, 0)
    assert.equal(state.stages, 0)
    assert.equal(state.targetReads, 0)
  })
}

for (const legacy of [
  { version: 1, records: [] },
  { version: 2, records: {} }
]) {
  test(`required migration rejects invalid legacy state: ${JSON.stringify(legacy)}`, async () => {
    const state = makeSharedState(legacy)

    await assert.rejects(async () => makeBackend(state).read())

    assert.equal(state.marker, undefined)
    assert.equal(state.stages, 0)
    assert.deepEqual(state.legacy, legacy)
  })
}

test('active writes and replacements stay on the confirmed generation without shadowing legacy', async () => {
  const legacy = makeLegacyActivity()
  const state = makeSharedState(legacy)
  const backend = makeBackend(state)
  const migrated = await backend.read()
  const change = updatedActivity(migrated)
  const replacement = activityStore([
    activityRecord('https://example.test/replaced', 'Replacement', NOW + 2000)
  ])

  await backend.write(change)
  await backend.replace(replacement)

  assert.deepEqual(await backend.read(), replacement)
  assert.deepEqual(state.legacy, legacy)
  assert.equal(state.markerReads, 2)
  assert.equal(state.targetWrites, 1)
  assert.equal(state.targetReplaces, 1)
})

test('equivalent legacy insertion orders derive the same source digest', async () => {
  const records = Object.values(makeLegacyActivity().records)
  const left = makeSharedState(activityStore(records))
  const right = makeSharedState(activityStore(records.toReversed()))

  await Promise.all([makeBackend(left).read(), makeBackend(right).read()])

  assert.equal(
    persistedMarker(left).sourceDigest,
    persistedMarker(right).sourceDigest
  )
})

test('backend close drains through the same serializer', async () => {
  const state = makeSharedState()
  const backend = makeBackend(state)
  assert.ok(backend.close !== undefined)

  await Promise.all([backend.read(), backend.close()])

  assert.equal(state.closes, 1)
  assert.equal(state.calls.at(-1), 'idb:close')
})
