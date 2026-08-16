import assert from 'node:assert/strict'
import { it } from '@effect/vitest'
import { Cause, Effect, Exit, Fiber, Layer, Result } from 'effect'

import { RetainedPages } from '../../src/extension/background/retained-pages-service.js'
import {
  emptyRetainedPageLedger,
  recordRetainedPageClosure,
  recordRetainedPageClosures,
  RETAINED_PAGE_LIFETIME_MS,
} from '../../src/extension/retained-pages-ledger.js'
import {
  RetainedPageLedgerStorage,
  parseRetainedPageLedgerValue,
  type RetainedPageLedgerStorageBackend,
} from '../../src/extension/retained-pages-storage.js'
import {
  OpenSurfaceInventoryStorage,
  parseOpenSurfaceInventoryValue,
  type OpenSurfaceInventoryStorageBackend,
} from '../../src/extension/open-surface-inventory-storage.js'
import {
  emptyOpenSurfaceInventory,
  markOpenSurfaceClosure,
  OPEN_SURFACE_INVENTORY_SCHEMA_VERSION,
  seedOpenSurfaceInventory,
} from '../../src/extension/open-surface-inventory.js'
import { createRetainedPageIdentity } from '../../src/extension/retained-page-identity.js'
import {
  RetentionHealth,
  type RetentionHealthStorageBackend,
} from '../../src/extension/retention-health.js'
import type {
  RetainedPageActivationDisposition,
  RetainedPagesOptions,
} from '../../src/extension/background/retained-pages-service.js'

function exampleClosure(closedAt = 1_000) {
  return {
    identityDigest: 'identity-example',
    surfaceKind: 'normal-tab' as const,
    canonicalKey: 'https://example.test/article',
    url: 'https://example.test/article?view=exact#comment',
    title: 'Example article',
    favIconUrl: 'https://example.test/favicon.ico',
    closedAt,
    closureToken: 'lifetime-example',
  }
}

function retainedPagesLayer(
  ledgerBackend: RetainedPageLedgerStorageBackend,
  inventoryBackend?: OpenSurfaceInventoryStorageBackend,
  now: () => number = () => 1_000,
  options: Partial<RetainedPagesOptions> = {},
  healthBackend?: RetentionHealthStorageBackend,
) {
  let sessionInventory: unknown
  let durableInventory: unknown
  const inventories = inventoryBackend || {
    readSession: async () => sessionInventory,
    writeSession: async (value) => {
      sessionInventory = value
    },
    readDurable: async () => durableInventory,
    writeDurable: async (value) => {
      durableInventory = value
    },
  }
  let healthStored: unknown
  const health = healthBackend || {
    read: async () => healthStored,
    write: async (value) => {
      healthStored = value
    },
    clear: async () => {
      healthStored = undefined
    },
  }
  const dependencies = Layer.mergeAll(
    RetainedPageLedgerStorage.layer(ledgerBackend),
    OpenSurfaceInventoryStorage.layer(inventories),
    RetentionHealth.layer(health, now),
  )
  return RetainedPages.layer({ now, ...options }).pipe(
    Layer.provide(dependencies),
  )
}

function useRetainedPages<A, E, R>(
  layer: Layer.Layer<RetainedPages>,
  use: (service: RetainedPages['Service']) => Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(RetainedPages, use).pipe(Effect.provide(layer))
}

function retainedLedgerWithExample(closedAt = 1_000) {
  return recordRetainedPageClosure(
    emptyRetainedPageLedger(),
    exampleClosure(closedAt),
  ).ledger
}

it.effect('RetainedPages captures one genuine closure in the durable ledger', () => {
  let stored: unknown
  const backend: RetainedPageLedgerStorageBackend = {
    read: async () => stored,
    write: async (value) => {
      stored = value
    },
  }
  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const result = yield* retainedPages.captureClosure(exampleClosure())

    assert.equal(result.outcome, 'inserted')
    const parsed = parseRetainedPageLedgerValue(stored)
    assert.equal(parsed.status, 'valid')
    assert.equal(parsed.ledger.pages['identity-example']?.closureToken, 'lifetime-example')
  }).pipe(Effect.provide(retainedPagesLayer(backend)))
})

