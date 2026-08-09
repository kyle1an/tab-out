import { Effect, Result } from 'effect'

import {
  BackgroundCommandError,
  createActiveTabInNormalWindowEffect,
} from './browser-window.js'
import type { ChromeApi } from './chrome-api.js'

export const OPEN_FILTER_TAB_COMMAND = 'open-filter-tab'
const FOCUS_FILTER_PARAM = 'focusFilter'

function filterFocusUrl(chromeApi: ChromeApi): string {
  return `chrome-extension://${chromeApi.runtime.id}/index.html?${FOCUS_FILTER_PARAM}=1`
}

export const openFilterTabEffect = Effect.fn('backgroundCommand.openFilterTab')(
  function* (chromeApi: ChromeApi = chrome) {
    const url = filterFocusUrl(chromeApi)
    if (yield* createActiveTabInNormalWindowEffect(chromeApi, { url })) return

    const windowResult = yield* Effect.result(Effect.tryPromise({
      try: () => chromeApi.windows.create({ type: 'normal', url, focused: true }),
      catch: (cause) => BackgroundCommandError.make({ cause }),
    }))
    if (Result.isSuccess(windowResult)) return

    yield* Effect.tryPromise({
      try: () => chromeApi.tabs.create({ url, active: true }),
      catch: (cause) => BackgroundCommandError.make({ cause }),
    })
  },
)
