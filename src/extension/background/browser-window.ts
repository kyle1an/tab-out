import { Effect, Result, Schema } from 'effect'

import type { ChromeApi } from './chrome-api.js'

const NORMAL_WINDOW_CREATE_ATTEMPTS = 32
const NORMAL_WINDOW_FOCUS_ATTEMPTS = 2

export class BackgroundCommandError extends Schema.TaggedError<BackgroundCommandError>()(
  'BackgroundCommandError',
  { cause: Schema.Defect() },
) {}

function tryChromeCommand<Value>(run: () => Promise<Value>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => BackgroundCommandError.make({ cause }),
  })
}

const normalBrowserWindowCandidates = Effect.fn(
  'backgroundCommand.normalWindowCandidates',
)(function* (chromeApi: ChromeApi) {
  const candidates: Array<chrome.windows.Window & { id: number }> = []
  const seen = new Set<number>()
  function add(window: chrome.windows.Window | null | undefined) {
    if (typeof window?.id !== 'number' || seen.has(window.id)) return
    seen.add(window.id)
    candidates.push(window as chrome.windows.Window & { id: number })
  }

  const lastFocusedNormal = yield* tryChromeCommand(
    () => chromeApi.windows.getLastFocused({ windowTypes: ['normal'] }),
  ).pipe(Effect.catchTag('BackgroundCommandError', () => Effect.succeed(null)))
  if (lastFocusedNormal) {
    add(lastFocusedNormal)
  }

  const normalWindows = yield* tryChromeCommand(
    () => chromeApi.windows.getAll({ windowTypes: ['normal'] }),
  ).pipe(Effect.catchTag('BackgroundCommandError', () => Effect.succeed([])))
  for (const window of normalWindows.filter((candidate) => candidate.focused)) add(window)
  for (const window of normalWindows) add(window)
  return candidates.slice(0, NORMAL_WINDOW_CREATE_ATTEMPTS)
})

const focusNormalBrowserWindow = Effect.fn(
  'backgroundCommand.focusNormalWindow',
)(function* (chromeApi: ChromeApi, windowId: number) {
  for (let attempt = 0; attempt < NORMAL_WINDOW_FOCUS_ATTEMPTS; attempt += 1) {
    const result = yield* Effect.result(tryChromeCommand(
      () => chromeApi.windows.update(windowId, { focused: true }),
    ))
    if (Result.isSuccess(result) && result.success.focused) return
  }
})

export const createActiveTabInNormalWindowEffect = Effect.fn(
  'backgroundCommand.createActiveTabInNormalWindow',
)(function* (
  chromeApi: ChromeApi,
  createProperties: Omit<chrome.tabs.CreateProperties, 'active' | 'windowId'>,
) {
  const candidates = yield* normalBrowserWindowCandidates(chromeApi)
  for (const normalWindow of candidates) {
    const result = yield* Effect.result(tryChromeCommand(
      () => chromeApi.tabs.create({
        ...createProperties,
        windowId: normalWindow.id,
        active: true,
      }),
    ))
    if (Result.isFailure(result)) continue

    yield* focusNormalBrowserWindow(chromeApi, normalWindow.id)
    return true
  }

  return false
})