it.effect('RetainedPages retries an automatic capture write exactly once', () => {
  let stored: unknown
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async (value) => {
      writeCount += 1
      if (writeCount === 1) throw new Error('transient write failure')
      stored = value
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    yield* retainedPages.captureClosure(exampleClosure())

    assert.equal(writeCount, 2)
    assert.equal(parseRetainedPageLedgerValue(stored).status, 'valid')
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages preserves the prior durable ledger when both capture writes fail', () => {
  const priorLedger = {
    schemaVersion: 1 as const,
    identityVersion: 1 as const,
    pages: {
      'identity-prior': {
        ...exampleClosure(500),
        identityDigest: 'identity-prior',
        closureToken: 'lifetime-prior',
      },
    },
    removalBoundaries: {},
  }
  const stored: unknown = priorLedger
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async () => {
      writeCount += 1
      throw new Error('persistent write failure')
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const failure = yield* Effect.result(retainedPages.captureClosure(exampleClosure()))
    assert.equal(Result.isFailure(failure), true)

    assert.equal(writeCount, 2)
    assert.equal(stored, priorLedger)
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages records capture health only after its one retry is exhausted', () => {
  let ledgerStored: unknown
  let healthStored: unknown
  let captureShouldFail = true
  let healthClearCount = 0
  const layer = retainedPagesLayer({
    read: async () => ledgerStored,
    write: async (value) => {
      if (captureShouldFail) throw new Error('persistent capture failure')
      ledgerStored = value
    },
  }, undefined, () => 1_000, {}, {
    read: async () => healthStored,
    write: async (episode) => {
      healthStored = episode
    },
    clear: async () => {
      healthClearCount += 1
      healthStored = undefined
    },
  })
  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const failure = yield* Effect.result(retainedPages.captureClosure(exampleClosure()))
    assert.equal(Result.isFailure(failure), true)
    assert.deepEqual(healthStored, {
      failureKind: 'capture',
      operationKind: 'automatic-capture',
      retryState: 'exhausted-after-one-retry',
      startedAt: 1_000,
      lastFailedAt: 1_000,
    })

    captureShouldFail = false
    yield* retainedPages.captureClosure({
      ...exampleClosure(2_000),
      closureToken: 'recovered-lifetime',
    })
    assert.equal(healthStored, undefined)
    assert.equal(healthClearCount, 1)
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages never retries a rejected batch removal write', () => {
  const priorLedger = retainedLedgerWithExample()
  const stored: unknown = priorLedger
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async () => {
      writeCount += 1
      throw new Error('batch write failure')
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const failure = yield* Effect.result(retainedPages.removeSnapshots([
      { identityDigest: 'identity-example', closureToken: 'lifetime-example' },
    ]))
    assert.equal(Result.isFailure(failure), true)

    assert.equal(writeCount, 1)
    assert.equal(stored, priorLedger)
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages treats expiry-before-removal as success even when physical cleanup is delayed', () => {
  const priorLedger = retainedLedgerWithExample()
  const stored: unknown = priorLedger
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async () => {
      writeCount += 1
      throw new Error('cleanup unavailable')
    },
  }, undefined, () => 1_000 + RETAINED_PAGE_LIFETIME_MS)

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const result = yield* retainedPages.removeSnapshots([{
      identityDigest: 'identity-example',
      closureToken: 'lifetime-example',
    }])

    assert.equal(result.results[0]?.outcome, 'already-absent')
    assert.equal(writeCount, 1)
    assert.equal(stored, priorLedger)
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages preserves mixed expired and stale outcomes when cleanup is delayed', () => {
  const newerClosure = {
    ...exampleClosure(2_000),
    identityDigest: 'identity-newer',
    canonicalKey: 'https://example.test/newer',
    url: 'https://example.test/newer',
    closureToken: 'lifetime-newer',
  }
  const priorLedger = recordRetainedPageClosures(
    emptyRetainedPageLedger(),
    [exampleClosure(), newerClosure],
  ).ledger
  const stored: unknown = priorLedger
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async () => {
      writeCount += 1
      throw new Error('cleanup unavailable')
    },
  }, undefined, () => 1_000 + RETAINED_PAGE_LIFETIME_MS)

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const result = yield* retainedPages.removeSnapshots([
      { identityDigest: 'identity-example', closureToken: 'lifetime-example' },
      { identityDigest: 'identity-newer', closureToken: 'lifetime-stale' },
    ])

    assert.deepEqual(result.results.map(({ outcome }) => outcome), [
      'already-absent',
      'stale',
    ])
    assert.equal(result.changed, false)
    assert.equal(writeCount, 1)
    assert.equal(stored, priorLedger)
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages preserves an unknown newer ledger and refuses a false empty read', () => {
  const futureLedger = {
    schemaVersion: 2,
    identityVersion: 1,
    pages: { future: { shape: 'unknown' } },
    removalBoundaries: {},
  }
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => futureLedger,
    write: async () => {
      writeCount += 1
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const failure = yield* Effect.result(retainedPages.getLedger())
    assert.equal(Result.isFailure(failure), true)
    if (Result.isFailure(failure)) {
      assert.equal(failure.failure._tag, 'RetainedPagesNewerVersionError')
    }
    assert.equal(writeCount, 0)
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages resets only a malformed current ledger during an authoritative read', () => {
  let stored: unknown = {
    schemaVersion: 1,
    identityVersion: 1,
    pages: { broken: true },
    removalBoundaries: {},
  }
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async (value) => {
      writeCount += 1
      stored = value
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const ledger = yield* retainedPages.getLedger()

    assert.deepEqual(ledger, emptyRetainedPageLedger())
    assert.equal(writeCount, 1)
    assert.equal(parseRetainedPageLedgerValue(stored).status, 'valid')
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages records restore health when it resets a malformed current ledger', () => {
  let healthStored: unknown
  let healthClearCount = 0
  let stored: unknown = {
    schemaVersion: 1,
    identityVersion: 1,
    pages: { broken: true },
    removalBoundaries: {},
  }
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async (value) => {
      stored = value
    },
  }, undefined, () => 2_000, {}, {
    read: async () => healthStored,
    write: async (episode) => {
      healthStored = episode
    },
    clear: async () => {
      healthClearCount += 1
      healthStored = undefined
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    yield* retainedPages.getLedger()

    assert.deepEqual(healthStored, {
      failureKind: 'restore',
      operationKind: 'retained-ledger-reset',
      retryState: 'not-applicable',
      startedAt: 2_000,
      lastFailedAt: 2_000,
    })
    assert.equal(healthClearCount, 0, 'the reset itself must remain reportable')

    yield* retainedPages.captureClosure(exampleClosure(3_000))
    assert.equal(healthStored, undefined)
    assert.equal(healthClearCount, 1, 'a later valid ledger write proves recovery')
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages records restore health when it rebuilds a malformed durable inventory', () => {
  let sessionStored: unknown
  let durableStored: unknown = {
    schemaVersion: 1,
    identityVersion: 1,
    entries: { broken: true },
  }
  let healthStored: unknown
  const layer = retainedPagesLayer({
    read: async () => undefined,
    write: async () => undefined,
  }, {
    readSession: async () => sessionStored,
    writeSession: async (value) => {
      sessionStored = value
    },
    readDurable: async () => durableStored,
    writeDurable: async (value) => {
      durableStored = value
    },
  }, () => 3_000, {}, {
    read: async () => healthStored,
    write: async (episode) => {
      healthStored = episode
    },
    clear: async () => {
      healthStored = undefined
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    yield* retainedPages.reconcileOpenSurfaces(
      'worker-resume',
      [{
        tabId: 1,
        surfaceKind: 'normal-tab',
        url: 'https://example.test/open',
        title: 'Open',
      }],
    )

    assert.equal(parseOpenSurfaceInventoryValue(durableStored).status, 'valid')
    assert.deepEqual(healthStored, {
      failureKind: 'restore',
      operationKind: 'durable-inventory-reset',
      retryState: 'not-applicable',
      startedAt: 3_000,
      lastFailedAt: 3_000,
    })
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages records generic restore health when live reconciliation capture fails', () => {
  let healthStored: unknown
  const layer = retainedPagesLayer({
    read: async () => undefined,
    write: async () => undefined,
  }, undefined, () => 3_500, {}, {
    read: async () => healthStored,
    write: async (episode) => { healthStored = episode },
    clear: async () => { healthStored = undefined },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    const exit = yield* Effect.exit(retainedPages.reconcileOpenSurfaces(
      'worker-resume',
      Promise.reject(new Error('live capture unavailable')),
    ))
    assert.equal(Exit.isFailure(exit), true)
    if (Exit.isFailure(exit)) {
      assert.match(Cause.pretty(exit.cause), /live capture unavailable/)
    }

    assert.deepEqual(healthStored, {
      failureKind: 'restore',
      operationKind: 'open-surface-coverage',
      retryState: 'not-applicable',
      startedAt: 3_500,
      lastFailedAt: 3_500,
    })
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages preserves unknown newer inventories and reports incomplete coverage', () => {
  const newerSession = {
    schemaVersion: OPEN_SURFACE_INVENTORY_SCHEMA_VERSION + 1,
    identityVersion: 1,
    entries: { future: true },
  }
  const newerDurable = {
    schemaVersion: 1,
    identityVersion: 2,
    entries: { future: true },
  }
  let sessionStored: unknown = newerSession
  let durableStored: unknown = newerDurable
  let healthStored: unknown
  const layer = retainedPagesLayer({
    read: async () => undefined,
    write: async () => undefined,
  }, {
    readSession: async () => sessionStored,
    writeSession: async (value) => { sessionStored = value },
    readDurable: async () => durableStored,
    writeDurable: async (value) => { durableStored = value },
  }, () => 3_750, {}, {
    read: async () => healthStored,
    write: async (episode) => { healthStored = episode },
    clear: async () => { healthStored = undefined },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    yield* retainedPages.reconcileOpenSurfaces(
      'first-install',
      [{
        tabId: 1,
        surfaceKind: 'normal-tab',
        url: 'https://example.test/current',
        title: 'Current',
      }],
    )

    assert.deepEqual(sessionStored, newerSession)
    assert.deepEqual(durableStored, newerDurable)
    assert.deepEqual(healthStored, {
      failureKind: 'restore',
      operationKind: 'open-surface-coverage',
      retryState: 'not-applicable',
      startedAt: 3_750,
      lastFailedAt: 3_750,
    })
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages first installation seeds inventories without creating closed pages', () => {
  let ledgerStored: unknown
  let ledgerWriteCount = 0
  let sessionStored: unknown
  let durableStored: unknown
  const layer = retainedPagesLayer({
    read: async () => ledgerStored,
    write: async (value) => {
      ledgerWriteCount += 1
      ledgerStored = value
    },
  }, {
    readSession: async () => sessionStored,
    writeSession: async (value) => {
      sessionStored = value
    },
    readDurable: async () => durableStored,
    writeDurable: async (value) => {
      durableStored = value
    },
  })

  return Effect.gen(function* () {
    const retainedPages = yield* RetainedPages
    yield* retainedPages.reconcileOpenSurfaces(
      'first-install',
      [{
        tabId: 1,
        surfaceKind: 'normal-tab',
        url: 'https://example.test/open',
        title: 'Open',
      }],
    )

    assert.equal(ledgerWriteCount, 0)
    assert.equal(ledgerStored, undefined)
    assert.equal(parseOpenSurfaceInventoryValue(sessionStored).status, 'valid')
    assert.equal(parseOpenSurfaceInventoryValue(durableStored).status, 'valid')
  }).pipe(Effect.provide(layer))
})

it.effect('RetainedPages browser startup captures prior durable lifetimes before seeding restored tabs', () => {
  const observation = {
    tabId: 1,
    surfaceKind: 'normal-tab' as const,
    url: 'https://example.test/restored',
    title: 'Restored',
  }
  return Effect.gen(function* () {
    const priorInventory = yield* Effect.promise(() => seedOpenSurfaceInventory([observation], {
      closureTokenFactory: () => 'prior-browser-lifetime',
    }))
    let ledgerStored: unknown
    let sessionStored: unknown
    let durableStored: unknown = priorInventory
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableStored = value
      },
    })

    yield* Effect.gen(function* () {
      const retainedPages = yield* RetainedPages
      const result = yield* retainedPages.reconcileOpenSurfaces('browser-startup', [observation])

      assert.equal(result.inferredClosures, 1)
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(
        Object.values(ledger.ledger.pages)[0]?.closureToken,
        'prior-browser-lifetime',
      )
      const session = parseOpenSurfaceInventoryValue(sessionStored)
      assert.equal(session.status, 'valid')
      assert.notEqual(session.inventory.entries['1']?.closureToken, 'prior-browser-lifetime')
    }).pipe(Effect.provide(layer))
  })
})

it.effect('RetainedPages reconciliation reuses its checkpointed closure time after final inventory writes fail', () => {
  return Effect.gen(function* () {
    const prior = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 91,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/reconciliation-replay',
      title: 'Reconciliation replay',
    }], { closureTokenFactory: () => 'reconciliation-lifetime' }))
    let now = 1_000
    let ledgerStored: unknown
    let sessionStored: unknown
    let durableStored: unknown = prior
    let sessionWrites = 0
    let durableWrites = 0
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => { ledgerStored = value },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionWrites += 1
        if (sessionWrites === 2) throw new Error('final session checkpoint unavailable')
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableWrites += 1
        if (durableWrites === 2) throw new Error('final durable checkpoint unavailable')
        durableStored = value
      },
    }, () => now)

    yield* Effect.gen(function* () {
      const service = yield* RetainedPages
      yield* service.reconcileOpenSurfaces('browser-startup', [])
      now = 2_000
      yield* service.reconcileOpenSurfaces('browser-startup', [])

      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closedAt, 1_000)
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closureToken, 'reconciliation-lifetime')
    }).pipe(Effect.provide(layer))
  })
})

