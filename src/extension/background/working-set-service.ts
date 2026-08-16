import {
  Context,
  Deferred,
  Effect,
  Layer,
  Queue,
  Ref,
  Result,
  Schema,
} from 'effect'

import { omitUndefined } from '../../lib/omit-undefined.js'
import {
  pageIdentityForWorkingSet,
  recordWorkingSetActivityMutation,
} from '../working-set.js'
import { normalizeChromeTabToDashboardItem } from '../dashboard-tab-normalization.js'
import type { ChromeApi } from './chrome-api.js'
import type { DashboardTab, WorkingSetActivityKind, WorkingSetActivityStore } from '../types'
import {
  WorkingSetActivityStorage,
  type WorkingSetActivityWrite,
} from './working-set-activity-storage.js'

const ACTIVATION_SIGNAL_DEDUPE_MS = 1000

type ActivationSignalSource = 'tab-activated' | 'window-focused'
type ActivationSignal = {
  readonly source: ActivationSignalSource
  readonly tabId: number
  readonly windowId: number
  readonly observedAt: number
}
type ActivityMutation = {
  readonly activity: WorkingSetActivityStore
  readonly write?: WorkingSetActivityWrite
  readonly commit?: Effect.Effect<void>
}
type ActivityMutator = (
  activity: WorkingSetActivityStore,
) => Effect.Effect<ActivityMutation>
type CapturedTab = Promise<chrome.tabs.Tab | null>

export class WorkingSetStorageError extends Schema.TaggedError<WorkingSetStorageError>()(
  'WorkingSetStorageError',
  {
    operation: Schema.Literals(['read', 'write']),
    cause: Schema.Defect(),
  },
) {}

class WorkingSetTabLookupError extends Schema.TaggedError<WorkingSetTabLookupError>()(
  'WorkingSetTabLookupError',
  { cause: Schema.Defect() },
) {}

export class WorkingSet extends Context.Service<WorkingSet, {
  readonly getWorkingSetActivity: () => Effect.Effect<WorkingSetActivityStore, WorkingSetStorageError>
  readonly recordFocusedWindowActiveTab: (
    windowId: number,
    capturedActiveTab?: CapturedTab,
  ) => Effect.Effect<void, WorkingSetStorageError>
  readonly replaceTabId: (
    addedTabId: number,
    removedTabId: number,
  ) => Effect.Effect<void, WorkingSetStorageError>
  readonly recordTabActivation: (
    windowId: number,
    tabId: number,
    capturedTab?: CapturedTab,
  ) => Effect.Effect<void, WorkingSetStorageError>
  readonly recordTabNavigation: (
    tabId: number,
    changeInfo: { url?: string, title?: string },
    tab: chrome.tabs.Tab,
  ) => Effect.Effect<void, WorkingSetStorageError>
}>()('@tab-out/background/WorkingSet') {
  static layer(
    chromeApi: ChromeApi,
  ): Layer.Layer<WorkingSet, never, WorkingSetActivityStorage> {
    return makeWorkingSetLayer(chromeApi)
  }
}

