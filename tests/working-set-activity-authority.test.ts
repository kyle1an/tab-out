import assert from 'node:assert/strict'
import test from 'node:test'
import { Schema } from 'effect'

import {
  makeWorkingSetActivityAuthorityBackend,
  workingSetActivityAuthorityMarkerSchema,
  type WorkingSetActivityAuthorityMarker,
  type WorkingSetActivityChromeAuthorityPort,
  type WorkingSetActivityGenerationManifest,
  type WorkingSetActivityIndexedDbAuthorityPort,
} from '../src/extension/background/working-set-activity-authority.js'
import type { WorkingSetActivityWrite } from '../src/extension/background/working-set-activity-storage.js'
import type {
  WorkingSetActivityRecord,
  WorkingSetActivityStore,
} from '../src/extension/types'
import { emptyWorkingSetActivity } from '../src/extension/working-set.js'

const NOW = Date.UTC(2026, 7, 9, 12)
const isAuthorityMarker = Schema.is(workingSetActivityAuthorityMarkerSchema)

type OneShotMode = 'before' | 'after' | null

interface StoredGeneration {
  readonly manifest: WorkingSetActivityGenerationManifest
  activity: WorkingSetActivityStore
}

interface SharedAuthorityState {
  marker: unknown
  readonly generations: Map<string, StoredGeneration>
  readonly calls: string[]
  markerReads: number
  markerWrites: number
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
  at: number,
): WorkingSetActivityRecord {
  return {
    key,
    url: key,
    title,
    domain: URL.parse(key)?.hostname ?? '',
    lastSeenAt: at,
    lastActivatedAt: at,
    events: [{ kind: 'activation', at }],
  }
}

function activityStore(
  records: readonly WorkingSetActivityRecord[],
): WorkingSetActivityStore {
  return {
    version: 1,
    records: Object.fromEntries(records.map((record) => [record.key, record])),
  }
}

function makeSharedState(): SharedAuthorityState {
  return {
    marker: undefined,
    generations: new Map(),
    calls: [],
    markerReads: 0,
    markerWrites: 0,
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
    markerReadbackOverrideOnce: null,
  }
}

function fakeChromePort(
  state: SharedAuthorityState,
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
  }
}

function fakeIndexedDbPort(
  state: SharedAuthorityState,
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
        activity: structuredClone(activity),
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
            NOW,
          ),
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
    },
  }
}

function makeBackend(state: SharedAuthorityState) {
  return makeWorkingSetActivityAuthorityBackend({
    chrome: fakeChromePort(state),
    indexedDb: fakeIndexedDbPort(state),
    now: () => NOW,
  })
}

function persistedMarker(
  state: SharedAuthorityState,
): WorkingSetActivityAuthorityMarker {
  assert.ok(isAuthorityMarker(state.marker))
  return state.marker
}

function updatedActivity(before: WorkingSetActivityStore): WorkingSetActivityWrite {
  const key = 'https://example.test/docs'
  const at = NOW + 1000
  const upsert = activityRecord(key, 'Updated docs', at)
  const activity = activityStore([
    upsert,
    ...Object.values(before.records).filter((record) => record.key !== key),
  ])
  return { activity, upsert, deleteKeys: [] }
}

test('bootstrap commits and verifies an empty target before confirming the marker', async () => {
  const state = makeSharedState()
  const backend = makeBackend(state)

  assert.deepEqual(await backend.read(), emptyWorkingSetActivity())

  const marker = persistedMarker(state)
  assert.equal(marker.cutoverAt, NOW)
  assert.equal(marker.recordCount, 0)
  assert.equal(marker.eventCount, 0)
  assert.equal(
    state.generations.get(marker.generation)?.manifest.sourceDigest,
    marker.sourceDigest,
  )
  assert.deepEqual(state.calls, [
    'marker:read',
    'idb:stage',
    'idb:verify',
    'marker:write',
    'marker:read',
  ])
})

test('concurrent first operations serialize behind one bootstrap', async () => {
  const state = makeSharedState()
  const backend = makeBackend(state)

  const results = await Promise.all([
    backend.read(),
    backend.read(),
    backend.read(),
  ])

  assert.deepEqual(results, [
    emptyWorkingSetActivity(),
    emptyWorkingSetActivity(),
    emptyWorkingSetActivity(),
  ])
  assert.equal(state.stages, 1)
  assert.equal(state.verifies, 1)
  assert.equal(state.markerWrites, 1)
  assert.equal(state.markerReads, 2)
  assert.equal(state.targetReads, 2)
})

const stageFailureModes: readonly Exclude<OneShotMode, null>[] = [
  'before',
  'after',
]