it.effect('RetainedPages worker resume falls back to valid durable inventory when session state is missing', () => {
  return Effect.gen(function* () {
    const durableInventory = yield* Effect.promise(() => seedOpenSurfaceInventory([
      {
        tabId: 1,
        surfaceKind: 'normal-tab',
        url: 'https://example.test/surviving',
        title: 'Surviving',
      },
      {
        tabId: 2,
        surfaceKind: 'normal-tab',
        url: 'https://example.test/missing',
        title: 'Missing',
      },
    ], {
      closureTokenFactory: (() => {
        let token = 0
        return () => `durable-lifetime-${++token}`
      })(),
    }))
    let ledgerStored: unknown
    let sessionStored: unknown
    let durableStored: unknown = durableInventory
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableStored = value
      },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const result = yield* retainedPages.reconcileOpenSurfaces('worker-resume', [{
        tabId: 1,
        surfaceKind: 'normal-tab',
        url: 'https://example.test/surviving',
        title: 'Surviving',
      }])

      assert.equal(result.inferredClosures, 1)
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(
        Object.values(ledger.ledger.pages)[0]?.closureToken,
        'durable-lifetime-2',
      )
      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.equal(session.inventory.entries['1']?.closureToken, 'durable-lifetime-1')
      assert.equal(durable.inventory.entries['1']?.closureToken, 'durable-lifetime-1')
    }))
  })
})