function makeWorkingSetLayer(
  chromeApi: ChromeApi,
): Layer.Layer<WorkingSet, never, WorkingSetActivityStorage> {
  return Layer.effect(WorkingSet, Effect.gen(function* () {
    const activityStorage = yield* WorkingSetActivityStorage
    const scope = yield* Effect.scope
    const activityCache = yield* Ref.make<WorkingSetActivityStore | null>(null)
    const activityTasks = yield* Queue.unbounded<Effect.Effect<void>>()
    const lastActivityAt = yield* Ref.make(0)
    const lastPageIdentityByTabId = yield* Ref.make(new Map<number, string>())
    const lastActivationSignal = yield* Ref.make<ActivationSignal | null>(null)

    const readActivity = Effect.fn('WorkingSet.readActivity')(function* () {
      const cached = yield* Ref.get(activityCache)
      if (cached) return cached
      const activity = yield* activityStorage.read().pipe(
        Effect.mapError((error) => WorkingSetStorageError.make({
          operation: 'read',
          cause: error.cause,
        })),
      )
      yield* Ref.set(activityCache, activity)
      return activity
    })

    const writeActivity = Effect.fn('WorkingSet.writeActivity')(function* (
      change: WorkingSetActivityWrite,
    ) {
      yield* activityStorage.write(change).pipe(
        Effect.mapError((error) => WorkingSetStorageError.make({
          operation: 'write',
          cause: error.cause,
        })),
      )
      yield* Ref.set(activityCache, change.activity)
    })

    const runActivityMutation = Effect.fn('WorkingSet.mutateActivity')(function* (
      mutator: ActivityMutator,
    ) {
      const before = yield* readActivity()
      const mutation = yield* mutator(before)
      // No-op signals (paired activation/focus events, failed tab lookups, and
      // tab-id rebases) still need their commit effect, but must not reach the
      // persistence backend. Real events carry a record-oriented write delta.
      if (mutation.write) yield* writeActivity(mutation.write)
      if (mutation.commit) yield* mutation.commit
    })

    const drainActivityTasks = Effect.fn('WorkingSet.drainActivityTasks')(function* () {
      while (true) {
        const task = yield* Queue.take(activityTasks)
        yield* task
      }
    })

    yield* drainActivityTasks().pipe(
      Effect.forkIn(scope, { startImmediately: true }),
    )

    function serialize<Value, Failure>(
      effect: Effect.Effect<Value, Failure>,
    ): Effect.Effect<Value, Failure> {
      const completion = Deferred.makeUnsafe<Value, Failure>()
      const task = Deferred.complete(completion, effect).pipe(Effect.asVoid)
      if (!Queue.offerUnsafe(activityTasks, task)) {
        return Effect.die(new Error('Working Set activity queue is unavailable'))
      }
      return Deferred.await(completion)
    }

    const activityAfterTabEvent = Effect.fn('WorkingSet.activityAfterTabEvent')(function* (
      activity: WorkingSetActivityStore,
      kind: WorkingSetActivityKind,
      tab: chrome.tabs.Tab | DashboardTab,
    ) {
      const dashboardTab = isDashboardTab(tab)
        ? tab
        : normalizeChromeTabToDashboardItem(tab, { runtimeId: chromeApi.runtime?.id ?? null })
      const at = Math.max(Date.now(), (yield* Ref.get(lastActivityAt)) + 1)
      const write = recordWorkingSetActivityMutation(activity, {
        kind,
        at,
        tab: dashboardTab,
      })
      const hasDurableChange = write.upsert !== null || write.deleteKeys.length > 0
      return omitUndefined({
        activity: hasDurableChange ? write.activity : activity,
        write: hasDurableChange ? write : undefined,
        commit: Ref.set(lastActivityAt, at),
      }) satisfies ActivityMutation
    })

    function pageIdentityForTab(tab: chrome.tabs.Tab | DashboardTab): string {
      const dashboardTab = isDashboardTab(tab)
        ? tab
        : normalizeChromeTabToDashboardItem(tab, { runtimeId: chromeApi.runtime?.id ?? null })
      return pageIdentityForWorkingSet(dashboardTab.url || dashboardTab.rawUrl || '')
    }

    const activityAfterActivationSignal = Effect.fn('WorkingSet.activityAfterActivationSignal')(
      function* (
        activity: WorkingSetActivityStore,
        tab: chrome.tabs.Tab,
        source: ActivationSignalSource,
        observedAt: number,
      ) {
        if (typeof tab.id !== 'number') return { activity } satisfies ActivityMutation
        const tabId = tab.id
        const previousSignal = yield* Ref.get(lastActivationSignal)
        const nextSignal = {
          source,
          tabId,
          windowId: tab.windowId,
          observedAt,
        } satisfies ActivationSignal
        const pageIdentity = pageIdentityForTab(tab)
        const commitSignal = Ref.set(lastActivationSignal, nextSignal).pipe(
          Effect.andThen(Ref.update(lastPageIdentityByTabId, (current) => {
            const next = new Map(current)
            next.set(tabId, pageIdentity)
            return next
          })),
        )
        if (
          previousSignal &&
          previousSignal.source !== source &&
          previousSignal.tabId === tabId &&
          previousSignal.windowId === tab.windowId &&
          Math.abs(observedAt - previousSignal.observedAt) <= ACTIVATION_SIGNAL_DEDUPE_MS
        ) {
          return { activity, commit: commitSignal } satisfies ActivityMutation
        }
        const mutation = yield* activityAfterTabEvent(activity, 'activation', tab)
        return omitUndefined({
          activity: mutation.activity,
          write: mutation.write,
          commit: mutation.commit.pipe(Effect.andThen(commitSignal)),
        }) satisfies ActivityMutation
      },
    )

    const getActivity = () => serialize(readActivity())

    const runRecordActivation = Effect.fn('WorkingSet.recordTabActivation')(function* (
      windowId: number,
      tabId: number,
      capturedTab: CapturedTab | undefined,
      observedAt: number,
    ) {
      yield* runActivityMutation((activity) => Effect.gen(function* () {
        const lookup = yield* Effect.result(Effect.tryPromise({
          try: async () => {
            let tab = capturedTab ? await capturedTab : null
            tab ??= (await chromeApi.tabs.query({ windowId }))
              .find((candidate) => candidate.id === tabId) ?? null
            return tab
          },
          catch: (cause) => WorkingSetTabLookupError.make({ cause }),
        }))
        if (Result.isFailure(lookup)) return { activity }
        const tab = lookup.success
        if (tab?.id !== tabId || tab.windowId !== windowId) return { activity }
        return yield* activityAfterActivationSignal(
          activity,
          tab,
          'tab-activated',
          observedAt,
        )
      }))
    })

    function recordActivation(
      windowId: number,
      tabId: number,
      capturedTab?: CapturedTab,
    ): Effect.Effect<void, WorkingSetStorageError> {
      if (typeof windowId !== 'number' || typeof tabId !== 'number') return Effect.void
      return serialize(runRecordActivation(windowId, tabId, capturedTab, Date.now()))
    }

    const runRecordFocused = Effect.fn('WorkingSet.recordFocusedWindowActiveTab')(function* (
      windowId: number,
      capturedActiveTab: CapturedTab | undefined,
      observedAt: number,
    ) {
      yield* runActivityMutation((activity) => Effect.gen(function* () {
        const lookup = yield* Effect.result(Effect.tryPromise({
          try: async () => {
            let activeTab = capturedActiveTab ? await capturedActiveTab : null
            activeTab ??= (await chromeApi.tabs.query({ windowId, active: true }))[0] ?? null
            return activeTab
          },
          catch: (cause) => WorkingSetTabLookupError.make({ cause }),
        }))
        if (Result.isFailure(lookup)) return { activity }
        const activeTab = lookup.success
        if (activeTab?.windowId !== windowId || !activeTab.active) return { activity }
        return yield* activityAfterActivationSignal(
          activity,
          activeTab,
          'window-focused',
          observedAt,
        )
      }))
    })

    function recordFocused(
      windowId: number,
      capturedActiveTab?: CapturedTab,
    ): Effect.Effect<void, WorkingSetStorageError> {
      if (windowId == null || windowId === chromeApi.windows.WINDOW_ID_NONE) return Effect.void
      return serialize(runRecordFocused(windowId, capturedActiveTab, Date.now()))
    }

    const runReplaceTabId = Effect.fn('WorkingSet.replaceTabId')(function* (
      addedTabId: number,
      removedTabId: number,
    ) {
      yield* runActivityMutation((activity) => Effect.gen(function* () {
        const signal = yield* Ref.get(lastActivationSignal)
        const nextSignal = signal?.tabId === removedTabId
          ? { ...signal, tabId: addedTabId }
          : signal
        const pageIdentities = yield* Ref.get(lastPageIdentityByTabId)
        const replacedPageIdentity = pageIdentities.get(removedTabId)
        return {
          activity,
          commit: Ref.set(lastActivationSignal, nextSignal).pipe(
            Effect.andThen(Ref.update(lastPageIdentityByTabId, (current) => {
              const next = new Map(current)
              next.delete(removedTabId)
              if (replacedPageIdentity !== undefined) {
                next.set(addedTabId, replacedPageIdentity)
              }
              return next
            })),
          ),
        }
      }))
    })

    function replaceTabId(
      addedTabId: number,
      removedTabId: number,
    ): Effect.Effect<void, WorkingSetStorageError> {
      if (
        typeof addedTabId !== 'number' ||
        typeof removedTabId !== 'number' ||
        addedTabId === removedTabId
      ) {
        return Effect.void
      }
      return serialize(runReplaceTabId(addedTabId, removedTabId))
    }

    const runRecordNavigation = Effect.fn('WorkingSet.recordTabNavigation')(function* (
      tabId: number,
      changeInfo: { url?: string, title?: string },
      tab: chrome.tabs.Tab,
    ) {
      const nextPageIdentity = pageIdentityForTab(tab)
      yield* runActivityMutation((activity) => Effect.gen(function* () {
        const pageIdentities = yield* Ref.get(lastPageIdentityByTabId)
        const commitPageIdentity = Ref.update(lastPageIdentityByTabId, (current) => {
          const next = new Map(current)
          next.set(tabId, nextPageIdentity)
          return next
        })
        // Chrome can surface a URL update while reloading the same page. Only a
        // normalized page-identity change is meaningful Working Set navigation.
        if (pageIdentities.get(tabId) === nextPageIdentity) {
          return { activity, commit: commitPageIdentity }
        }
        const mutation = yield* activityAfterTabEvent(activity, 'navigation', tab)
        return omitUndefined({
          activity: mutation.activity,
          write: mutation.write,
          commit: mutation.commit.pipe(Effect.andThen(commitPageIdentity)),
        })
      }))
    })

    function recordNavigation(
      tabId: number,
      changeInfo: { url?: string, title?: string },
      tab: chrome.tabs.Tab,
    ): Effect.Effect<void, WorkingSetStorageError> {
      if (!tab?.active || !changeInfo?.url || typeof tabId !== 'number' || tab.id !== tabId) {
        return Effect.void
      }
      return serialize(runRecordNavigation(tabId, changeInfo, tab))
    }

    return WorkingSet.of({
      getWorkingSetActivity: getActivity,
      recordFocusedWindowActiveTab: recordFocused,
      replaceTabId,
      recordTabActivation: recordActivation,
      recordTabNavigation: recordNavigation,
    })
  }))
}

function isDashboardTab(tab: chrome.tabs.Tab | DashboardTab): tab is DashboardTab {
  return 'rawUrl' in tab && 'suspended' in tab
}
