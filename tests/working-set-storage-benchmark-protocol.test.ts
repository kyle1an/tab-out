import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseWorkingSetStorageBenchmarkResponse
} from './extension/working-set-storage-benchmark-protocol.js'

test('the benchmark protocol carries storage-read timing and mutation diagnostics', () => {
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
      writeInvocationCount: 0
    }
  }

  assert.deepEqual(parseWorkingSetStorageBenchmarkResponse(response), response)
  assert.equal(parseWorkingSetStorageBenchmarkResponse({
    ...response,
    diagnostics: {
      ...response.diagnostics,
      lastMutationLogicalBytes: -1
    }
  }), null)
})