it.effect('RetainedPages records an ordinary physical close before removing its inventory lifetime', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 7,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/closed',
      title: 'Closed',
    }], { closureTokenFactory: () => 'ordinary-close-lifetime' }))
    let ledgerStored: unknown
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableStored = value
      },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const result = yield* retainedPages.captureClosedSurface(7)

      assert.equal(result.outcome, 'inserted')
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(
        Object.values(ledger.ledger.pages)[0]?.closureToken,
        'ordinary-close-lifetime',
      )
      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.deepEqual(session.inventory.entries, {})
      assert.deepEqual(durable.inventory.entries, {})
    }))
  })
})

it.effect('RetainedPages does not rewrite valid inventories for an all-missing close batch', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 1,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/still-open',
      title: 'Still open',
    }], { closureTokenFactory: () => 'still-open-lifetime' }))
    let ledgerWrites = 0
    let sessionWrites = 0
    let durableWrites = 0
    const layer = retainedPagesLayer({
      read: async () => undefined,
      write: async () => { ledgerWrites += 1 },
    }, {
      readSession: async () => inventory,
      writeSession: async () => { sessionWrites += 1 },
      readDurable: async () => inventory,
      writeDurable: async () => { durableWrites += 1 },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const captured = yield* retainedPages.captureClosedSurfaces([999, 999])

      assert.equal(captured.ledger, null)
      assert.deepEqual(captured.results, [{ changed: false, outcome: 'missing' }])
      assert.equal(ledgerWrites, 0)
      assert.equal(sessionWrites, 0)
      assert.equal(durableWrites, 0)
    }))
  })
})

it.effect('RetainedPages falls back per tab from a missing session candidate to durable inventory', () => {
  return Effect.gen(function* () {
    const durableInventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 71,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/durable-candidate',
      title: 'Durable candidate',
    }], { closureTokenFactory: () => 'durable-candidate-lifetime' }))
    let ledgerStored: unknown
    let sessionStored: unknown = emptyOpenSurfaceInventory()
    let durableStored: unknown = durableInventory
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => { ledgerStored = value },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => { sessionStored = value },
      readDurable: async () => durableStored,
      writeDurable: async (value) => { durableStored = value },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const result = yield* retainedPages.captureClosedSurface(71)

      assert.equal(result.outcome, 'inserted')
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(
        ledger.ledger.pages[Object.keys(ledger.ledger.pages)[0] || '']?.closureToken,
        'durable-candidate-lifetime',
      )
      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.notEqual(session.status, 'newer')
      assert.notEqual(durable.status, 'newer')
      if (session.status === 'newer' || durable.status === 'newer') return
      assert.deepEqual(session.inventory.entries, {})
      assert.deepEqual(durable.inventory.entries, {})
    }))
  })
})

it.effect('RetainedPages isolates a failed session read and still captures from durable inventory', () => {
  return Effect.gen(function* () {
    const durableInventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 72,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/read-fallback',
      title: 'Read fallback',
    }], { closureTokenFactory: () => 'read-fallback-lifetime' }))
    let ledgerStored: unknown
    let durableStored: unknown = durableInventory
    let sessionWriteCount = 0
    let healthStored: unknown
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => { ledgerStored = value },
    }, {
      readSession: async () => { throw new Error('session unavailable') },
      writeSession: async () => { sessionWriteCount += 1 },
      readDurable: async () => durableStored,
      writeDurable: async (value) => { durableStored = value },
    }, () => 1_000, {}, {
      read: async () => healthStored,
      write: async (value) => { healthStored = value },
      clear: async () => { healthStored = undefined },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const result = yield* retainedPages.captureClosedSurface(72)

      assert.equal(result.outcome, 'inserted')
      assert.equal(sessionWriteCount, 0)
      assert.equal(parseRetainedPageLedgerValue(ledgerStored).status, 'valid')
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.notEqual(durable.status, 'newer')
      if (durable.status === 'newer') return
      assert.deepEqual(durable.inventory.entries, {})
      assert.deepEqual(healthStored, {
        failureKind: 'capture',
        operationKind: 'open-surface-coverage',
        retryState: 'not-applicable',
        startedAt: 1_000,
        lastFailedAt: 1_000,
      })
    }))
  })
})

