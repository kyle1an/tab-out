import { Data, Effect, Result } from 'effect'

import type { ChromeApi } from './chrome-api.js'
import { buildOpenTabDedupePlan } from '../open-tab-dedupe-plan.js'

type BadgePresentation = {
  color: string | null
  text: string
  title: string
}

export type BadgeRefreshService = {
  refresh: () => Promise<void>
}

class BadgeBrowserReadError extends Data.TaggedError('BadgeBrowserReadError')<{
  readonly cause: unknown
}> {}

class BadgePresentationWriteError extends Data.TaggedError('BadgePresentationWriteError')<{
  readonly cause: unknown
}> {}

/**
 * Counts tabs that the global dedupe action can safely close and updates the
 * extension toolbar badge. The count is close targets, not duplicate groups.
 */
function badgePresentationForTabs(tabs: chrome.tabs.Tab[], currentWindowId: number): BadgePresentation {
  const { closableCount: count } = buildOpenTabDedupePlan(tabs, currentWindowId)
  const text = count > 0 ? String(count) : ''
  const title = count > 0
    ? `Dedupe ${count} duplicate tab${count === 1 ? '' : 's'}`
    : 'Tab Out: no duplicates to dedupe'
  if (count === 0) return { color: null, text, title }
  if (count <= 10) return { color: '#3d7a4a', text, title }
  if (count <= 20) return { color: '#b8892e', text, title }
  return { color: '#b35a5a', text, title }
}

export function createBadgeRefreshService(chromeApi: ChromeApi = chrome): BadgeRefreshService {
  let inFlight: Promise<void> | null = null
  let requestedVersion = 0
  let appliedText: string | null = null
  let appliedColor: string | null = null
  let appliedTitle: string | null = null

  const readBadgePresentation = Effect.fn('badge.readPresentation')(function*() {
    const [tabs, currentWindow] = yield* Effect.tryPromise({
      try: () => Promise.all([
        chromeApi.tabs.query({}),
        chromeApi.windows.getCurrent()
      ]),
      catch: (cause) => new BadgeBrowserReadError({ cause })
    })
    if (currentWindow.id == null) {
      return yield* Effect.fail(new BadgeBrowserReadError({
        cause: new Error('Current window unavailable')
      }))
    }
    return badgePresentationForTabs(tabs, currentWindow.id)
  })

  const applyBadgePresentation = Effect.fn('badge.applyPresentation')(function*(
    presentation: BadgePresentation,
    version: number
  ) {
    if (presentation.text !== appliedText) {
      const writeResult = yield* Effect.result(Effect.tryPromise({
        try: () => chromeApi.action.setBadgeText({ text: presentation.text }),
        catch: (cause) => new BadgePresentationWriteError({ cause })
      }))
      if (Result.isFailure(writeResult)) return
      appliedText = presentation.text
    }

    if (version !== requestedVersion) return
    const color = presentation.color
    if (color != null && color !== appliedColor) {
      const writeResult = yield* Effect.result(Effect.tryPromise({
        try: () => chromeApi.action.setBadgeBackgroundColor({ color }),
        catch: (cause) => new BadgePresentationWriteError({ cause })
      }))
      if (Result.isSuccess(writeResult)) {
        appliedColor = color
      }
    }

    if (version !== requestedVersion || presentation.title === appliedTitle) return
    const writeResult = yield* Effect.result(Effect.tryPromise({
      try: () => chromeApi.action.setTitle({ title: presentation.title }),
      catch: (cause) => new BadgePresentationWriteError({ cause })
    }))
    if (Result.isSuccess(writeResult)) {
      appliedTitle = presentation.title
    }
  })

  const runBadgeRefreshLoop = Effect.fn('badge.runRefreshLoop')(function*() {
    while (true) {
      const version = requestedVersion
      const readResult = yield* Effect.result(readBadgePresentation())
      if (Result.isFailure(readResult)) {
        // A failed browser-state read is unknown, not a real zero-tab
        // snapshot. Preserve the last visible badge until a later event can
        // prove a replacement count.
        if (version === requestedVersion) return
        continue
      }

      if (version !== requestedVersion) continue
      yield* applyBadgePresentation(readResult.success, version)
      if (version === requestedVersion) return
    }
  })

  function refresh(): Promise<void> {
    requestedVersion += 1
    if (inFlight) return inFlight
    const run = Effect.runPromise(runBadgeRefreshLoop())
    inFlight = run
    const clearFlight = () => {
      if (inFlight === run) inFlight = null
    }
    void run.then(clearFlight, clearFlight)
    return run
  }

  return { refresh }
}
