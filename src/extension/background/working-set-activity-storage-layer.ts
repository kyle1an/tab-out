import type { Layer } from 'effect'

import type { ChromeApi } from './chrome-api.js'
import { readChromeStorageValue, writeChromeStorageValue } from './chrome-storage.js'
import {
  WORKING_SET_ACTIVITY_KEY,
  WorkingSetActivityStorage,
  type WorkingSetActivityWrite
} from './working-set-activity-storage.js'
import type { WorkingSetActivityStore } from '../types'

export function makeWorkingSetActivityStorageLayer(
  chromeApi: ChromeApi
): Layer.Layer<WorkingSetActivityStorage> {
  const storage = chromeApi.storage?.local
  const unavailable = (): Promise<never> => Promise.reject(
    new Error('Chrome local storage is unavailable for Working Set activity')
  )
  return WorkingSetActivityStorage.layer({
    read: () => storage
      ? readChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY)
      : unavailable(),
    write: (change: WorkingSetActivityWrite) => storage
      ? writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, change.activity)
      : unavailable(),
    replace: (activity: WorkingSetActivityStore) => storage
      ? writeChromeStorageValue(storage, WORKING_SET_ACTIVITY_KEY, activity)
      : unavailable()
  })
}