it.effect('RetainedPages drains an adjacent close batch through one ledger transaction', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([
      {
        tabId: 21,
        surfaceKind: 'normal-tab',
        url: 'https://one.example.test/',
        title: 'One',
      },
      {
        tabId: 22,
        surfaceKind: 'normal-tab',
        url: 'https://two.example.test/',
        title: 'Two',
      },
      {
        tabId: 23,
        surfaceKind: 'app',
        url: 'https://app.example.test/',
        title: 'App',
      },
    ], {
      closureTokenFactory: (() => {
        let token = 0
        return () => `batch-lifetime-${++token}`
      })(),
    }))
    let ledgerStored: unknown
    let ledgerWrites = 0
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let sessionWrites = 0
    let durableWrites = 0
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerWrites += 1
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionWrites += 1
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableWrites += 1
        durableStored = value
      },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const captured = yield* retainedPages.captureClosedSurfaces([21, 22, 23])

      assert.ok(captured.ledger)
      assert.deepEqual(captured.results.map((result) => result.outcome), [
        'inserted',
        'inserted',
        'inserted',
      ])
      assert.equal(ledgerWrites, 1)
      assert.equal(sessionWrites, 2)
      assert.equal(durableWrites, 2)
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(Object.keys(ledger.ledger.pages).length, 3)
      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.deepEqual(session.inventory.entries, {})
      assert.deepEqual(durable.inventory.entries, {})
    }))
  })
})

it.effect('RetainedPages isolates one cleanup-store failure and replays without refreshing the lifetime', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 8,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/interrupted',
      title: 'Interrupted',
    }], { closureTokenFactory: () => 'interrupted-lifetime' }))
    let now = 1_000
    let ledgerStored: unknown
    let ledgerWriteCount = 0
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let sessionWriteCount = 0
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerWriteCount += 1
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionWriteCount += 1
        if (sessionWriteCount === 2) throw new Error('worker stopped before cleanup')
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableStored = value
      },
    }, () => now)

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.captureClosedSurface(8)
      now = 2_000
      const replay = yield* retainedPages.captureClosedSurface(8)

      assert.equal(replay.outcome, 'replayed')
      assert.equal(ledgerWriteCount, 1)
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closedAt, 1_000)
      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.deepEqual(session.inventory.entries, {})
      assert.deepEqual(durable.inventory.entries, {})
    }))
  })
})

it.effect('RetainedPages preserves a durable closure time when the matching session mark failed', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 9,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/partial-mark',
      title: 'Partial mark',
    }], { closureTokenFactory: () => 'partial-mark-lifetime' }))
    let now = 1_000
    let ledgerStored: unknown
    let rejectLedgerWrites = true
    let rejectSessionMark = true
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        if (rejectLedgerWrites) throw new Error('ledger unavailable')
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        if (rejectSessionMark) {
          rejectSessionMark = false
          throw new Error('session mark unavailable')
        }
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableStored = value
      },
    }, () => now)

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const failure = yield* Effect.result(retainedPages.captureClosedSurface(9))
      assert.equal(Result.isFailure(failure), true)
      const partiallyMarkedSession = parseOpenSurfaceInventoryValue(sessionStored)
      const partiallyMarkedDurable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(partiallyMarkedSession.status, 'valid')
      assert.equal(partiallyMarkedDurable.status, 'valid')
      assert.equal(partiallyMarkedSession.inventory.entries['9']?.closedAt, undefined)
      assert.equal(partiallyMarkedDurable.inventory.entries['9']?.closedAt, 1_000)

      now = 2_000
      rejectLedgerWrites = false
      yield* retainedPages.captureClosedSurface(9)

      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closedAt, 1_000)
    }))
  })
})

it.effect('RetainedPages chooses the earliest marked time for one matching lifetime token', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 10,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/conflicting-marks',
      title: 'Conflicting marks',
    }], { closureTokenFactory: () => 'matching-lifetime' }))
    const entry = inventory.entries['10']
    assert.ok(entry)
    const session = {
      ...inventory,
      entries: { 10: { ...entry, closedAt: 2_000 } },
    }
    const durable = {
      ...inventory,
      entries: { 10: { ...entry, closedAt: 1_000 } },
    }
    let ledgerStored: unknown
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => { ledgerStored = value },
    }, {
      readSession: async () => session,
      writeSession: async () => undefined,
      readDurable: async () => durable,
      writeDurable: async () => undefined,
    }, () => 3_000)

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.captureClosedSurface(10)

      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closedAt, 1_000)
    }))
  })
})

it.effect('RetainedPages keeps current-session precedence for different lifetime tokens', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 11,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/session-precedence',
      title: 'Session precedence',
    }], { closureTokenFactory: () => 'base-lifetime' }))
    const entry = inventory.entries['11']
    assert.ok(entry)
    const session = {
      ...inventory,
      entries: {
        11: { ...entry, closureToken: 'session-lifetime', closedAt: 2_000 },
      },
    }
    const durable = {
      ...inventory,
      entries: {
        11: { ...entry, closureToken: 'durable-lifetime', closedAt: 1_000 },
      },
    }
    let ledgerStored: unknown
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => { ledgerStored = value },
    }, {
      readSession: async () => session,
      writeSession: async () => undefined,
      readDurable: async () => durable,
      writeDurable: async () => undefined,
    }, () => 3_000)

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.captureClosedSurface(11)

      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closureToken, 'session-lifetime')
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closedAt, 2_000)
    }))
  })
})

