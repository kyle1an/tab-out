import { Effect } from 'effect'

export type PromiseExclusiveRunner = <Value>(
  task: () => Promise<Value>,
) => Promise<Value>

/**
 * Run one Effect while a callback-based exclusive runner owns its lock.
 *
 * Browser Web Locks hold a lock until the callback's Promise settles. Resume
 * the current fiber from that callback and resolve its Promise only when the
 * Effect exits, so callers do not need to start a nested runtime. Interruption
 * before acquisition makes the eventual callback a no-op; interruption after
 * acquisition runs the Effect finalizer and releases the lock.
 */
export function runPromiseExclusiveEffect<Value, Failure, Requirements, ExclusiveFailure>(
  runExclusive: PromiseExclusiveRunner,
  effect: Effect.Effect<Value, Failure, Requirements>,
  mapExclusiveFailure: (cause: unknown) => ExclusiveFailure,
): Effect.Effect<Value, Failure | ExclusiveFailure, Requirements> {
  return Effect.callback<Value, Failure | ExclusiveFailure, Requirements>((resume, signal) => {
    let acquired = false
    let releaseLock: (() => void) | null = null

    const release = () => {
      const resolve = releaseLock
      releaseLock = null
      resolve?.()
    }

    const acquire = () => runExclusive<void>(() => {
      if (signal.aborted) return Promise.resolve()
      acquired = true
      return new Promise<void>((resolve) => {
        releaseLock = resolve
        resume(effect.pipe(Effect.ensuring(Effect.sync(release))))
      })
    })

    let request: Promise<void>
    try {
      request = acquire()
    } catch (cause) {
      resume(Effect.fail(mapExclusiveFailure(cause)))
      return
    }

    void request.catch((cause: unknown) => {
      if (!acquired && !signal.aborted) {
        resume(Effect.fail(mapExclusiveFailure(cause)))
      }
    })

    return Effect.sync(release)
  })
}
