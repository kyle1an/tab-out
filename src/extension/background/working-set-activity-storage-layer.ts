import type { Layer } from 'effect'

import type { ChromeApi } from './chrome-api.js'
import {
  readChromeStorageValue,
  writeChromeStorageValue,
} from './chrome-storage.js'
import {
  makeWorkingSetActivityAuthorityBackend,
  WORKING_SET_ACTIVITY_AUTHORITY_KEY,
} from './working-set-activity-authority.js'
import {
  makeWorkingSetActivityIndexedDb,
} from './working-set-activity-indexed-db.js'
import { WorkingSetActivityStorage } from './working-set-activity-storage.js'

export function makeWorkingSetActivityStorageLayer(
  chromeApi: ChromeApi,
): Layer.Layer<WorkingSetActivityStorage> {
  const storage = chromeApi.storage?.local
  const unavailable = (): Promise<never> => Promise.reject(new Error(
    'Chrome local storage is unavailable for Working Set activity',
  ))
  const read = (key: string): PromiseLike<unknown> => storage === undefined
    ? unavailable()
    : readChromeStorageValue(storage, key)
  const write = (key: string, value: unknown): PromiseLike<void> =>
    storage === undefined
      ? unavailable()
      : writeChromeStorageValue(storage, key, value)

  return WorkingSetActivityStorage.layer(
    makeWorkingSetActivityAuthorityBackend({
      chrome: {
        readMarker: () => read(WORKING_SET_ACTIVITY_AUTHORITY_KEY),
        writeMarker: (marker) => write(
          WORKING_SET_ACTIVITY_AUTHORITY_KEY,
          marker,
        ),
      },
      indexedDb: makeWorkingSetActivityIndexedDb(),
    }),
  )
}