it.effect('RetainedPages replays after durable cleanup fails without refreshing time', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 12,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/durable-cleanup',
      title: 'Durable cleanup',
    }], { closureTokenFactory: () => 'durable-cleanup-lifetime' }))
    let now = 1_000
    let ledgerStored: unknown
    let ledgerWrites = 0
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let durableWrites = 0
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerWrites += 1
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => { sessionStored = value },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableWrites += 1
        if (durableWrites === 2) throw new Error('durable cleanup interrupted')
        durableStored = value
      },
    }, () => now)

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.captureClosedSurface(12)
      now = 2_000
      const replay = yield* retainedPages.captureClosedSurface(12)

      assert.equal(replay.outcome, 'replayed')
      assert.equal(ledgerWrites, 1)
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(ledger.status, 'valid')
      assert.equal(Object.values(ledger.ledger.pages)[0]?.closedAt, 1_000)
    }))
  })
})

it.effect('a partially cleaned lifetime cannot revive after its original expiry', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 18,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/expired-replay',
      title: 'Expired replay',
    }], { closureTokenFactory: () => 'expired-replay-lifetime' }))
    let now = 1_000
    let ledgerStored: unknown
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let sessionWriteCount = 0
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionWriteCount += 1
        if (sessionWriteCount === 2) throw new Error('cleanup interrupted')
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableStored = value
      },
    }, () => now)

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.captureClosedSurface(18)
      now += RETAINED_PAGE_LIFETIME_MS

      const replay = yield* retainedPages.captureClosedSurface(18)
      const ledger = parseRetainedPageLedgerValue(ledgerStored)

      assert.equal(replay.outcome, 'replayed')
      assert.equal(ledger.status, 'valid')
      assert.deepEqual(ledger.ledger.pages, {})
    }))
  })
})

it.effect('a marked delayed lifetime cannot displace a saturated newer ledger', () => {
  return Effect.gen(function* () {
    let ledgerStored = emptyRetainedPageLedger()
    for (let index = 0; index < 500; index += 1) {
      ledgerStored = recordRetainedPageClosure(ledgerStored, {
        ...exampleClosure(2_000 + index),
        identityDigest: `identity-capacity-${index}`,
        canonicalKey: `https://example.test/capacity/${index}`,
        url: `https://example.test/capacity/${index}`,
        closureToken: `capacity-lifetime-${index}`,
      }).ledger
    }
    const openInventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 19,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/delayed-capacity',
      title: 'Delayed capacity',
    }], { closureTokenFactory: () => 'delayed-capacity-lifetime' }))
    const markedInventory = markOpenSurfaceClosure(
      openInventory,
      19,
      1_000,
      'delayed-capacity-lifetime',
    ).inventory
    let sessionStored: unknown = markedInventory
    let durableStored: unknown = markedInventory
    let ledgerWrites = 0
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => {
        ledgerWrites += 1
        ledgerStored = value
      },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => {
        sessionStored = value
      },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        durableStored = value
      },
    }, () => 10_000)

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      const result = yield* retainedPages.captureClosedSurface(19)

      assert.equal(result.outcome, 'stale')
      assert.equal(ledgerWrites, 1)
      assert.equal(Object.keys(ledgerStored.pages).length, 500)
      assert.equal(ledgerStored.pages['identity-example'], undefined)
      const delayedIdentity = yield* Effect.promise(() => createRetainedPageIdentity({
        surfaceKind: 'normal-tab',
        url: 'https://example.test/delayed-capacity',
      }))
      assert.ok(delayedIdentity)
      assert.deepEqual(
        ledgerStored.removalBoundaries['delayed-capacity-lifetime'],
        {
          identityDigest: delayedIdentity.identityDigest,
          closureToken: 'delayed-capacity-lifetime',
          expiresAt: 1_000 + RETAINED_PAGE_LIFETIME_MS,
        },
      )
    }))
  })
})

it.effect('RetainedPages observes live surfaces and transfers their lifetime across replacement', () => {
  let sessionStored: unknown
  let durableStored: unknown
  const layer = retainedPagesLayer({
    read: async () => undefined,
    write: async () => undefined,
  }, {
    readSession: async () => sessionStored,
    writeSession: async (value) => {
      sessionStored = value
    },
    readDurable: async () => durableStored,
    writeDurable: async (value) => {
      durableStored = value
    },
  })
  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    yield* retainedPages.observeOpenSurface({
      tabId: 9,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/before',
      title: 'Before',
    })
    const before = parseOpenSurfaceInventoryValue(sessionStored)
    assert.equal(before.status, 'valid')
    const token = before.inventory.entries['9']?.closureToken

    yield* retainedPages.replaceOpenSurface(9, {
      tabId: 10,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/after',
      title: 'After',
    })

    const after = parseOpenSurfaceInventoryValue(sessionStored)
    assert.equal(after.status, 'valid')
    assert.equal(after.inventory.entries['9'], undefined)
    assert.equal(after.inventory.entries['10']?.closureToken, token)
    assert.equal(after.inventory.entries['10']?.url, 'https://example.test/after')
    assert.equal(parseOpenSurfaceInventoryValue(durableStored).status, 'valid')
  }))
})

