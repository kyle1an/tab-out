import { Cause, Effect, Exit, Schema } from 'effect'

import {
  backgroundRuntime,
  workingSetService
} from '../../src/extension/background.js'
import {
  WorkingSetActivityStorage,
  type WorkingSetActivityStorageError
} from '../../src/extension/background/working-set-activity-storage.js'
import type { WorkingSetStorageError } from '../../src/extension/background/working-set-service.js'
import type { WorkingSetActivityStore } from '../../src/extension/types'
import {
  recordWorkingSetActivityMutation
} from '../../src/extension/working-set.js'
import { makeWorkingSetStorageProfile } from '../helpers/working-set-storage-profile.js'
import { benchmarkBackend } from './working-set-backends/selected.js'
import {
  parseWorkingSetStorageBenchmarkMessage,
  workingSetStorageBenchmarkDiagnosticsSchema,
  type WorkingSetStorageBenchmarkBackend,
  type WorkingSetStorageBenchmarkDiagnostics,
  type WorkingSetStorageBenchmarkEvent,
  type WorkingSetStorageBenchmarkMessage,
  type WorkingSetStorageBenchmarkOperation,
  type WorkingSetStorageBenchmarkSuccessResponse,
  type WorkingSetStorageBenchmarkTimings
} from './working-set-storage-benchmark-protocol.js'

const selectedBackend: WorkingSetStorageBenchmarkBackend = benchmarkBackend
const activityStorage = backgroundRuntime.runSync(WorkingSetActivityStorage)

class WorkingSetStorageBenchmarkControllerError extends Schema.TaggedErrorClass<WorkingSetStorageBenchmarkControllerError>()(
  'WorkingSetStorageBenchmarkControllerError',
  {
    operation: Schema.String,
    cause: Schema.Defect()
  }
) {}

type BenchmarkCommandResult = {
  readonly operation: WorkingSetStorageBenchmarkOperation
  readonly timings: WorkingSetStorageBenchmarkTimings
  readonly activity?: WorkingSetActivityStore
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt)
}

function makeChromeTab(event: WorkingSetStorageBenchmarkEvent): chrome.tabs.Tab {
  return {
    active: true,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: true,
    id: event.tabId,
    incognito: false,
    index: 0,
    pinned: false,
    selected: true,
    status: 'complete',
    title: event.title,
    url: event.url,
    windowId: event.windowId
  }
}

function navigationEffect(
  operation: 'navigation' | 'burst',
  event: WorkingSetStorageBenchmarkEvent
): Effect.Effect<void, WorkingSetStorageBenchmarkControllerError> {
  if (event.kind !== 'navigation') {
    return Effect.fail(WorkingSetStorageBenchmarkControllerError.make({
      operation,
      cause: new Error(`${operation} accepts navigation events only`)
    }))
  }
  return workingSetService.recordTabNavigation(
    event.tabId,
    { url: event.url, title: event.title },
    makeChromeTab(event)
  ).pipe(
    Effect.mapError((cause) => WorkingSetStorageBenchmarkControllerError.make({
      operation,
      cause
    }))
  )
}

const captureDiagnostics = Effect.fn(
  'WorkingSetStorageBenchmark.captureDiagnostics'
)(function*(): Effect.fn.Return<
  WorkingSetStorageBenchmarkDiagnostics,
  WorkingSetStorageBenchmarkControllerError
> {
  const candidate = yield* Effect.try({
    try: () => ({
      variant: selectedBackend.variant,
      ownedStorage: selectedBackend.ownedStorage,
      lastMutationLogicalBytes: selectedBackend.lastMutationLogicalBytes(),
      lastMutationPhysicalWrites: selectedBackend.lastMutationPhysicalWrites(),
      writeInvocationCount: selectedBackend.writeInvocationCount()
    }),
    catch: (cause) => WorkingSetStorageBenchmarkControllerError.make({
      operation: 'diagnostics',
      cause
    })
  })
  return yield* Schema.decodeUnknownEffect(
    workingSetStorageBenchmarkDiagnosticsSchema
  )(candidate).pipe(
    Effect.mapError((cause) => WorkingSetStorageBenchmarkControllerError.make({
      operation: 'diagnostics',
      cause
    }))
  )
})

