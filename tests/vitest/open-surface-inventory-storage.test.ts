import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Effect } from 'effect'

import {
  emptyOpenSurfaceInventory,
  OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
} from '../../src/extension/open-surface-inventory.js'
import {
  OpenSurfaceInventoryStorage,
  parseOpenSurfaceInventoryValue,
} from '../../src/extension/open-surface-inventory-storage.js'
import { createRetainedPageIdentity } from '../../src/extension/retained-page-identity.js'

it('Open Surface Inventory decoding treats missing storage as empty and accepts v1', () => {
  const missing = parseOpenSurfaceInventoryValue(undefined)
  assert.equal(missing.status, 'missing')
  assert.deepEqual(missing.inventory, emptyOpenSurfaceInventory())

  const inventory = emptyOpenSurfaceInventory()
  const valid = parseOpenSurfaceInventoryValue(inventory)
  assert.equal(valid.status, 'valid')
  assert.deepEqual(valid.inventory, inventory)
})

it.effect('Open Surface Inventory storage keeps session and durable checkpoints separate', () => Effect.gen(function* () {
  let sessionStored: unknown
  let durableStored: unknown
  const inventory = emptyOpenSurfaceInventory()

  yield* Effect.gen(function* () {
    const storage = yield* OpenSurfaceInventoryStorage

    yield* storage.writeSession(inventory)
    assert.equal((yield* storage.readSession()).status, 'valid')
    assert.equal((yield* storage.readDurable()).status, 'missing')

    yield* storage.writeDurable(inventory)
    assert.equal((yield* storage.readDurable()).status, 'valid')
  }).pipe(Effect.provide(OpenSurfaceInventoryStorage.layer({
    readSession: async () => sessionStored,
    writeSession: async (value) => {
      sessionStored = value
    },
    readDurable: async () => durableStored,
    writeDurable: async (value) => {
      durableStored = value
    },
  })))
}))

it.effect('Open Surface Inventory storage preserves backend method receivers', () => Effect.gen(function* () {
  const backend = {
    sessionStored: undefined as unknown,
    durableStored: undefined as unknown,
    async readSession() {
      return this.sessionStored
    },
    async writeSession(value: unknown) {
      this.sessionStored = value
    },
    async readDurable() {
      return this.durableStored
    },
    async writeDurable(value: unknown) {
      this.durableStored = value
    },
  }
  const inventory = emptyOpenSurfaceInventory()

  yield* Effect.gen(function* () {
    const storage = yield* OpenSurfaceInventoryStorage
    yield* storage.writeSession(inventory)
    yield* storage.writeDurable(inventory)
    assert.equal((yield* storage.readSession()).status, 'valid')
    assert.equal((yield* storage.readDurable()).status, 'valid')
  }).pipe(Effect.provide(OpenSurfaceInventoryStorage.layer(backend)))
}))

it.effect('Open Surface Inventory storage reindexes identities without collapsing physical tabs', () => Effect.gen(function* () {
  const url = 'https://example.test/reindexed'
  let sessionStored: unknown = {
    schemaVersion: 1,
    identityVersion: 1,
    entries: {
      1: {
        tabId: 1,
        closureToken: 'lifetime-one',
        identityDigest: '',
        surfaceKind: 'normal-tab',
        canonicalKey: '',
        url,
        title: 'First physical tab',
      },
      2: {
        tabId: 2,
        closureToken: 'lifetime-two',
        identityDigest: 'legacy-identity-two',
        surfaceKind: 'normal-tab',
        canonicalKey: 'legacy-canonical-two',
        url,
        title: 'Second physical tab',
      },
    },
  }
  let writes = 0
  let hashCalls = 0
  const storageLayer = OpenSurfaceInventoryStorage.layer({
    readSession: async () => structuredClone(sessionStored),
    writeSession: async (value) => {
      writes += 1
      sessionStored = value
    },
    readDurable: async () => undefined,
    writeDurable: async () => {},
  }, {
    reindexIdentities: true,
    runtimeId: 'tab-out-id',
    sha256: (input) => {
      hashCalls += 1
      return globalThis.crypto.subtle.digest('SHA-256', input)
    },
  })
  const [first, repeated] = yield* Effect.gen(function* () {
    const storage = yield* OpenSurfaceInventoryStorage
    return [yield* storage.readSession(), yield* storage.readSession()] as const
  }).pipe(Effect.provide(storageLayer))
  const identity = yield* Effect.promise(() => createRetainedPageIdentity({
    surfaceKind: 'normal-tab',
    url,
  }, { runtimeId: 'tab-out-id' }))
  assert.ok(identity)

  assert.equal(first.status, 'valid')
  assert.equal(repeated.status, 'valid')
  assert.deepEqual(Object.keys(first.inventory.entries), ['1', '2'])
  assert.deepEqual(
    Object.values(first.inventory.entries).map((entry) => entry.identityDigest),
    [identity.identityDigest, identity.identityDigest],
  )
  assert.deepEqual(
    Object.values(first.inventory.entries).map((entry) => entry.canonicalKey),
    [identity.canonicalKey, identity.canonicalKey],
  )
  assert.equal(first.inventory.schemaVersion, OPEN_SURFACE_INVENTORY_SCHEMA_VERSION)
  assert.equal(hashCalls, 1)
  assert.equal(writes, 1)

  // Simulate an otherwise-correct legacy checkpoint. The schema marker alone
  // must still upgrade once so a later cold worker can trust the owner output.
  sessionStored = { ...first.inventory, schemaVersion: 1 }
  let upgradeHashCalls = 0
  let upgradeWrites = 0
  const upgradeLayer = OpenSurfaceInventoryStorage.layer({
    readSession: async () => structuredClone(sessionStored),
    writeSession: async (value) => {
      upgradeWrites += 1
      sessionStored = value
    },
    readDurable: async () => undefined,
    writeDurable: async () => {},
  }, {
    reindexIdentities: true,
    runtimeId: 'tab-out-id',
    sha256: (input) => {
      upgradeHashCalls += 1
      return globalThis.crypto.subtle.digest('SHA-256', input)
    },
  })
  const upgraded = yield* OpenSurfaceInventoryStorage.pipe(
    Effect.flatMap((storage) => storage.readSession()),
    Effect.provide(upgradeLayer),
  )
  assert.equal(upgraded.status, 'valid')
  assert.equal(upgraded.inventory.schemaVersion, OPEN_SURFACE_INVENTORY_SCHEMA_VERSION)
  assert.equal(upgradeHashCalls, 1)
  assert.equal(upgradeWrites, 1)

  let coldHashCalls = 0
  let coldWrites = 0
  const coldLayer = OpenSurfaceInventoryStorage.layer({
    readSession: async () => structuredClone(sessionStored),
    writeSession: async () => {
      coldWrites += 1
    },
    readDurable: async () => undefined,
    writeDurable: async () => {},
  }, {
    reindexIdentities: true,
    runtimeId: 'tab-out-id',
    sha256: (input) => {
      coldHashCalls += 1
      return globalThis.crypto.subtle.digest('SHA-256', input)
    },
  })
  const cold = yield* OpenSurfaceInventoryStorage.pipe(
    Effect.flatMap((storage) => storage.readSession()),
    Effect.provide(coldLayer),
  )
  assert.equal(cold.status, 'valid')
  assert.equal(cold.inventory.schemaVersion, OPEN_SURFACE_INVENTORY_SCHEMA_VERSION)
  assert.equal(coldHashCalls, 0)
  assert.equal(coldWrites, 0)
}))

