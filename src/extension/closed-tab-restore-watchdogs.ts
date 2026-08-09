import { Context, Effect, FiberMap, Layer } from 'effect'

export class ClosedTabRestoreWatchdogs extends Context.Service<
  ClosedTabRestoreWatchdogs,
  {
    readonly cancel: (restoreId: string) => Effect.Effect<void>
    readonly schedule: (
      restoreId: string,
      delayMs: number,
      onTimeout: () => void,
    ) => Effect.Effect<void>
  }
>()('@tab-out/app/ClosedTabRestoreWatchdogs') {
  static layer = Layer.effect(ClosedTabRestoreWatchdogs, Effect.gen(function* () {
    const watchdogs = yield* FiberMap.make<string, void, never>()

    return ClosedTabRestoreWatchdogs.of({
      cancel: (restoreId) => FiberMap.remove(watchdogs, restoreId),
      schedule: (restoreId, delayMs, onTimeout) => FiberMap.run(
        watchdogs,
        restoreId,
        Effect.sleep(delayMs).pipe(Effect.andThen(Effect.sync(onTimeout))),
      ).pipe(Effect.asVoid),
    })
  }))
}