const runCommand = Effect.fn('WorkingSetStorageBenchmark.runCommand')(
  function*(
    message: WorkingSetStorageBenchmarkMessage,
    listenerStartedAt: number
  ): Effect.fn.Return<
    BenchmarkCommandResult,
    | WorkingSetStorageBenchmarkControllerError
    | WorkingSetActivityStorageError
    | WorkingSetStorageError
  > {
    switch (message.operation) {
      case 'seed-profile': {
        const profile = yield* Effect.try({
          try: () => makeWorkingSetStorageProfile(message.profile, message.now),
          catch: (cause) => WorkingSetStorageBenchmarkControllerError.make({
            operation: message.operation,
            cause
          })
        })
        const commitStartedAt = performance.now()
        yield* activityStorage.replace(profile.activity)
        const commitFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, commitFinishedAt - listenerStartedAt),
            storageCommitMs: Math.max(0, commitFinishedAt - commitStartedAt)
          }
        }
      }
      case 'replace': {
        const commitStartedAt = performance.now()
        yield* activityStorage.replace(message.activity)
        const commitFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, commitFinishedAt - listenerStartedAt),
            storageCommitMs: Math.max(0, commitFinishedAt - commitStartedAt)
          }
        }
      }
      case 'storage-read': {
        const readStartedAt = performance.now()
        const activity = yield* activityStorage.read()
        const readFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, readFinishedAt - listenerStartedAt),
            storageReadMs: Math.max(0, readFinishedAt - readStartedAt)
          },
          activity
        }
      }
      case 'service-read': {
        const readStartedAt = performance.now()
        const activity = yield* workingSetService.getWorkingSetActivity()
        const readFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, readFinishedAt - listenerStartedAt),
            serviceReadMs: Math.max(0, readFinishedAt - readStartedAt)
          },
          activity
        }
      }
      case 'domain-mutation': {
        const activity = yield* activityStorage.read()
        const mutationStartedAt = performance.now()
        const mutation = recordWorkingSetActivityMutation(activity, {
          kind: message.event.kind,
          at: message.event.at,
          tab: {
            url: message.event.url,
            rawUrl: message.event.url,
            title: message.event.title
          }
        })
        const mutationFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, mutationFinishedAt - listenerStartedAt),
            domainMutationMs: Math.max(0, mutationFinishedAt - mutationStartedAt)
          },
          activity: mutation.activity
        }
      }
      case 'storage-mutation': {
        const activity = yield* activityStorage.read()
        const mutationStartedAt = performance.now()
        const mutation = recordWorkingSetActivityMutation(activity, {
          kind: message.event.kind,
          at: message.event.at,
          tab: {
            url: message.event.url,
            rawUrl: message.event.url,
            title: message.event.title
          }
        })
        const mutationFinishedAt = performance.now()
        const commitStartedAt = performance.now()
        yield* activityStorage.write(mutation)
        const commitFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, commitFinishedAt - listenerStartedAt),
            domainMutationMs: Math.max(0, mutationFinishedAt - mutationStartedAt),
            storageCommitMs: Math.max(0, commitFinishedAt - commitStartedAt)
          }
        }
      }
      case 'navigation': {
        const mutationStartedAt = performance.now()
        yield* navigationEffect(message.operation, message.event)
        const mutationFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, mutationFinishedAt - listenerStartedAt),
            fullAppMutationMs: Math.max(0, mutationFinishedAt - mutationStartedAt)
          }
        }
      }
      case 'burst': {
        const invalidEvent = message.events.find(
          (event) => event.kind !== 'navigation'
        )
        if (invalidEvent !== undefined) {
          return yield* Effect.fail(
            WorkingSetStorageBenchmarkControllerError.make({
              operation: message.operation,
              cause: new Error('burst accepts navigation events only')
            })
          )
        }
        const mutationStartedAt = performance.now()
        yield* Effect.all(
          message.events.map((event) => navigationEffect('burst', event)),
          { concurrency: 'unbounded', discard: true }
        )
        const mutationFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, mutationFinishedAt - listenerStartedAt),
            fullAppMutationMs: Math.max(0, mutationFinishedAt - mutationStartedAt)
          }
        }
      }
      case 'fail-next-mutation':
        yield* Effect.sync(selectedBackend.failNextMutation)
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: elapsedSince(listenerStartedAt)
          }
        }
      case 'corrupt': {
        const commitStartedAt = performance.now()
        yield* Effect.tryPromise({
          try: () => selectedBackend.corrupt(message.corruption, chrome),
          catch: (cause) => WorkingSetStorageBenchmarkControllerError.make({
            operation: message.operation,
            cause
          })
        })
        const commitFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, commitFinishedAt - listenerStartedAt),
            storageCommitMs: Math.max(0, commitFinishedAt - commitStartedAt)
          }
        }
      }
      case 'reset': {
        const commitStartedAt = performance.now()
        yield* Effect.tryPromise({
          try: () => selectedBackend.reset(chrome),
          catch: (cause) => WorkingSetStorageBenchmarkControllerError.make({
            operation: message.operation,
            cause
          })
        })
        const commitFinishedAt = performance.now()
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: Math.max(0, commitFinishedAt - listenerStartedAt),
            storageCommitMs: Math.max(0, commitFinishedAt - commitStartedAt)
          }
        }
      }
      case 'diagnostics':
        return {
          operation: message.operation,
          timings: {
            listenerToCommitMs: elapsedSince(listenerStartedAt)
          }
        }
    }
  }
)

