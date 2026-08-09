import { Effect, Result, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { requestDashboardRefresh } from './dashboard-intake.js'
import {
  addSavedPageToStore,
  removeSavedPageFromStore,
  restoreSavedPageToStore,
  type SavedPageRecord,
  type SavedPagesStore,
  type SavedPagesStoreMutation,
} from './saved-pages.js'
import {
  mutateSavedPagesStore,
  mutateSavedPagesStoreEffect,
} from './saved-pages-mutations.js'
import { showToast } from './toast.js'
import type { DashboardTab } from './types'

type SavedPageActionTarget = Pick<DashboardTab, 'url' | 'rawUrl' | 'title' | 'favIconUrl' | 'isTabOut' | 'isApp'>

type SavedPageActionDependencies = {
  mutate: typeof mutateSavedPagesStore
  mutateEffect?: typeof mutateSavedPagesStoreEffect
  refresh: typeof requestDashboardRefresh
  notify: typeof showToast
}

class SavedPageMutationError extends Schema.TaggedErrorClass<SavedPageMutationError>()(
  'SavedPageMutationError',
  { cause: Schema.Defect() },
) {}

class SavedPageRefreshError extends Schema.TaggedErrorClass<SavedPageRefreshError>()(
  'SavedPageRefreshError',
  { cause: Schema.Defect() },
) {}

/**
 * Own the failure boundary for user-triggered Saved Page actions. Context-menu
 * callbacks and toast actions are fire-and-forget, so expected storage and
 * refresh failures must be converted to feedback before they reach the UI.
 */
export function createSavedPageActions({ mutate, mutateEffect, refresh, notify }: SavedPageActionDependencies) {
  function runMutation<Value>(
    mutation: (store: SavedPagesStore) => SavedPagesStoreMutation<Value>,
  ): Effect.Effect<Value, SavedPageMutationError> {
    if (mutateEffect) {
      return mutateEffect(mutation).pipe(
        Effect.mapError((error) => SavedPageMutationError.make({ cause: error.cause })),
      )
    }
    return Effect.tryPromise({
      try: () => mutate(mutation),
      catch: (cause) => SavedPageMutationError.make({ cause }),
    })
  }

  const runSavePageTarget = Effect.fn('savedPageActions.savePageTarget')(function* (
    target: SavedPageActionTarget,
  ) {
    const mutationResult = yield* Effect.result(runMutation((store) => ({
      store: addSavedPageToStore(store, target),
      value: undefined,
    })))
    if (Result.isFailure(mutationResult)) {
      notify("Couldn't save the page")
      return
    }

    const refreshResult = yield* Effect.result(Effect.tryPromise({
      try: () => refresh({ animateCards: true }),
      catch: (cause) => SavedPageRefreshError.make({ cause }),
    }))
    if (Result.isFailure(refreshResult)) {
      notify("Page saved, but couldn't refresh the dashboard")
      return
    }

    notify('Page saved')
  })

  const runRestoreSavedPage = Effect.fn('savedPageActions.restoreSavedPage')(function* (
    removed: SavedPageRecord,
  ) {
    const mutationResult = yield* Effect.result(runMutation((store) => ({
      store: restoreSavedPageToStore(store, removed),
      value: undefined,
    })))
    if (Result.isFailure(mutationResult)) {
      notify("Couldn't restore the saved page")
      return
    }

    const refreshResult = yield* Effect.result(Effect.tryPromise({
      try: () => refresh({ animateCards: true }),
      catch: (cause) => SavedPageRefreshError.make({ cause }),
    }))
    if (Result.isFailure(refreshResult)) {
      notify("Saved page restored, but couldn't refresh the dashboard")
    }
  })

  const runRemoveSavedPageTarget = Effect.fn('savedPageActions.removeSavedPageTarget')(function* (
    keyOrUrl: string,
  ) {
    const mutationResult = yield* Effect.result(runMutation((store) => {
      const result = removeSavedPageFromStore(store, keyOrUrl)
      return { store: result.store, value: result.removed }
    }))
    if (Result.isFailure(mutationResult)) {
      notify("Couldn't remove the saved page")
      return
    }
    const removed = mutationResult.success

    const undoAction = removed
      ? {
          label: 'Undo',
          description: 'Restore this saved page.',
          onClick: () => getAppRuntime().runPromise(runRestoreSavedPage(removed)),
        }
      : null

    const refreshResult = yield* Effect.result(Effect.tryPromise({
      try: () => refresh({ animateCards: true }),
      catch: (cause) => SavedPageRefreshError.make({ cause }),
    }))
    if (Result.isFailure(refreshResult)) {
      if (undoAction) {
        notify("Saved page removed, but couldn't refresh the dashboard", undoAction)
      } else {
        notify("Couldn't refresh the dashboard")
      }
      return
    }

    if (undoAction) notify('Saved page removed', undoAction)
  })

  function savePageTarget(target: SavedPageActionTarget): Promise<void> {
    return getAppRuntime().runPromise(runSavePageTarget(target))
  }

  function removeSavedPageTarget(keyOrUrl: string): Promise<void> {
    return getAppRuntime().runPromise(runRemoveSavedPageTarget(keyOrUrl))
  }

  return { savePageTarget, removeSavedPageTarget }
}

const savedPageActions = createSavedPageActions({
  mutate: mutateSavedPagesStore,
  mutateEffect: mutateSavedPagesStoreEffect,
  refresh: requestDashboardRefresh,
  notify: showToast,
})

export const { savePageTarget, removeSavedPageTarget } = savedPageActions
