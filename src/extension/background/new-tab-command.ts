import { Effect, Result } from 'effect'

import {
  BackgroundCommandError,
  createActiveTabInNormalWindowEffect
} from './browser-window.js'
import type { ChromeApi } from './chrome-api.js'

export const OPEN_NEW_TAB_COMMAND = 'open-new-tab'

export const openNewTabEffect = Effect.fn('backgroundCommand.openNewTab')(
  function*(chromeApi: ChromeApi = chrome) {
    if (yield* createActiveTabInNormalWindowEffect(chromeApi, {})) return

    const windowResult = yield* Effect.result(Effect.tryPromise({
      try: () => chromeApi.windows.create({ type: 'normal', focused: true }),
      catch: (cause) => BackgroundCommandError.make({ cause })
    }))
    if (Result.isSuccess(windowResult)) return

    yield* Effect.tryPromise({
      try: () => chromeApi.tabs.create({ active: true }),
      catch: (cause) => BackgroundCommandError.make({ cause })
    })
  }
)