it('Open Surface Inventory decoding salvages valid entries and rejects invalid closure times', () => {
  const parsed = parseOpenSurfaceInventoryValue({
    schemaVersion: 1,
    identityVersion: 1,
    entries: {
      1: {
        tabId: 1,
        closureToken: 'lifetime-valid',
        identityDigest: 'identity-valid',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/valid',
        url: 'https://example.test/valid',
        title: 'Valid',
        closedAt: 900,
      },
      2: {
        tabId: 2,
        closureToken: 'lifetime-future',
        identityDigest: 'identity-future',
        surfaceKind: 'app',
        canonicalKey: 'https://example.test/future',
        url: 'https://example.test/future',
        title: 'Future',
        closedAt: 1_001,
      },
    },
  }, 1_000)

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(Object.keys(parsed.inventory.entries), ['1'])
  assert.equal(parsed.inventory.entries['1']?.closedAt, 900)
})

it('Open Surface Inventory decoding strips metadata-bearing envelopes and entries', () => {
  const parsed = parseOpenSurfaceInventoryValue({
    schemaVersion: 1,
    identityVersion: 1,
    entries: {
      1: {
        tabId: 1,
        closureToken: 'lifetime-valid',
        identityDigest: 'identity-valid',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/valid',
        url: 'https://example.test/valid',
        title: 'Valid',
      },
      2: {
        tabId: 2,
        closureToken: 'lifetime-metadata',
        identityDigest: 'identity-metadata',
        surfaceKind: 'normal-tab',
        canonicalKey: 'https://example.test/metadata',
        url: 'https://example.test/metadata',
        title: 'Metadata',
        privateNote: 'must not persist',
      },
    },
    privateNote: 'must not persist',
  })

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(Object.keys(parsed.inventory.entries), ['1'])
  assert.equal('privateNote' in parsed.inventory, false)
})

it('Open Surface Inventory decoding preserves unknown newer envelopes untouched', () => {
  const stored = {
    schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION + 1,
    identityVersion: 1,
    entries: { future: { privateShape: true } },
    privateNote: 'future schema owns this',
  }
  const parsed = parseOpenSurfaceInventoryValue(stored)

  assert.equal(parsed.status, 'newer')
  assert.equal(parsed.raw, stored)
})

it('Open Surface Inventory restore drops entries with unbounded or unusable metadata', () => {
  const base = {
    tabId: 1,
    closureToken: 'lifetime-valid',
    identityDigest: 'identity-valid',
    surfaceKind: 'normal-tab',
    canonicalKey: 'https://example.test/valid',
    url: 'https://example.test/valid',
    title: 'Valid',
  } as const
  const parsed = parseOpenSurfaceInventoryValue({
    schemaVersion: 1,
    identityVersion: 1,
    entries: {
      1: base,
      2: { ...base, tabId: 2, closureToken: '', identityDigest: 'empty-token' },
      3: {
        ...base,
        tabId: 3,
        closureToken: 'lifetime-long-title',
        identityDigest: 'long-title',
        title: 'x'.repeat(513),
      },
      4: {
        ...base,
        tabId: 4,
        closureToken: 'lifetime-blob-favicon',
        identityDigest: 'blob-favicon',
        favIconUrl: 'blob:https://example.test/private',
      },
    },
  })

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(Object.keys(parsed.inventory.entries), ['1'])
})

it('marked Open Surface Inventories keep strict derived-field validation', () => {
  const parsed = parseOpenSurfaceInventoryValue({
    schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
    identityVersion: 1,
    entries: {
      1: {
        tabId: 1,
        closureToken: 'lifetime-invalid-derived-fields',
        identityDigest: '',
        surfaceKind: 'normal-tab',
        canonicalKey: '',
        url: 'https://example.test/current-invalid',
        title: 'Invalid current record',
      },
    },
  })

  assert.equal(parsed.status, 'malformed')
  assert.deepEqual(parsed.inventory.entries, {})
})
