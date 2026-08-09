import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from 'effect'

import type { ChromeApi } from './chrome-api.js'
import { buildOpenTabDedupePlan } from '../open-tab-dedupe-plan.js'

type BadgePresentation = {
  color: string | null
  text: string
  title: string
}

type BadgeState = {
  readonly appliedColor: string | null
  readonly appliedText: string | null
  readonly appliedTitle: string | null
  readonly inFlight: Option.Option<Deferred.Deferred<void>>
  readonly requestedVersion: number
}

type BadgeFlight = {
  readonly completion: Deferred.Deferred<void>
  readonly shouldStart: boolean
}

class BadgeBrowserReadError extends Schema.TaggedErrorClass<BadgeBrowserReadError>()(
  'BadgeBrowserReadError',
  { cause: Schema.Defect() },
) {}

class BadgePresentationWriteError extends Schema.TaggedErrorClass<BadgePresentationWriteError>()(
  'BadgePresentationWriteError',
  { cause: Schema.Defect() },
) {}

export class Badge extends Context.Service<Badge, {
  readonly refresh: Effect.Effect<void>
}>()('@tab-out/background/Badge') {
  static layer(chromeApi: ChromeApi): Layer.Layer<Badge> {
    return makeBadgeLayer(chromeApi)
  }
}

export const refreshBadge: Effect.Effect<void, never, Badge> = Effect.flatMap(
  Badge,
  (badge) => badge.refresh,
)

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

function makeBadgeLayer(chromeApi: ChromeApi): Layer.Layer<Badge> {
  return Layer.effect(Badge, Effect.gen(function* () {
    const scope = yield* Effect.scope
    const state = yield* Ref.make<BadgeState>({
      appliedColor: null,
      appliedText: null,
      appliedTitle: null,
      inFlight: Option.none(),
      requestedVersion: 0,
    })

    const readBadgePresentation = Effect.fn('Badge.readPresentation')(function* () {
      const [tabs, currentWindow] = yield* Effect.tryPromise({
        try: () => Promise.all([
          chromeApi.tabs.query({}),
          chromeApi.windows.getCurrent(),
        ]),
        catch: (cause) => BadgeBrowserReadError.make({ cause }),
      })
      if (currentWindow.id == null) {
        return yield* Effect.fail(BadgeBrowserReadError.make({
          cause: new Error('Current window unavailable'),
        }))
      }
      return badgePresentationForTabs(tabs, currentWindow.id)
    })

    const applyBadgePresentation = Effect.fn('Badge.applyPresentation')(function* (
      presentation: BadgePresentation,
      version: number,
    ) {
      let currentState = yield* Ref.get(state)
      if (presentation.text !== currentState.appliedText) {
        const writeResult = yield* Effect.result(Effect.tryPromise({
          try: () => chromeApi.action.setBadgeText({ text: presentation.text }),
          catch: (cause) => BadgePresentationWriteError.make({ cause }),
        }))
        if (Result.isFailure(writeResult)) return
        yield* Ref.update(state, (current) => ({
          ...current,
          appliedText: presentation.text,
        }))
      }

      currentState = yield* Ref.get(state)
      if (version !== currentState.requestedVersion) return
      const color = presentation.color
      if (color != null && color !== currentState.appliedColor) {
        const writeResult = yield* Effect.result(Effect.tryPromise({
          try: () => chromeApi.action.setBadgeBackgroundColor({ color }),
          catch: (cause) => BadgePresentationWriteError.make({ cause }),
        }))
        if (Result.isSuccess(writeResult)) {
          yield* Ref.update(state, (current) => ({ ...current, appliedColor: color }))
        }
      }

      currentState = yield* Ref.get(state)
      if (version !== currentState.requestedVersion || presentation.title === currentState.appliedTitle) return
      const writeResult = yield* Effect.result(Effect.tryPromise({
        try: () => chromeApi.action.setTitle({ title: presentation.title }),
        catch: (cause) => BadgePresentationWriteError.make({ cause }),
      }))
      if (Result.isSuccess(writeResult)) {
        yield* Ref.update(state, (current) => ({
          ...current,
          appliedTitle: presentation.title,
        }))
      }
    })

    const runBadgeRefreshLoop = Effect.fn('Badge.runRefreshLoop')(function* () {
      while (true) {
        const version = (yield* Ref.get(state)).requestedVersion
        const readResult = yield* Effect.result(readBadgePresentation())
        const currentVersion = (yield* Ref.get(state)).requestedVersion
        if (Result.isFailure(readResult)) {
          // A failed browser-state read is unknown, not a real zero-tab
          // snapshot. Preserve the last visible badge until a later event can
          // prove a replacement count.
          if (version === currentVersion) return
          continue
        }

        if (version !== currentVersion) continue
        yield* applyBadgePresentation(readResult.success, version)
        if (version === (yield* Ref.get(state)).requestedVersion) return
      }
    })

    const refresh = Effect.fn('Badge.refresh')(function* () {
      return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const candidate = yield* Deferred.make<void>()
        const flight = yield* Ref.modify(state, (current): readonly [BadgeFlight, BadgeState] => {
          const requestedVersion = current.requestedVersion + 1
          if (Option.isSome(current.inFlight)) {
            return [{ completion: current.inFlight.value, shouldStart: false }, {
              ...current,
              requestedVersion,
            }]
          }
          return [{ completion: candidate, shouldStart: true }, {
            ...current,
            inFlight: Option.some(candidate),
            requestedVersion,
          }]
        })

        if (flight.shouldStart) {
          yield* runBadgeRefreshLoop().pipe(
            Effect.onExit((exit) => Ref.update(state, (current) =>
              Option.isSome(current.inFlight) && current.inFlight.value === flight.completion
                ? { ...current, inFlight: Option.none() }
                : current,
            ).pipe(
              Effect.andThen(Deferred.done(flight.completion, exit)),
              Effect.asVoid,
            )),
            Effect.forkIn(scope, { startImmediately: true }),
          )
        }

        return yield* restore(Deferred.await(flight.completion))
      }))
    })

    return Badge.of({ refresh: refresh() })
  }))
}