for (const failure of stageFailureModes) {
  test(`a target stage ${failure}-commit failure leaves the marker absent and retries idempotently after restart`, async () => {
    const state = makeSharedState()
    state.stageFailure = failure

    await assert.rejects(async () => makeBackend(state).read())

    assert.equal(state.marker, undefined)
    assert.equal(state.markerWrites, 0)
    assert.equal(state.generations.size, failure === 'after' ? 1 : 0)

    assert.deepEqual(
      await makeBackend(state).read(),
      emptyWorkingSetActivity(),
    )
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
  assert.deepEqual(
    await makeBackend(state).read(),
    emptyWorkingSetActivity(),
  )
  assert.equal(state.stages, 2)
  assert.equal(state.verifies, 2)
})

test('verification rejects a non-empty bootstrap before authority handoff', async () => {
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
  assert.deepEqual(
    await makeBackend(state).read(),
    emptyWorkingSetActivity(),
  )
  assert.equal(state.stages, 2)
})

test('commit-then-reject marker ambiguity is resolved by re-reading the marker after restart', async () => {
  const state = makeSharedState()
  state.markerWriteFailure = 'after'

  await assert.rejects(async () => makeBackend(state).read())

  const marker = persistedMarker(state)
  assert.deepEqual(
    await makeBackend(state).read(),
    emptyWorkingSetActivity(),
  )
  assert.equal(state.stages, 1)
  assert.equal(state.targetReads, 1)
  assert.equal(persistedMarker(state).generation, marker.generation)
})

test('commit-then-reject marker ambiguity also re-reads authority on the next same-worker operation', async () => {
  const state = makeSharedState()
  state.markerWriteFailure = 'after'
  const backend = makeBackend(state)

  await assert.rejects(async () => backend.read())
  assert.deepEqual(await backend.read(), emptyWorkingSetActivity())

  assert.equal(state.markerReads, 2)
  assert.equal(state.stages, 1)
  assert.equal(state.targetReads, 1)
})

test('failed marker readback never activates an in-memory fallback', async () => {
  const state = makeSharedState()
  state.failMarkerReadbackOnce = true

  await assert.rejects(async () => makeBackend(state).read())

  persistedMarker(state)
  assert.deepEqual(
    await makeBackend(state).read(),
    emptyWorkingSetActivity(),
  )
  assert.equal(state.targetReads, 1)
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
    cutoverAt: NOW,
  }

  await assert.rejects(async () => makeBackend(state).read())

  persistedMarker(state)
  assert.deepEqual(
    await makeBackend(state).read(),
    emptyWorkingSetActivity(),
  )
  assert.equal(state.stages, 1)
})

test('marker readback rejects unexpected fields before activating the generation', async () => {
  const state = makeSharedState()
  state.addUnexpectedMarkerFieldOnReadbackOnce = true

  await assert.rejects(async () => makeBackend(state).read())

  persistedMarker(state)
  assert.equal(state.targetReads, 0)
  assert.deepEqual(
    await makeBackend(state).read(),
    emptyWorkingSetActivity(),
  )
  assert.equal(state.stages, 1)
})

test('a cold marker with unexpected fields fails without reading or restaging the target', async () => {
  const state = makeSharedState()
  await makeBackend(state).read()
  state.marker = { ...persistedMarker(state), unexpected: true }
  const targetReadsBeforeRestart = state.targetReads

  await assert.rejects(async () => makeBackend(state).read())

  assert.equal(state.targetReads, targetReadsBeforeRestart)
  assert.equal(state.stages, 1)
})

test('a valid marker with a missing target fails without bootstrapping a replacement', async () => {
  const state = makeSharedState()
  await makeBackend(state).read()
  state.generations.clear()

  await assert.rejects(async () => makeBackend(state).read())

  assert.equal(state.stages, 1)
})

for (const marker of [
  { version: 2, backend: 'idb', schemaVersion: 1, generation: `v1:${'0'.repeat(64)}`, sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'legacy', schemaVersion: 1, generation: `v1:${'0'.repeat(64)}`, sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'idb', schemaVersion: 2, generation: `v1:${'0'.repeat(64)}`, sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'idb', schemaVersion: 1, generation: 'invalid-generation', sourceDigest: '0'.repeat(64), recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
  { version: 1, backend: 'idb', schemaVersion: 1, generation: `v1:${'0'.repeat(64)}`, sourceDigest: 'not-a-digest', recordCount: 2, eventCount: 2, retainedAfter: 0, cutoverAt: NOW },
]) {
  test(`malformed or unsupported marker fails closed: ${JSON.stringify(marker)}`, async () => {
    const state = makeSharedState()
    state.marker = marker

    await assert.rejects(async () => makeBackend(state).read())

    assert.equal(state.stages, 0)
    assert.equal(state.targetReads, 0)
  })
}

test('active writes and replacements stay on the confirmed generation', async () => {
  const state = makeSharedState()
  const backend = makeBackend(state)
  const initial = await backend.read()
  const change = updatedActivity(initial)
  const replacement = activityStore([
    activityRecord('https://example.test/replaced', 'Replacement', NOW + 2000),
  ])

  await backend.write(change)
  await backend.replace(replacement)

  assert.deepEqual(await backend.read(), replacement)
  assert.equal(state.markerReads, 2)
  assert.equal(state.targetWrites, 1)
  assert.equal(state.targetReplaces, 1)
})

test('backend close drains through the same serializer', async () => {
  const state = makeSharedState()
  const backend = makeBackend(state)
  assert.ok(backend.close !== undefined)

  await Promise.all([backend.read(), backend.close()])

  assert.equal(state.closes, 1)
  assert.equal(state.calls.at(-1), 'idb:close')
})