it.effect('RetainedPages collapses cross-tab aliases after a partial replacement write', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 30,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/before-partial-replacement',
      title: 'Before partial replacement',
    }], { closureTokenFactory: () => 'partial-replacement-lifetime' }))
    let ledgerStored: unknown
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let failDurableTransfer = true
    const layer = retainedPagesLayer({
      read: async () => ledgerStored,
      write: async (value) => { ledgerStored = value },
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => { sessionStored = value },
      readDurable: async () => durableStored,
      writeDurable: async (value) => {
        if (failDurableTransfer) {
          failDurableTransfer = false
          throw new Error('durable replacement write interrupted')
        }
        durableStored = value
      },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.replaceOpenSurface(30, {
        tabId: 31,
        surfaceKind: 'normal-tab',
        url: 'https://example.test/after-partial-replacement',
        title: 'After partial replacement',
      })
      const partialSession = parseOpenSurfaceInventoryValue(sessionStored)
      const partialDurable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(partialSession.status, 'valid')
      assert.equal(partialDurable.status, 'valid')
      assert.deepEqual(Object.keys(partialSession.inventory.entries), ['31'])
      assert.deepEqual(Object.keys(partialDurable.inventory.entries), ['30'])

      yield* retainedPages.captureClosedSurface(31)

      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      const ledger = parseRetainedPageLedgerValue(ledgerStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.equal(ledger.status, 'valid')
      assert.deepEqual(session.inventory.entries, {})
      assert.deepEqual(durable.inventory.entries, {})
      assert.deepEqual(Object.values(ledger.ledger.pages).map((page) => page.url), [
        'https://example.test/after-partial-replacement',
      ])
    }))
  })
})

it.effect('RetainedPages drops an invalidated asynchronous checkpoint', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 29,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/original',
      title: 'Original',
    }], { closureTokenFactory: () => 'original-lifetime' }))
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let inventoryReads = 0
    const layer = retainedPagesLayer({
      read: async () => undefined,
      write: async () => undefined,
    }, {
      readSession: async () => {
        inventoryReads += 1
        return sessionStored
      },
      writeSession: async (value) => { sessionStored = value },
      readDurable: async () => {
        inventoryReads += 1
        return durableStored
      },
      writeDurable: async (value) => { durableStored = value },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.checkpointOpenSurfaces(Promise.resolve([{
        tabId: 29,
        capture: {
          status: 'captured',
          observation: {
            tabId: 29,
            surfaceKind: 'normal-tab',
            url: 'https://example.test/stale-late-update',
            title: 'Stale late update',
          },
        },
        isCurrent: () => false,
      }]))

      assert.equal(inventoryReads, 0)
      assert.deepEqual(sessionStored, inventory)
      assert.deepEqual(durableStored, inventory)
    }))
  })
})

it.effect('RetainedPages removes stale inventory when a current capture is confirmed ineligible', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 30,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/stale',
      title: 'Stale',
    }], { closureTokenFactory: () => 'stale-lifetime' }))
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let healthStored: unknown
    const layer = retainedPagesLayer({
      read: async () => undefined,
      write: async () => undefined,
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => { sessionStored = value },
      readDurable: async () => durableStored,
      writeDurable: async (value) => { durableStored = value },
    }, () => 1_000, {}, {
      read: async () => healthStored,
      write: async (value) => { healthStored = value },
      clear: async () => { healthStored = undefined },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.checkpointOpenSurfaces(Promise.resolve([{
        tabId: 30,
        capture: { status: 'ineligible' },
        isCurrent: () => true,
      }]))

      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.deepEqual(session.inventory.entries, {})
      assert.deepEqual(durable.inventory.entries, {})
      assert.equal(healthStored, undefined)
    }))
  })
})

it.effect('RetainedPages preserves prior inventory when a current checkpoint is unavailable', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 31,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/preserve-on-unavailable',
      title: 'Preserve on unavailable',
    }], { closureTokenFactory: () => 'preserved-lifetime' }))
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    let healthStored: unknown
    const layer = retainedPagesLayer({
      read: async () => undefined,
      write: async () => undefined,
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => { sessionStored = value },
      readDurable: async () => durableStored,
      writeDurable: async (value) => { durableStored = value },
    }, () => 1_000, {}, {
      read: async () => healthStored,
      write: async (value) => { healthStored = value },
      clear: async () => { healthStored = undefined },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.checkpointOpenSurfaces(Promise.resolve([{
        tabId: 31,
        capture: { status: 'unavailable' },
        isCurrent: () => true,
      }]))

      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.equal(session.inventory.entries['31']?.closureToken, 'preserved-lifetime')
      assert.equal(durable.inventory.entries['31']?.closureToken, 'preserved-lifetime')
      assert.equal(
        (healthStored as { operationKind?: string } | undefined)?.operationKind,
        'open-surface-coverage',
      )
    }))
  })
})

it.effect('RetainedPages removes a replaced tab lifetime when its replacement cannot be captured', () => {
  return Effect.gen(function* () {
    const inventory = yield* Effect.promise(() => seedOpenSurfaceInventory([{
      tabId: 39,
      surfaceKind: 'normal-tab',
      url: 'https://example.test/replaced',
      title: 'Replaced',
    }], { closureTokenFactory: () => 'replaced-lifetime' }))
    let sessionStored: unknown = inventory
    let durableStored: unknown = inventory
    const layer = retainedPagesLayer({
      read: async () => undefined,
      write: async () => undefined,
    }, {
      readSession: async () => sessionStored,
      writeSession: async (value) => { sessionStored = value },
      readDurable: async () => durableStored,
      writeDurable: async (value) => { durableStored = value },
    })

    yield* useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
      yield* retainedPages.replaceOpenSurface(39, Promise.resolve(null))

      const session = parseOpenSurfaceInventoryValue(sessionStored)
      const durable = parseOpenSurfaceInventoryValue(durableStored)
      assert.equal(session.status, 'valid')
      assert.equal(durable.status, 'valid')
      assert.deepEqual(session.inventory.entries, {})
      assert.deepEqual(durable.inventory.entries, {})
    }))
  })
})