const executeMessage = Effect.fn('WorkingSetStorageBenchmark.executeMessage')(
  function*(
    message: WorkingSetStorageBenchmarkMessage,
    listenerStartedAt: number
  ): Effect.fn.Return<
    WorkingSetStorageBenchmarkSuccessResponse,
    | WorkingSetStorageBenchmarkControllerError
    | WorkingSetActivityStorageError
    | WorkingSetStorageError
  > {
    const result = yield* runCommand(message, listenerStartedAt)
    const diagnostics = yield* captureDiagnostics()
    return {
      ok: true,
      operation: result.operation,
      timings: result.timings,
      diagnostics,
      ...(result.activity === undefined ? {} : { activity: result.activity })
    }
  }
)

function describeFailure(cause: Cause.Cause<unknown>): {
  readonly name: string
  readonly message: string
} {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) {
    return {
      name: failure.name || 'Error',
      message: failure.message || Cause.pretty(cause)
    }
  }
  const message = String(failure)
  return {
    name: 'EffectFailure',
    message: message || Cause.pretty(cause)
  }
}

function controllerUrl(): string {
  return chrome.runtime.getURL('working-set-benchmark-controller.html')
}

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const listenerStartedAt = performance.now()
  const message = parseWorkingSetStorageBenchmarkMessage(rawMessage)
  if (
    message === null ||
    sender.id !== chrome.runtime.id ||
    sender.url !== controllerUrl()
  ) {
    return false
  }

  void backgroundRuntime.runPromiseExit(
    executeMessage(message, listenerStartedAt)
  ).then(
    (exit) => {
      if (Exit.isSuccess(exit)) {
        sendResponse(exit.value)
        return
      }
      sendResponse({
        ok: false,
        operation: message.operation,
        listenerToFailureMs: elapsedSince(listenerStartedAt),
        error: describeFailure(exit.cause)
      })
    },
    (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      sendResponse({
        ok: false,
        operation: message.operation,
        listenerToFailureMs: elapsedSince(listenerStartedAt),
        error: {
          name: error.name || 'Error',
          message: error.message || 'Benchmark runtime failed'
        }
      })
    }
  )
  return true
})
