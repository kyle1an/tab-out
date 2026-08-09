import type { Layer } from 'effect'

import type { ChromeApi } from '../../../src/extension/background/chrome-api.js'
import type { WorkingSetActivityStorage } from '../../../src/extension/background/working-set-activity-storage.js'
import type { WorkingSetBenchmarkBackend } from './benchmark-backend.js'

function unselectedBackend(): never {
  throw new Error(
    'Working Set benchmark backend selection was not replaced at build time',
  )
}

export function makeWorkingSetActivityStorageLayer(
  _chromeApi: ChromeApi,
): Layer.Layer<WorkingSetActivityStorage> {
  return unselectedBackend()
}

export const benchmarkBackend: WorkingSetBenchmarkBackend = {
  variant: 'unselected',
  ownedStorage: { kind: 'chrome-storage', keys: [] },
  lastMutationLogicalBytes: unselectedBackend,
  lastMutationPhysicalWrites: unselectedBackend,
  writeInvocationCount: unselectedBackend,
  failNextMutation: unselectedBackend,
  corrupt: () => Promise.reject(new Error(
    'Working Set benchmark backend selection was not replaced at build time',
  )),
  reset: () => Promise.reject(new Error(
    'Working Set benchmark backend selection was not replaced at build time',
  )),
  close: unselectedBackend,
}