it.effect('RetainedPages checkpoints an adjacent observation batch with one write per inventory', () => {
  let sessionStored: unknown
  let durableStored: unknown
  let sessionWrites = 0
  let durableWrites = 0
  const layer = retainedPagesLayer({
    read: async () => undefined,
    write: async () => undefined,
  }, {
    readSession: async () => sessionStored,
    writeSession: async (value) => {
      sessionWrites += 1
      sessionStored = value
    },
    readDurable: async () => durableStored,
    writeDurable: async (value) => {
      durableWrites += 1
      durableStored = value
    },
  })

  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    yield* retainedPages.observeOpenSurfaces([
      {
        tabId: 31,
        surfaceKind: 'normal-tab',
        url: 'https://one.example.test/',
        title: 'One',
      },
      {
        tabId: 32,
        surfaceKind: 'normal-tab',
        url: 'https://two.example.test/',
        title: 'Two',
      },
      {
        tabId: 33,
        surfaceKind: 'app',
        url: 'https://app.example.test/',
        title: 'App',
      },
    ])

    assert.equal(sessionWrites, 1)
    assert.equal(durableWrites, 1)
    const session = parseOpenSurfaceInventoryValue(sessionStored)
    const durable = parseOpenSurfaceInventoryValue(durableStored)
    assert.equal(session.status, 'valid')
    assert.equal(durable.status, 'valid')
    assert.equal(Object.keys(session.inventory.entries).length, 3)
    assert.equal(Object.keys(durable.inventory.entries).length, 3)
  }))
})

it.effect('RetainedPages activates and consumes only the requested exact snapshot', () => {
  let stored: unknown = retainedLedgerWithExample()
  const recoveries: Array<{ disposition: RetainedPageActivationDisposition, url: string }> = []
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async (value) => {
      stored = value
    },
  }, undefined, undefined, {
    recoverSnapshot: async (page, disposition) => {
      recoveries.push({ disposition, url: page.url })
      return true
    },
  })

  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    const result = yield* retainedPages.activateSnapshot(
      'identity-example',
      'lifetime-example',
      'foreground-tab',
    )

    assert.deepEqual(result, { outcome: 'activated' })
    assert.deepEqual(recoveries, [{
      disposition: 'foreground-tab',
      url: 'https://example.test/article?view=exact#comment',
    }])
    const parsed = parseRetainedPageLedgerValue(stored)
    assert.equal(parsed.status, 'valid')
    assert.equal(parsed.ledger.pages['identity-example'], undefined)
  }))
})

it.effect('RetainedPages rejects a stale activation snapshot before browser recovery', () => {
  let recoveryCount = 0
  const layer = retainedPagesLayer({
    read: async () => retainedLedgerWithExample(),
    write: async () => undefined,
  }, undefined, undefined, {
    recoverSnapshot: async () => {
      recoveryCount += 1
      return true
    },
  })

  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    const result = yield* retainedPages.activateSnapshot(
      'identity-example',
      'different-lifetime',
      'foreground-tab',
    )

    assert.deepEqual(result, { outcome: 'stale' })
    assert.equal(recoveryCount, 0)
  }))
})

it.effect('RetainedPages single-flights concurrent activation for one retained identity', () => {
  let stored: unknown = retainedLedgerWithExample()
  let recoveryCount = 0
  let releaseRecovery: (() => void) | undefined
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve
  })
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async (value) => {
      stored = value
    },
  }, undefined, undefined, {
    recoverSnapshot: async () => {
      recoveryCount += 1
      await recoveryGate
      return true
    },
  })
  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    const first = yield* retainedPages.activateSnapshot(
      'identity-example',
      'lifetime-example',
      'foreground-tab',
    ).pipe(Effect.forkChild({ startImmediately: true }))
    const second = yield* retainedPages.activateSnapshot(
      'identity-example',
      'lifetime-example',
      'new-window',
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.yieldNow
    assert.equal(recoveryCount, 1)
    releaseRecovery?.()

    assert.deepEqual(yield* Fiber.joinAll([first, second]), [
      { outcome: 'activated' },
      { outcome: 'activated' },
    ])
  }))
})

it.effect('RetainedPages preserves a newer closure that arrives while an older snapshot opens', () => {
  let stored: unknown = retainedLedgerWithExample()
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async (value) => {
      stored = value
    },
  }, undefined, undefined, {
    recoverSnapshot: async () => {
      stored = recordRetainedPageClosure(
        stored as ReturnType<typeof retainedLedgerWithExample>,
        { ...exampleClosure(2_000), closureToken: 'newer-lifetime' },
      ).ledger
      return true
    },
  })

  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    const result = yield* retainedPages.activateSnapshot(
      'identity-example',
      'lifetime-example',
      'foreground-tab',
    )

    assert.deepEqual(result, { outcome: 'activated-newer-retained' })
    const parsed = parseRetainedPageLedgerValue(stored)
    assert.equal(parsed.status, 'valid')
    assert.equal(parsed.ledger.pages['identity-example']?.closureToken, 'newer-lifetime')
  }))
})

it.effect('RetainedPages reports partial success and never retries a failed consume write', () => {
  const stored: unknown = retainedLedgerWithExample()
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async () => {
      writeCount += 1
      throw new Error('explicit consume write failed')
    },
  }, undefined, undefined, {
    recoverSnapshot: async () => true,
  })

  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    const result = yield* retainedPages.activateSnapshot(
      'identity-example',
      'lifetime-example',
      'foreground-tab',
    )

    assert.deepEqual(result, { outcome: 'activated-unconsumed' })
    assert.equal(writeCount, 1)
  }))
})

it.effect('RetainedPages leaves the snapshot retained when browser recovery fails', () => {
  const stored: unknown = retainedLedgerWithExample()
  let writeCount = 0
  const layer = retainedPagesLayer({
    read: async () => stored,
    write: async () => {
      writeCount += 1
    },
  }, undefined, undefined, {
    recoverSnapshot: async () => false,
  })

  return useRetainedPages(layer, (retainedPages) => Effect.gen(function* () {
    const result = yield* retainedPages.activateSnapshot(
      'identity-example',
      'lifetime-example',
      'background-tab',
    )

    assert.deepEqual(result, { outcome: 'failed' })
    assert.equal(writeCount, 0)
  }))
})
