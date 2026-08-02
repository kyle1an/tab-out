import { Deferred, Effect, Queue } from 'effect'

export type SerializedEffectQueue = {
  run: <Value, Failure>(effect: Effect.Effect<Value, Failure>) => Promise<Value>
}

/**
 * Runs effects in strict offer order within one JavaScript context. Each caller
 * awaits its own Deferred result while one on-demand drain processes queued
 * effects sequentially. Cross-context exclusion and restart recovery remain the
 * responsibility of the complete workflow submitted to this queue.
 */
export function createSerializedEffectQueue(): SerializedEffectQueue {
  const tasks = Effect.runSync(Queue.unbounded<Effect.Effect<void>>())
  let drainRunning = false

  const drainTasks = Effect.fn('serializedEffectQueue.drain')(function*() {
    while (Queue.sizeUnsafe(tasks) > 0) {
      const batch = yield* Queue.takeAll(tasks)
      for (const task of batch) yield* task
    }
  })

  function startDrain(): void {
    if (drainRunning || Queue.sizeUnsafe(tasks) === 0) return
    drainRunning = true
    const finish = () => {
      drainRunning = false
      if (Queue.sizeUnsafe(tasks) > 0) startDrain()
    }
    void Effect.runPromise(drainTasks()).then(finish, finish)
  }

  function run<Value, Failure>(effect: Effect.Effect<Value, Failure>): Promise<Value> {
    const completion = Deferred.makeUnsafe<Value, Failure>()
    const task = Deferred.complete(completion, effect).pipe(Effect.asVoid)
    Effect.runSync(Queue.offer(tasks, task))
    startDrain()
    return Effect.runPromise(Deferred.await(completion))
  }

  return { run }
}
