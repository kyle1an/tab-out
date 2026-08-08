import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseWorkingSetStorageBenchmarkMessage,
  parseWorkingSetStorageBenchmarkResponse,
  WORKING_SET_STORAGE_BENCHMARK_MESSAGE
} from './extension/working-set-storage-benchmark-protocol.js'

test('the benchmark protocol accepts the wake-only no-op command', () => {
  const message = {
    type: WORKING_SET_STORAGE_BENCHMARK_MESSAGE,
    operation: 'wake-only'
  }

  assert.deepEqual(parseWorkingSetStorageBenchmarkMessage(message), message)
})

test('the benchmark protocol carries coarse read phases and counters', () => {
  const response = {
    ok: true,
    operation: 'storage-read',
    timings: {
      listenerToCommitMs: 14,
      storageReadMs: 13
    },
    diagnostics: {
      variant: 'idb',
      ownedStorage: {
        kind: 'indexed-db',
        database: 'benchmark-database',
        objectStores: ['page-activity']
      },
      lastMutationLogicalBytes: 100,
      lastMutationPhysicalWrites: [],
      writeInvocationCount: 0,
      lastReadDiagnostics: {
        backendReadTotalMs: 12,
        openDatabaseMs: 2,
        expiryScanMs: 1,
        expiryDeleteMs: 0,
        retainedFetchMs: 3,
        decodeMaterializeMs: 5,
        fetchedRows: 4,
        validRows: 3,
        invalidRows: 1,
        fetchedEvents: 8,
        validEvents: 7,
        invalidEvents: 1
      }
    }
  }

  assert.deepEqual(parseWorkingSetStorageBenchmarkResponse(response), response)
  assert.equal(parseWorkingSetStorageBenchmarkResponse({
    ...response,
    diagnostics: {
      ...response.diagnostics,
      lastReadDiagnostics: {
        ...response.diagnostics.lastReadDiagnostics,
        invalidRows: -1
      }
    }
  }), null)
})
