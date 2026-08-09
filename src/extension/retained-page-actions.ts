import { Effect, Result, Schema } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { requestDashboardRefresh } from './dashboard-intake.js'
import {
  RETAINED_PAGE_ACTIVATE_MESSAGE,
  RETAINED_PAGES_REMOVE_MESSAGE,
  parseRetainedPageActivationResponse,
  parseRetainedPagesRemovalResponse,
  type RetainedPageActivateMessage,
  type RetainedPageActivationDisposition,
  type RetainedPagesRemoveMessage,
} from './runtime-messages.js'
import type { ChipActivationMode } from './tab-activation.js'
import { showToast } from './toast.js'
import type { RetainedPageActionTarget } from './types.js'

export type { RetainedPageActionTarget } from './types.js'

type RetainedPageActionMessage =
  | RetainedPageActivateMessage
  | RetainedPagesRemoveMessage

type RetainedPageActionDependencies = {
  sendMessage: (message: RetainedPageActionMessage) => Promise<unknown>
  refresh: typeof requestDashboardRefresh
  notify: typeof showToast
}

class RetainedPageMessageError extends Schema.TaggedErrorClass<RetainedPageMessageError>()(
  'RetainedPageMessageError',
  { cause: Schema.Defect() },
) {}

class RetainedPageRefreshError extends Schema.TaggedErrorClass<RetainedPageRefreshError>()(
  'RetainedPageRefreshError',
  { cause: Schema.Defect() },
) {}

type RetainedPageSnapshot = {
  identityDigest: string
  closureToken: string
}

function exactRetainedPageSnapshot(
  target: RetainedPageActionTarget,
): RetainedPageSnapshot | null {
  const identityDigest = target.retainedPageIdentity
  const closureToken = target.retainedPageClosureToken
  if (
    typeof identityDigest !== 'string' ||
    identityDigest.length === 0 ||
    typeof closureToken !== 'string' ||
    closureToken.length === 0
  ) {
    return null
  }
  return { identityDigest, closureToken }
}

function exactRetainedPageSnapshots(
  targets: readonly RetainedPageActionTarget[],
): RetainedPageSnapshot[] | null {
  const snapshots: RetainedPageSnapshot[] = []
  const seen = new Set<string>()
  for (const target of targets) {
    const snapshot = exactRetainedPageSnapshot(target)
    if (!snapshot) return null
    const key = `${snapshot.identityDigest}\u0000${snapshot.closureToken}`
    if (seen.has(key)) continue
    seen.add(key)
    snapshots.push(snapshot)
  }
  return snapshots.length > 0 ? snapshots : null
}

export function retainedPageActivationDisposition(
  mode: ChipActivationMode,
): RetainedPageActivationDisposition {
  switch (mode) {
    case 'focus':
      return 'focus-tab'
    case 'open-window':
      return 'new-window'
    case 'bring-background':
      return 'background-tab'
    case 'bring-foreground':
      return 'foreground-tab'
  }
}

/**
 * Page-only retained-page actions. The service worker owns both browser
 * recovery and exact-snapshot mutation, so this client never opens a URL or
 * falls back to Chrome's recently-closed sessions locally.
 */
export function createRetainedPageActions({
  sendMessage,
  refresh,
  notify,
}: RetainedPageActionDependencies) {
  function send(
    message: RetainedPageActionMessage,
  ): Effect.Effect<unknown, RetainedPageMessageError> {
    return Effect.tryPromise({
      try: () => sendMessage(message),
      catch: (cause) => RetainedPageMessageError.make({ cause }),
    })
  }

  const refreshDashboard = Effect.fn('retainedPageActions.refreshDashboard')(
    function* () {
      const result = yield* Effect.result(Effect.tryPromise({
        try: () => refresh({ animateCards: true }),
        catch: (cause) => RetainedPageRefreshError.make({ cause }),
      }))
      return Result.isSuccess(result)
    },
  )

  const runActivateRetainedPageTarget = Effect.fn(
    'retainedPageActions.activateRetainedPageTarget',
  )(function* (target: RetainedPageActionTarget, mode: ChipActivationMode) {
    const snapshot = exactRetainedPageSnapshot(target)
    if (!snapshot) {
      yield* refreshDashboard()
      notify('This closed page is no longer available.')
      return false
    }

    const responseResult = yield* Effect.result(send({
      type: RETAINED_PAGE_ACTIVATE_MESSAGE,
      ...snapshot,
      disposition: retainedPageActivationDisposition(mode),
    }))
    const response = Result.isSuccess(responseResult)
      ? parseRetainedPageActivationResponse(responseResult.success)
      : null

    if (!response) {
      yield* refreshDashboard()
      notify('Could not open page')
      return false
    }

    const refreshed = yield* refreshDashboard()
    switch (response.outcome) {
      case 'activated':
        if (!refreshed) {
          notify("Page opened, but Tabs couldn't be updated.")
        }
        return true
      case 'activated-newer-retained':
        return false
      case 'activated-unconsumed':
        notify("Page opened, but Tabs couldn't be updated.")
        return false
      case 'stale':
        notify('This closed page is no longer available.')
        return false
      case 'failed':
        notify('Could not open page')
        return false
    }
  })

  const runRemoveRetainedPageTargets = Effect.fn(
    'retainedPageActions.removeRetainedPageTargets',
  )(function* (targets: readonly RetainedPageActionTarget[]) {
    const snapshots = exactRetainedPageSnapshots(targets)
    if (!snapshots) {
      yield* refreshDashboard()
      notify('Couldn’t remove from Tabs')
      return 0
    }

    const responseResult = yield* Effect.result(send({
      type: RETAINED_PAGES_REMOVE_MESSAGE,
      snapshots,
    }))
    const response = Result.isSuccess(responseResult)
      ? parseRetainedPagesRemovalResponse(responseResult.success)
      : null

    yield* refreshDashboard()
    if (!response || response.outcomes.length !== snapshots.length) {
      notify('Couldn’t remove from Tabs')
      return 0
    }

    const completedCount = response.outcomes.filter((outcome) => outcome !== 'stale').length
    if (completedCount === snapshots.length) {
      notify(completedCount === 1 ? 'Removed from Tabs' : `Removed ${completedCount} from Tabs`)
      return completedCount
    }
    if (completedCount > 0) {
      notify(`Removed ${completedCount} of ${snapshots.length} from Tabs`)
      return completedCount
    }
    notify('Couldn’t remove from Tabs')
    return 0
  })

  function activateRetainedPageTarget(
    target: RetainedPageActionTarget,
    mode: ChipActivationMode,
  ): Promise<boolean> {
    return getAppRuntime().runPromise(runActivateRetainedPageTarget(target, mode))
  }

  function removeRetainedPageTarget(target: RetainedPageActionTarget): Promise<boolean> {
    return removeRetainedPageTargets([target]).then((completedCount) => completedCount === 1)
  }

  function removeRetainedPageTargets(
    targets: readonly RetainedPageActionTarget[],
  ): Promise<number> {
    return getAppRuntime().runPromise(runRemoveRetainedPageTargets(targets))
  }

  return {
    activateRetainedPageTarget,
    removeRetainedPageTarget,
    removeRetainedPageTargets,
  }
}

const retainedPageActions = createRetainedPageActions({
  sendMessage: async (message) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error('Extension runtime is unavailable')
    }
    return chrome.runtime.sendMessage(message)
  },
  refresh: requestDashboardRefresh,
  notify: showToast,
})

export const {
  activateRetainedPageTarget,
  removeRetainedPageTarget,
  removeRetainedPageTargets,
} = retainedPageActions
