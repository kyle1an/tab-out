import { Context, Effect, Layer, Schema } from 'effect'

import {
  parseWorkingSetActivityStorageValue,
  type WorkingSetActivityRecordMutation,
} from '../working-set.js'
import type { WorkingSetActivityStore } from '../types'

export const WORKING_SET_ACTIVITY_KEY = 'workingSetActivity'

export type WorkingSetActivityWrite = WorkingSetActivityRecordMutation

export interface WorkingSetActivityStorageBackend {
  readonly read: () => PromiseLike<unknown>
  readonly write: (change: WorkingSetActivityWrite) => PromiseLike<void>
  readonly replace: (activity: WorkingSetActivityStore) => PromiseLike<void>
  readonly retireLegacy?: () => PromiseLike<void>
  readonly close?: () => PromiseLike<void>
}

export class WorkingSetActivityStorageError extends Schema.TaggedError<WorkingSetActivityStorageError>()(
  'WorkingSetActivityStorageError',
  {
    operation: Schema.Literals([
      'read',
      'write',
      'replace',
      'retire-legacy',
    ]),
    reason: Schema.Literals(['backend', 'malformed', 'unsupported-version']),
    cause: Schema.Defect(),
  },
) {}

export class WorkingSetActivityStorage extends Context.Service<WorkingSetActivityStorage, {
  readonly read: () => Effect.Effect<WorkingSetActivityStore, WorkingSetActivityStorageError>
  readonly write: (
    change: WorkingSetActivityWrite,
  ) => Effect.Effect<void, WorkingSetActivityStorageError>
  readonly replace: (
    activity: WorkingSetActivityStore,
  ) => Effect.Effect<void, WorkingSetActivityStorageError>
  readonly retireLegacy: () => Effect.Effect<void, WorkingSetActivityStorageError>
}>()('@tab-out/background/WorkingSetActivityStorage') {
  static layer(
    backend: WorkingSetActivityStorageBackend,
  ): Layer.Layer<WorkingSetActivityStorage> {
    const read = Effect.fn('WorkingSetActivityStorage.read')(function* () {
      const stored = yield* Effect.tryPromise({
        try: backend.read,
        catch: (cause) => WorkingSetActivityStorageError.make({
          operation: 'read',
          reason: 'backend',
          cause,
        }),
      })
      const parsed = parseWorkingSetActivityStorageValue(stored)
      if (parsed.status === 'missing' || parsed.status === 'valid') {
        return parsed.activity
      }
      if (parsed.status === 'unsupported-version') {
        return yield* Effect.fail(WorkingSetActivityStorageError.make({
          operation: 'read',
          reason: 'unsupported-version',
          cause: new Error(`Unsupported Working Set activity version ${parsed.version}`),
        }))
      }
      return yield* Effect.fail(WorkingSetActivityStorageError.make({
        operation: 'read',
        reason: 'malformed',
        cause: new Error('Malformed Working Set activity storage envelope'),
      }))
    })

    const write = Effect.fn('WorkingSetActivityStorage.write')(function* (
      change: WorkingSetActivityWrite,
    ) {
      yield* Effect.tryPromise({
        try: () => backend.write(change),
        catch: (cause) => WorkingSetActivityStorageError.make({
          operation: 'write',
          reason: 'backend',
          cause,
        }),
      })
    })

    const replace = Effect.fn('WorkingSetActivityStorage.replace')(function* (
      activity: WorkingSetActivityStore,
    ) {
      yield* Effect.tryPromise({
        try: () => backend.replace(activity),
        catch: (cause) => WorkingSetActivityStorageError.make({
          operation: 'replace',
          reason: 'backend',
          cause,
        }),
      })
    })

    const retireLegacy = Effect.fn(
      'WorkingSetActivityStorage.retireLegacy',
    )(function* () {
      if (backend.retireLegacy === undefined) return
      yield* Effect.tryPromise({
        try: backend.retireLegacy,
        catch: (cause) => WorkingSetActivityStorageError.make({
          operation: 'retire-legacy',
          reason: 'backend',
          cause,
        }),
      })
    })

    const service = WorkingSetActivityStorage.of({
      read,
      write,
      replace,
      retireLegacy,
    })
    const close = backend.close
    if (close === undefined) {
      return Layer.succeed(WorkingSetActivityStorage, service)
    }
    return Layer.effect(
      WorkingSetActivityStorage,
      Effect.acquireRelease(
        Effect.succeed(service),
        () => Effect.promise(() => Promise.resolve(close())),
      ),
    )
  }
}
