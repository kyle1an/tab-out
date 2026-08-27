import {
  Context,
  Effect,
  Layer,
  Ref,
  Result,
  Schema,
} from 'effect'

import {
  DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY,
  DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE,
  desktopWindowMergeRequestFailureReasonSchema,
  parseDesktopWindowMergeJournal,
  type DesktopWindowMergeConfirmResponse,
  type DesktopWindowMergeJournal,
  type DesktopWindowMergePreviewResponse,
  type DesktopWindowMergeRequestFailureReason,
  type DesktopWindowMergeStatusResponse,
} from '../desktop-window-merge-contract.js'
import { BrowserTabs } from '../browser-tabs-service.js'
import { runPromiseExclusiveEffect } from '../promise-exclusive-effect.js'
import type { PromiseExclusiveRunner } from '../promise-exclusive-effect.js'
import type { ChromeApi } from './chrome-api.js'
import {
  readChromeStorageValue,
  removeChromeStorageValue,
  writeChromeStorageValue,
} from './chrome-storage.js'
import {
  NATIVE_MERGE_DESKTOP_CAPABILITY,
  NativePlacementBridge,
} from './native-placement-bridge.js'
import {
  buildDesktopWindowMergePlan,
  desktopWindowMergePlansMatch,
  type DesktopWindowMergePlan,
  type DesktopWindowMergeUnit,
} from './desktop-window-merge-plan.js'

const DESKTOP_WINDOW_MERGE_LOCK_NAME = 'tab-out:desktop-window-merge'
const DESKTOP_WINDOW_MERGE_PREVIEW_LIFETIME_MS = 10 * 60 * 1_000

/**
 * Sentinel requester id for the tabless Tab Actions Menu popup. A preview it
 * owns can never match a journal owner (owner tab ids are positive), and at
 * confirmation the handed-off Tab Out page adopts the preview as its owner.
 */
export const DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID = -1
const DESKTOP_WINDOW_MERGE_RETRY_DELAYS_MS = [0, 100, 250, 650] as const
const DESKTOP_WINDOW_MERGE_ACTIVITY_RECEIPT_LIFETIME_MS = 2_000
const DESKTOP_WINDOW_MERGE_MAX_ACTIVITY_RECEIPTS = 512

interface DesktopWindowMergePreview {
  readonly createdAtMs: number
  readonly destinationWindowId: number
  readonly ownerTabId: number
  readonly plan: DesktopWindowMergePlan
  readonly previewId: string
  readonly selectionToken: string
}

export interface DesktopWindowMergeLayerOptions {
  readonly makeId?: ((kind: 'preview' | 'session') => string) | undefined
  readonly now?: (() => number) | undefined
  readonly runExclusive?: PromiseExclusiveRunner | undefined
}

class DesktopWindowMergeServiceError extends Schema.TaggedError<DesktopWindowMergeServiceError>()(
  'DesktopWindowMergeServiceError',
  { reason: desktopWindowMergeRequestFailureReasonSchema },
) {}

class DesktopWindowMergeLockError extends Schema.TaggedError<DesktopWindowMergeLockError>()(
  'DesktopWindowMergeLockError',
  { busy: Schema.Boolean },
) {}

class DesktopWindowMergeLockBusy extends Error {}

type MutationResult = {
  readonly movedTabCount: number
  readonly remainingTabCount: number
  readonly succeeded: boolean
}

interface ExpectedTabActivationReceipt {
  readonly expiresAtMs: number
  readonly id: number
  readonly tabIds: ReadonlySet<number>
  readonly windowId: number
}

interface ExpectedMoveActivations {
  readonly activeMovingTabId: number
  readonly destinationReceiptId: number | null
  readonly movingTabIds: ReadonlySet<number>
  readonly sourceReceiptId: number | null
  readonly sourceWindowId: number
}

function groupHasExactMembers(
  tabs: readonly chrome.tabs.Tab[],
  groupId: number,
  expectedTabIds: readonly number[],
): boolean {
  const expected = new Set(expectedTabIds)
  const actual = new Set<number>()
  for (const tab of tabs) {
    if (tab.groupId !== groupId) continue
    if (tab.id == null || actual.has(tab.id)) return false
    actual.add(tab.id)
  }
  if (actual.size !== expected.size) return false
  for (const tabId of actual) {
    if (!expected.has(tabId)) return false
  }
  return true
}

export class DesktopWindowMerge extends Context.Service<DesktopWindowMerge, {
  readonly acknowledge: (
    requesterTabId: number,
    sessionId: string,
  ) => Effect.Effect<boolean>
  readonly confirm: (
    requesterTabId: number,
    destinationWindowId: number,
    previewId: string,
  ) => Effect.Effect<DesktopWindowMergeConfirmResponse>
  readonly getStatus: (
    requesterTabId: number,
    requesterWindowId: number,
    requesterActive: boolean,
  ) => Effect.Effect<DesktopWindowMergeStatusResponse>
  readonly preview: (
    requesterTabId: number,
    destinationWindowId: number,
  ) => Effect.Effect<DesktopWindowMergePreviewResponse>
  readonly consumeExpectedTabActivation: (
    tabId: number,
    windowId: number,
  ) => Effect.Effect<boolean>
}>()('@tab-out/background/DesktopWindowMerge') {
  static layer(
    chromeApi: ChromeApi,
    options: DesktopWindowMergeLayerOptions = {},
  ): Layer.Layer<DesktopWindowMerge, never, BrowserTabs | NativePlacementBridge> {
    return makeDesktopWindowMergeLayer(chromeApi, options)
  }
}

function defaultRunExclusive<Value>(task: () => Promise<Value>): Promise<Value> {
  if (!globalThis.navigator?.locks) {
    return Promise.reject(new Error('Web Locks are unavailable'))
  }
  return globalThis.navigator.locks.request(
    DESKTOP_WINDOW_MERGE_LOCK_NAME,
    { ifAvailable: true, mode: 'exclusive' },
    (lock) => lock
      ? task()
      : Promise.reject<Value>(new DesktopWindowMergeLockBusy()),
  )
}

function makeDesktopWindowMergeLayer(
  chromeApi: ChromeApi,
  options: DesktopWindowMergeLayerOptions,
): Layer.Layer<DesktopWindowMerge, never, BrowserTabs | NativePlacementBridge> {
  return Layer.effect(DesktopWindowMerge, Effect.gen(function* () {
    const browserTabs = yield* BrowserTabs
    const nativeBridge = yield* NativePlacementBridge
    const now = options.now ?? Date.now
    const runExclusive = options.runExclusive ?? defaultRunExclusive
    const previews = yield* Ref.make<ReadonlyMap<string, DesktopWindowMergePreview>>(new Map())
    const activeSessionId = yield* Ref.make<string | null>(null)
    const expectedTabActivations = yield* Ref.make<readonly ExpectedTabActivationReceipt[]>([])
    const lastJournal = yield* Ref.make<DesktopWindowMergeJournal | null>(null)
    let nextActivityReceiptId = 0

    const makeId = options.makeId ??
      ((kind: 'preview' | 'session') => `${kind}-${crypto.randomUUID()}`)
    const serviceError = (
      reason: DesktopWindowMergeRequestFailureReason,
    ) => new DesktopWindowMergeServiceError({ reason })

    const broadcastStatusChange = Effect.fn(
      'DesktopWindowMerge.broadcastStatusChange',
    )(function* () {
      if (!chromeApi.runtime?.sendMessage) return
      yield* Effect.tryPromise({
        try: () => chromeApi.runtime.sendMessage({
          type: DESKTOP_WINDOW_MERGE_STATUS_CHANGED_MESSAGE,
        }),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void))
    })

    const readJournal = Effect.fn('DesktopWindowMerge.readJournal')(function* () {
      const storage = chromeApi.storage?.session
      if (!storage) return null
      const raw = yield* Effect.tryPromise({
        try: () => readChromeStorageValue(
          storage,
          DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY,
        ),
        catch: () => serviceError('session-storage-unavailable'),
      })
      if (raw == null) {
        yield* Ref.set(lastJournal, null)
        return null
      }
      const journal = parseDesktopWindowMergeJournal(raw)
      if (!journal) {
        yield* Effect.tryPromise({
          try: () => removeChromeStorageValue(
            storage,
            DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY,
          ),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.void))
        yield* Ref.set(lastJournal, null)
        return null
      }
      yield* Ref.set(lastJournal, journal)
      return journal
    })

    const writeJournal = Effect.fn('DesktopWindowMerge.writeJournal')(function* (
      journal: DesktopWindowMergeJournal,
    ) {
      const storage = chromeApi.storage?.session
      if (!storage) return yield* Effect.fail(serviceError('session-storage-unavailable'))
      yield* Effect.tryPromise({
        try: () => writeChromeStorageValue(
          storage,
          DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY,
          journal,
        ),
        catch: () => serviceError('session-storage-unavailable'),
      })
      yield* Ref.set(lastJournal, journal)
      yield* broadcastStatusChange()
    })

    const removeJournal = Effect.fn('DesktopWindowMerge.removeJournal')(function* () {
      const storage = chromeApi.storage?.session
      if (!storage) return false
      const removed = yield* Effect.result(Effect.tryPromise({
        try: () => removeChromeStorageValue(
          storage,
          DESKTOP_WINDOW_MERGE_SESSION_STORAGE_KEY,
        ),
        catch: () => serviceError('session-storage-unavailable'),
      }))
      if (Result.isFailure(removed)) return false
      yield* Ref.set(lastJournal, null)
      yield* broadcastStatusChange()
      return true
    })

    const persistTerminalJournal = Effect.fn(
      'DesktopWindowMerge.persistTerminalJournal',
    )(function* (journal: DesktopWindowMergeJournal) {
      const persisted = yield* Effect.result(writeJournal(journal))
      if (Result.isSuccess(persisted)) return journal

      const fallback: DesktopWindowMergeJournal = {
        ...journal,
        status: 'partial',
        errorCode: 'session-storage-unavailable',
      }
      const fallbackPersisted = yield* Effect.result(writeJournal(fallback))
      if (Result.isSuccess(fallbackPersisted)) return fallback

      yield* removeJournal()
      yield* Ref.set(lastJournal, fallback)
      yield* broadcastStatusChange()
      return fallback
    })

    const availability = Effect.fn('DesktopWindowMerge.availability')(function* () {
      if (!chromeApi.storage?.session) {
        return { available: false, reason: 'session-storage-unavailable' }
      }
      if (!options.runExclusive && !globalThis.navigator?.locks) {
        return { available: false, reason: 'coordination-unavailable' }
      }
      const nativeStatus = yield* nativeBridge.getStatus()
      if (!nativeStatus.hostConnected) {
        return { available: false, reason: 'native-integration-required' }
      }
      if (
        !nativeStatus.controllerConnected ||
        !nativeStatus.capabilities.includes(NATIVE_MERGE_DESKTOP_CAPABILITY)
      ) {
        return { available: false, reason: 'controller-update-required' }
      }
      return { available: true }
    })

    const reconcileInterruptedJournal = Effect.fn(
      'DesktopWindowMerge.reconcileInterruptedJournal',
    )(function* () {
      const journal = yield* readJournal()
      if (!journal || journal.status !== 'running') return journal
      if ((yield* Ref.get(activeSessionId)) === journal.sessionId) return journal
      const interrupted: DesktopWindowMergeJournal = {
        ...journal,
        status: 'interrupted',
        updatedAtMs: now(),
        errorCode: 'interrupted',
      }
      yield* writeJournal(interrupted)
      return interrupted
    })

    const capturePlan = Effect.fn('DesktopWindowMerge.capturePlan')(function* (
      destinationWindowId: number,
      windowIds: readonly number[],
      requireDestinationFocus = true,
    ) {
      const [windows, tabs, groups] = yield* Effect.all([
        browserTabs.getAllWindowsResult(),
        browserTabs.queryAllTabsResult(),
        browserTabs.queryTabGroupsResult(),
      ] as const, { concurrency: 'unbounded' })
      if (!windows.ok || !tabs.ok || !groups.ok) {
        return yield* Effect.fail(serviceError('browser-read-failed'))
      }
      const result = buildDesktopWindowMergePlan({
        destinationWindowId,
        windowIds,
        windows: windows.value,
        tabs: tabs.value,
        groups: groups.value,
        requireDestinationFocus,
      })
      if (!result.ok) {
        return yield* Effect.fail(serviceError(
          result.reason === 'window-inventory-changed'
            ? 'desktop-selection-unavailable'
            : 'browser-read-failed',
        ))
      }
      return result.plan
    })

    const storePreview = Effect.fn('DesktopWindowMerge.storePreview')(function* (
      ownerTabId: number,
      destinationWindowId: number,
      selectionToken: string,
      plan: DesktopWindowMergePlan,
    ) {
      const at = now()
      const previewId = makeId('preview')
      const preview: DesktopWindowMergePreview = {
        createdAtMs: at,
        destinationWindowId,
        ownerTabId,
        plan,
        previewId,
        selectionToken,
      }
      yield* Ref.update(previews, (current) => {
        const next = new Map<string, DesktopWindowMergePreview>()
        for (const [id, candidate] of current) {
          if (at - candidate.createdAtMs <= DESKTOP_WINDOW_MERGE_PREVIEW_LIFETIME_MS) {
            next.set(id, candidate)
          }
        }
        next.set(previewId, preview)
        return next
      })
      return preview
    })

    const freshPreview = Effect.fn('DesktopWindowMerge.freshPreview')(function* (
      ownerTabId: number,
      destinationWindowId: number,
    ) {
      const selected = yield* Effect.result(
        nativeBridge.resolveDesktopWindows(destinationWindowId),
      )
      if (Result.isFailure(selected)) {
        return { ok: false, reason: 'desktop-selection-unavailable' }
      }
      // Chrome can report the invoking window unfocused while its toolbar
      // popup owns focus. Only that read-only preview skips the focus check;
      // page-owned previews and confirmation keep capturePlan's strict default.
      const requireDestinationFocus = ownerTabId !== DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID
      const plan = yield* Effect.result(capturePlan(
        destinationWindowId,
        selected.success.windowIds,
        requireDestinationFocus,
      ))
      if (Result.isFailure(plan)) return { ok: false, reason: plan.failure.reason }
      if (plan.success.sourceWindowCount === 0) {
        return { ok: true, status: 'already-merged' }
      }
      const preview = yield* storePreview(
        ownerTabId,
        destinationWindowId,
        selected.success.selectionToken,
        plan.success,
      )
      return {
        ok: true,
        status: 'ready',
        previewId: preview.previewId,
        sourceWindowCount: plan.success.sourceWindowCount,
        movingTabCount: plan.success.movingTabIds.length,
      }
    })

    const changedPreview = Effect.fn('DesktopWindowMerge.changedPreview')(function* (
      ownerTabId: number,
      destinationWindowId: number,
    ) {
      const refreshed = yield* freshPreview(ownerTabId, destinationWindowId)
      if (!refreshed.ok) return refreshed
      if (refreshed.status !== 'ready') return refreshed
      return {
        ...refreshed,
        status: 'changed',
      }
    })

    const tabReachedDestination = Effect.fn(
      'DesktopWindowMerge.tabReachedDestination',
    )(function* (tabId: number, destinationWindowId: number) {
      const tab = yield* browserTabs.getTab(tabId)
      return tab?.windowId === destinationWindowId ? tab : null
    })

    const armExpectedTabActivation = Effect.fn(
      'DesktopWindowMerge.armExpectedTabActivation',
    )(function* (windowId: number, tabIds: readonly number[]) {
      const expectedTabIds = new Set(tabIds)
      if (expectedTabIds.size === 0) return null
      nextActivityReceiptId += 1
      const at = now()
      const receipt: ExpectedTabActivationReceipt = {
        expiresAtMs: at + DESKTOP_WINDOW_MERGE_ACTIVITY_RECEIPT_LIFETIME_MS,
        id: nextActivityReceiptId,
        tabIds: expectedTabIds,
        windowId,
      }
      yield* Ref.update(expectedTabActivations, (current) => [
        ...current.filter((candidate) => candidate.expiresAtMs > at),
        receipt,
      ].slice(-DESKTOP_WINDOW_MERGE_MAX_ACTIVITY_RECEIPTS))
      return receipt.id
    })

    const retainExpectedTabActivation = Effect.fn(
      'DesktopWindowMerge.retainExpectedTabActivation',
    )(function* (receiptId: number | null, tabId: number | null) {
      if (receiptId == null) return
      const at = now()
      yield* Ref.update(expectedTabActivations, (current) => current.flatMap((receipt) => {
        if (receipt.expiresAtMs <= at) return []
        if (receipt.id !== receiptId) return [receipt]
        if (tabId == null || !receipt.tabIds.has(tabId)) return []
        return [{ ...receipt, tabIds: new Set([tabId]) }]
      }))
    })

    const prepareExpectedMoveActivations = Effect.fn(
      'DesktopWindowMerge.prepareExpectedMoveActivations',
    )(function* (
      movingTabIds: readonly number[],
      sourceWindowId: number,
      destinationWindowId: number,
      frozenMovingTabIds: ReadonlySet<number>,
    ) {
      const inventory = yield* browserTabs.queryAllTabsResult()
      if (!inventory.ok) return null
      const movingTabIdSet = new Set(movingTabIds)
      const activeMovingTab = inventory.value.find((tab) =>
        tab.active &&
        tab.id != null &&
        tab.windowId === sourceWindowId &&
        movingTabIdSet.has(tab.id))
      if (activeMovingTab?.id == null) return null
      const sourceReplacementTabIds = inventory.value.flatMap((tab) =>
        tab.id != null &&
        tab.windowId === sourceWindowId &&
        frozenMovingTabIds.has(tab.id) &&
        !movingTabIdSet.has(tab.id)
          ? [tab.id]
          : [])
      const sourceReceiptId = yield* armExpectedTabActivation(
        sourceWindowId,
        sourceReplacementTabIds,
      )
      const destinationReceiptId = yield* armExpectedTabActivation(
        destinationWindowId,
        [activeMovingTab.id],
      )
      return {
        activeMovingTabId: activeMovingTab.id,
        destinationReceiptId,
        movingTabIds: movingTabIdSet,
        sourceReceiptId,
        sourceWindowId,
      } satisfies ExpectedMoveActivations
    })

    const reconcileExpectedMoveActivations = Effect.fn(
      'DesktopWindowMerge.reconcileExpectedMoveActivations',
    )(function* (
      expected: ExpectedMoveActivations | null,
      destinationWindowId: number,
    ) {
      if (!expected) return
      const inventory = yield* browserTabs.queryAllTabsResult()
      if (!inventory.ok) {
        yield* Effect.all([
          retainExpectedTabActivation(expected.sourceReceiptId, null),
          retainExpectedTabActivation(expected.destinationReceiptId, null),
        ], { concurrency: 'unbounded' })
        return
      }
      const sourceActiveTabId = inventory.value.find((tab) =>
        tab.active &&
        tab.id != null &&
        tab.windowId === expected.sourceWindowId &&
        !expected.movingTabIds.has(tab.id))?.id ?? null
      const destinationActivated = inventory.value.some((tab) =>
        tab.active &&
        tab.id === expected.activeMovingTabId &&
        tab.windowId === destinationWindowId)
      yield* Effect.all([
        retainExpectedTabActivation(expected.sourceReceiptId, sourceActiveTabId),
        retainExpectedTabActivation(
          expected.destinationReceiptId,
          destinationActivated ? expected.activeMovingTabId : null,
        ),
      ], { concurrency: 'unbounded' })
    })

    const moveTabWithActivityReceipts = Effect.fn(
      'DesktopWindowMerge.moveTabWithActivityReceipts',
    )(function* (
      tabId: number,
      moveProperties: chrome.tabs.MoveProperties,
      sourceWindowId: number,
      frozenMovingTabIds: ReadonlySet<number>,
    ) {
      const destinationWindowId = moveProperties.windowId
      const expected = destinationWindowId == null
        ? null
        : yield* prepareExpectedMoveActivations(
          [tabId],
          sourceWindowId,
          destinationWindowId,
          frozenMovingTabIds,
        )
      const moved = yield* browserTabs.moveTab(tabId, moveProperties)
      if (destinationWindowId != null) {
        yield* reconcileExpectedMoveActivations(expected, destinationWindowId)
      }
      return moved
    })

    const moveGroupWithActivityReceipts = Effect.fn(
      'DesktopWindowMerge.moveGroupWithActivityReceipts',
    )(function* (
      unit: Extract<DesktopWindowMergeUnit, { kind: 'group' }>,
      moveProperties: chrome.tabGroups.MoveProperties,
      sourceWindowId: number,
      frozenMovingTabIds: ReadonlySet<number>,
    ) {
      const destinationWindowId = moveProperties.windowId
      const expected = destinationWindowId == null
        ? null
        : yield* prepareExpectedMoveActivations(
          unit.tabIds,
          sourceWindowId,
          destinationWindowId,
          frozenMovingTabIds,
        )
      const moved = yield* browserTabs.moveTabGroup(unit.groupId, moveProperties)
      if (destinationWindowId != null) {
        yield* reconcileExpectedMoveActivations(expected, destinationWindowId)
      }
      return moved
    })

    const activateTabWithActivityReceipt = Effect.fn(
      'DesktopWindowMerge.activateTabWithActivityReceipt',
    )(function* (tabId: number, windowId: number) {
      const before = yield* browserTabs.getTab(tabId)
      const receiptId = before?.windowId === windowId && !before.active
        ? yield* armExpectedTabActivation(windowId, [tabId])
        : null
      const updated = yield* browserTabs.updateTab(tabId, { active: true })
      const after = yield* browserTabs.getTab(tabId)
      yield* retainExpectedTabActivation(
        receiptId,
        after?.active === true && after.windowId === windowId ? tabId : null,
      )
      return updated
    })

    const moveTabWithRetry = Effect.fn('DesktopWindowMerge.moveTabWithRetry')(function* (
      tabId: number,
      destinationWindowId: number,
      pinned: boolean,
      expectedSourceWindowId: number,
      frozenMovingTabIds: ReadonlySet<number>,
    ) {
      for (const delay of DESKTOP_WINDOW_MERGE_RETRY_DELAYS_MS) {
        if (delay > 0) yield* Effect.sleep(delay)
        let before = yield* browserTabs.getTab(tabId)
        if (before?.windowId === destinationWindowId) {
          if (before.pinned !== pinned) {
            yield* browserTabs.updateTab(tabId, { pinned })
            before = yield* browserTabs.getTab(tabId)
          }
          if (
            before?.windowId === destinationWindowId &&
            before.pinned === pinned &&
            (pinned || before.groupId === -1)
          ) return true
          if (!before || before.windowId !== destinationWindowId) return false
          continue
        }
        if (!before || before.windowId !== expectedSourceWindowId) return false
        const destinationTabs = pinned
          ? yield* browserTabs.queryTabsInWindowResult(destinationWindowId)
          : null
        if (destinationTabs && !destinationTabs.ok) return false
        const destinationIndex = destinationTabs
          ? destinationTabs.value.filter((tab) => tab.pinned).length
          : -1
        yield* moveTabWithActivityReceipts(tabId, {
          index: destinationIndex,
          windowId: destinationWindowId,
        }, expectedSourceWindowId, frozenMovingTabIds)
        let current = yield* tabReachedDestination(tabId, destinationWindowId)
        if (!current) continue
        if (current.pinned !== pinned) {
          yield* browserTabs.updateTab(tabId, { pinned })
          current = yield* tabReachedDestination(tabId, destinationWindowId)
        }
        if (
          current?.pinned === pinned &&
          (pinned || current.groupId === -1)
        ) return true
        if (!current) continue
      }
      return false
    })

    const groupReachedDestination = Effect.fn(
      'DesktopWindowMerge.groupReachedDestination',
    )(function* (
      unit: Extract<DesktopWindowMergeUnit, { kind: 'group' }>,
      destinationWindowId: number,
      expectedSourceWindowId: number,
    ) {
      const inventory = yield* browserTabs.queryAllTabsResult()
      if (
        !inventory.ok ||
        !groupHasExactMembers(inventory.value, unit.groupId, unit.tabIds)
      ) return 'ambiguous' as const
      const tabById = new Map(
        inventory.value
          .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id != null)
          .map((tab) => [tab.id, tab] as const),
      )
      const tabs = unit.tabIds.map((tabId) => tabById.get(tabId))
      if (tabs.every((tab) =>
        tab?.windowId === destinationWindowId && tab.groupId === unit.groupId)) {
        return 'destination' as const
      }
      if (tabs.every((tab) =>
        tab?.windowId === expectedSourceWindowId && tab.groupId === unit.groupId)) {
        return 'source' as const
      }
      return 'ambiguous' as const
    })

    const moveGroupWithRetry = Effect.fn(
      'DesktopWindowMerge.moveGroupWithRetry',
    )(function* (
      unit: Extract<DesktopWindowMergeUnit, { kind: 'group' }>,
      destinationWindowId: number,
      expectedSourceWindowId: number,
      frozenMovingTabIds: ReadonlySet<number>,
    ) {
      for (const delay of DESKTOP_WINDOW_MERGE_RETRY_DELAYS_MS) {
        if (delay > 0) yield* Effect.sleep(delay)
        const before = yield* groupReachedDestination(
          unit,
          destinationWindowId,
          expectedSourceWindowId,
        )
        if (before === 'destination') return true
        if (before !== 'source') return false
        yield* moveGroupWithActivityReceipts(unit, {
          index: -1,
          windowId: destinationWindowId,
        }, expectedSourceWindowId, frozenMovingTabIds)
        const after = yield* groupReachedDestination(
          unit,
          destinationWindowId,
          expectedSourceWindowId,
        )
        if (after === 'destination') return true
        if (after !== 'source') return false
      }
      return false
    })

    const verifyMutation = Effect.fn('DesktopWindowMerge.verifyMutation')(function* (
      plan: DesktopWindowMergePlan,
      operationFailed: boolean,
    ) {
      const [movingTabs, destinationTabs, destinationWindow, groups] = yield* Effect.all([
        Effect.all(
          plan.movingTabIds.map((tabId) => browserTabs.getTab(tabId)),
          { concurrency: 'unbounded' },
        ),
        browserTabs.queryTabsInWindowResult(plan.destinationWindowId),
        browserTabs.getWindow(plan.destinationWindowId),
        browserTabs.queryTabGroupsResult(),
      ] as const, { concurrency: 'unbounded' })
      const movedTabCount = movingTabs.filter((tab) =>
        tab?.windowId === plan.destinationWindowId).length
      const remainingTabCount = plan.movingTabIds.length - movedTabCount
      if (!destinationTabs.ok || !destinationWindow || !groups.ok) {
        return {
          succeeded: false,
          movedTabCount,
          remainingTabCount,
        } satisfies MutationResult
      }

      const tabById = new Map(
        destinationTabs.value
          .filter((tab): tab is chrome.tabs.Tab & { id: number } => tab.id != null)
          .map((tab) => [tab.id, tab] as const),
      )
      const statePreserved = plan.tabSnapshots.every((expected) => {
        const tab = tabById.get(expected.id)
        return !!tab &&
          tab.windowId === plan.destinationWindowId &&
          (tab.discarded === true) === expected.discarded &&
          (tab.mutedInfo?.muted === true) === expected.muted &&
          tab.pinned === expected.pinned &&
          tab.groupId === expected.groupId &&
          (tab.pendingUrl || tab.url || '') === expected.rawUrl
      })

      const destinationOriginal = plan.tabSnapshots.filter((tab) =>
        tab.windowId === plan.destinationWindowId)
      const destinationPinnedTabIds: number[] = []
      const destinationUnpinnedTabIds: number[] = []
      for (const tab of destinationOriginal) {
        if (tab.pinned) destinationPinnedTabIds.push(tab.id)
        else destinationUnpinnedTabIds.push(tab.id)
      }
      const expectedOrder = [
        ...destinationPinnedTabIds,
        ...plan.pinnedTabIds,
        ...destinationUnpinnedTabIds,
        ...plan.unpinnedUnits.flatMap((unit) =>
          unit.kind === 'tab' ? [unit.tabId] : unit.tabIds),
      ]
      const expectedIds = new Set(expectedOrder)
      const actualOrder = destinationTabs.value
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => tabId != null && expectedIds.has(tabId))
      const orderPreserved = JSON.stringify(actualOrder) === JSON.stringify(expectedOrder)
      const destinationActivePreserved = destinationTabs.value.some((tab) =>
        tab.id === plan.destinationActiveTabId && tab.active)
      const destinationFocusPreserved = destinationWindow.focused === true
      const groupById = new Map(groups.value.map((group) => [group.id, group] as const))
      const tabIdsByGroupId = new Map<number, number[]>()
      for (const tab of plan.tabSnapshots) {
        if (tab.groupId === -1) continue
        const tabIds = tabIdsByGroupId.get(tab.groupId) ?? []
        tabIds.push(tab.id)
        tabIdsByGroupId.set(tab.groupId, tabIds)
      }
      const groupStatePreserved = plan.groupSnapshots.every((expected) => {
        const group = groupById.get(expected.id)
        return !!group &&
          group.windowId === plan.destinationWindowId &&
          group.collapsed === expected.collapsed &&
          group.color === expected.color &&
          (group.shared === true) === expected.shared &&
          (group.title ?? '') === expected.title &&
          groupHasExactMembers(
            destinationTabs.value,
            expected.id,
            tabIdsByGroupId.get(expected.id) ?? [],
          )
      })

      const succeeded = !operationFailed &&
        remainingTabCount === 0 &&
        statePreserved &&
        orderPreserved &&
        destinationActivePreserved &&
        destinationFocusPreserved &&
        groupStatePreserved
      return {
        succeeded,
        movedTabCount,
        remainingTabCount,
      } satisfies MutationResult
    })

    const executeMutation = Effect.fn('DesktopWindowMerge.executeMutation')(function* (
      plan: DesktopWindowMergePlan,
      initialJournal: DesktopWindowMergeJournal,
    ) {
      let movedTabCount = 0
      let operationFailed = false
      const movingTabIds = new Set(plan.movingTabIds)
      const sourceWindowByTabId = new Map<number, number>()
      for (const tab of plan.tabSnapshots) {
        if (movingTabIds.has(tab.id)) sourceWindowByTabId.set(tab.id, tab.windowId)
      }

      const persistProgress = Effect.fn(
        'DesktopWindowMerge.persistProgress',
      )(function* (increment: number) {
        movedTabCount += increment
        const progress: DesktopWindowMergeJournal = {
          ...initialJournal,
          movedTabCount,
          remainingTabCount: Math.max(0, plan.movingTabIds.length - movedTabCount),
          updatedAtMs: now(),
        }
        const persisted = yield* Effect.result(writeJournal(progress))
        return Result.isSuccess(persisted)
      })

      for (const tabId of plan.pinnedTabIds) {
        const sourceWindowId = sourceWindowByTabId.get(tabId)
        if (
          !sourceWindowId ||
          !(yield* moveTabWithRetry(
            tabId,
            plan.destinationWindowId,
            true,
            sourceWindowId,
            movingTabIds,
          ))
        ) {
          operationFailed = true
          break
        }
        if (!(yield* persistProgress(1))) {
          operationFailed = true
          break
        }
      }

      if (!operationFailed) {
        for (const unit of plan.unpinnedUnits) {
          const firstTabId = unit.kind === 'group' ? unit.tabIds[0] : unit.tabId
          const sourceWindowId = firstTabId == null
            ? undefined
            : sourceWindowByTabId.get(firstTabId)
          const moved = unit.kind === 'group'
            ? sourceWindowId != null && (yield* moveGroupWithRetry(
              unit,
              plan.destinationWindowId,
              sourceWindowId,
              movingTabIds,
            ))
            : sourceWindowId != null && (yield* moveTabWithRetry(
              unit.tabId,
              plan.destinationWindowId,
              false,
              sourceWindowId,
              movingTabIds,
            ))
          if (!sourceWindowId || !moved) {
            operationFailed = true
            break
          }
          const increment = unit.kind === 'group' ? unit.tabIds.length : 1
          if (!(yield* persistProgress(increment))) {
            operationFailed = true
            break
          }
        }
      }

      const activeRestored = yield* activateTabWithActivityReceipt(
        plan.destinationActiveTabId,
        plan.destinationWindowId,
      )
      if (!activeRestored) operationFailed = true
      return yield* verifyMutation(plan, operationFailed)
    })

    const runConfirmedMerge = Effect.fn('DesktopWindowMerge.runConfirmedMerge')(function* (
      preview: DesktopWindowMergePreview,
    ) {
      const currentAvailability = yield* availability()
      if (!currentAvailability.available) {
        return { ok: false, reason: currentAvailability.reason }
      }
      if (yield* reconcileInterruptedJournal()) return { ok: true, status: 'busy' }

      const nativeSelection = yield* Effect.result(nativeBridge.revalidateDesktopWindows(
        preview.destinationWindowId,
        preview.selectionToken,
      ))
      if (Result.isFailure(nativeSelection)) {
        return yield* changedPreview(preview.ownerTabId, preview.destinationWindowId)
      }
      const currentPlan = yield* Effect.result(capturePlan(
        preview.destinationWindowId,
        nativeSelection.success.windowIds,
      ))
      if (
        Result.isFailure(currentPlan) ||
        !desktopWindowMergePlansMatch(preview.plan, currentPlan.success)
      ) {
        return yield* changedPreview(preview.ownerTabId, preview.destinationWindowId)
      }

      const at = now()
      const sessionId = makeId('session')
      const runningJournal: DesktopWindowMergeJournal = {
        version: 1,
        sessionId,
        status: 'running',
        ownerTabId: preview.ownerTabId,
        destinationWindowId: preview.destinationWindowId,
        sourceWindowCount: preview.plan.sourceWindowCount,
        plannedTabCount: preview.plan.movingTabIds.length,
        movedTabCount: 0,
        remainingTabCount: preview.plan.movingTabIds.length,
        startedAtMs: at,
        updatedAtMs: at,
      }
      yield* Ref.set(activeSessionId, sessionId)
      const started = yield* Effect.result(writeJournal(runningJournal))
      if (Result.isFailure(started)) {
        yield* Ref.set(activeSessionId, null)
        return { ok: false, reason: started.failure.reason }
      }

      return yield* Effect.gen(function* () {
        const mutation = yield* executeMutation(preview.plan, runningJournal)
        const completedAt = now()
        const terminalJournal: DesktopWindowMergeJournal = mutation.succeeded
          ? {
              ...runningJournal,
              status: 'succeeded',
              movedTabCount: mutation.movedTabCount,
              remainingTabCount: mutation.remainingTabCount,
              updatedAtMs: completedAt,
            }
          : {
              ...runningJournal,
              status: 'partial',
              movedTabCount: mutation.movedTabCount,
              remainingTabCount: mutation.remainingTabCount,
              updatedAtMs: completedAt,
              errorCode: 'browser-mutation-failed',
            }
        const journal = yield* persistTerminalJournal(terminalJournal)
        yield* Ref.update(previews, (current) => {
          const next = new Map(current)
          next.delete(preview.previewId)
          return next
        })
        return {
          ok: true,
          status: journal.status === 'succeeded' ? 'succeeded' : 'partial',
          journal,
        }
      }).pipe(Effect.ensuring(Ref.set(activeSessionId, null)))
    })

    const preview = Effect.fn('DesktopWindowMerge.preview')(function* (
      requesterTabId: number,
      destinationWindowId: number,
    ) {
      const currentAvailability = yield* availability()
      if (!currentAvailability.available) {
        return { ok: false, reason: currentAvailability.reason }
      }
      const journal = yield* Effect.result(reconcileInterruptedJournal())
      if (Result.isFailure(journal)) return { ok: false, reason: journal.failure.reason }
      if (journal.success) return { ok: true, status: 'busy' }
      return yield* freshPreview(requesterTabId, destinationWindowId)
    })

    const confirm = Effect.fn('DesktopWindowMerge.confirm')(function* (
      requesterTabId: number,
      destinationWindowId: number,
      previewId: string,
    ) {
      const candidate = (yield* Ref.get(previews)).get(previewId)
      const ownerMatches = candidate !== undefined && (
        candidate.ownerTabId === requesterTabId ||
        candidate.ownerTabId === DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID
      )
      if (
        !candidate ||
        !ownerMatches ||
        candidate.destinationWindowId !== destinationWindowId ||
        now() - candidate.createdAtMs > DESKTOP_WINDOW_MERGE_PREVIEW_LIFETIME_MS
      ) return yield* changedPreview(requesterTabId, destinationWindowId)

      // A menu-owned preview is confirmed by the handed-off Tab Out page,
      // which becomes the owner for the journal, result surfaces, and
      // acknowledgement; the frozen plan itself is untouched.
      const confirmedCandidate = candidate.ownerTabId === DESKTOP_WINDOW_MERGE_MENU_REQUESTER_TAB_ID
        ? { ...candidate, ownerTabId: requesterTabId }
        : candidate

      const locked = yield* Effect.result(runPromiseExclusiveEffect(
        runExclusive,
        runConfirmedMerge(confirmedCandidate),
        (cause) => new DesktopWindowMergeLockError({
          busy: cause instanceof DesktopWindowMergeLockBusy,
        }),
      ))
      if (Result.isSuccess(locked)) return locked.success
      if (locked.failure._tag === 'DesktopWindowMergeServiceError') {
        return { ok: false, reason: locked.failure.reason }
      }
      return locked.failure.busy
        ? { ok: true, status: 'busy' }
        : { ok: false, reason: 'coordination-unavailable' }
    })

    const isDashboardTab = (tab: chrome.tabs.Tab | undefined) => {
      const extensionOrigin = chromeApi.runtime?.id
        ? `chrome-extension://${chromeApi.runtime.id}/`
        : ''
      if (!extensionOrigin) return false
      const url = tab?.pendingUrl || tab?.url || ''
      const dashboardUrl = `${extensionOrigin}index.html`
      return url === dashboardUrl ||
        url.startsWith(`${dashboardUrl}?`) ||
        url.startsWith(`${dashboardUrl}#`)
    }

    const readOrAdoptJournal = Effect.fn(
      'DesktopWindowMerge.readOrAdoptJournal',
    )(function* (
      requesterTabId: number,
      requesterWindowId: number,
      expectedSessionId: string,
    ) {
      const journal = yield* readJournal()
      if (!journal || journal.sessionId !== expectedSessionId) return journal
      if (journal.ownerTabId === requesterTabId) return journal

      const [requesterWindow, tabsResult] = yield* Effect.all([
        browserTabs.getWindow(requesterWindowId),
        browserTabs.queryAllTabsResult(),
      ] as const, { concurrency: 'unbounded' })
      if (!requesterWindow?.focused || !tabsResult.ok) return journal

      const requesterTab = tabsResult.value.find((tab) => tab.id === requesterTabId)
      const ownerTab = tabsResult.value.find((tab) => tab.id === journal.ownerTabId)
      if (
        requesterTab?.active !== true ||
        requesterTab.windowId !== requesterWindowId ||
        !isDashboardTab(requesterTab) ||
        isDashboardTab(ownerTab)
      ) return journal

      const currentRequesterWindow = yield* browserTabs.getWindow(requesterWindowId)
      if (!currentRequesterWindow?.focused) return journal
      const adoptedJournal = {
        ...journal,
        ownerTabId: requesterTabId,
        updatedAtMs: now(),
      }
      yield* writeJournal(adoptedJournal)
      const verified = yield* readJournal()
      return verified?.sessionId === expectedSessionId
        ? verified
        : null
    })

    const getStatus = Effect.fn('DesktopWindowMerge.getStatus')(function* (
      requesterTabId: number,
      requesterWindowId: number,
      requesterActive: boolean,
    ) {
      const currentAvailability = yield* availability()
      const journalResult = yield* Effect.result(reconcileInterruptedJournal())
      if (Result.isFailure(journalResult) || !journalResult.success) {
        return { ok: true, availability: currentAvailability, session: null }
      }
      let journal = journalResult.success
      let isOwner = journal.ownerTabId === requesterTabId
      if (!isOwner && requesterActive) {
        const adoption = yield* Effect.result(runPromiseExclusiveEffect(
          runExclusive,
          readOrAdoptJournal(
            requesterTabId,
            requesterWindowId,
            journal.sessionId,
          ),
          (cause) => new DesktopWindowMergeLockError({
            busy: cause instanceof DesktopWindowMergeLockBusy,
          }),
        ))
        if (Result.isSuccess(adoption) && adoption.success) {
          journal = adoption.success
        } else {
          const latest = yield* Effect.result(readJournal())
          if (Result.isSuccess(latest) && latest.success) journal = latest.success
        }
        isOwner = journal.ownerTabId === requesterTabId
      }
      return {
        ok: true,
        availability: currentAvailability,
        session: { journal, isOwner },
      }
    })

    const acknowledge = Effect.fn('DesktopWindowMerge.acknowledge')(function* (
      requesterTabId: number,
      sessionId: string,
    ) {
      const journal = yield* readJournal().pipe(Effect.catch(() => Ref.get(lastJournal)))
      if (
        !journal ||
        journal.sessionId !== sessionId ||
        journal.ownerTabId !== requesterTabId ||
        journal.status === 'running'
      ) return false
      return yield* removeJournal()
    })

    const consumeExpectedTabActivation = Effect.fn(
      'DesktopWindowMerge.consumeExpectedTabActivation',
    )(function* (tabId: number, windowId: number) {
      const at = now()
      return yield* Ref.modify(expectedTabActivations, (current) => {
        const live = current.filter((receipt) => receipt.expiresAtMs > at)
        const index = live.findIndex((receipt) =>
          receipt.windowId === windowId && receipt.tabIds.has(tabId))
        if (index < 0) return [false, live] as const
        return [true, live.toSpliced(index, 1)] as const
      })
    })

    return DesktopWindowMerge.of({
      acknowledge,
      consumeExpectedTabActivation,
      confirm: (requesterTabId, destinationWindowId, previewId) => confirm(
        requesterTabId,
        destinationWindowId,
        previewId,
      ) as Effect.Effect<DesktopWindowMergeConfirmResponse>,
      getStatus: (requesterTabId, requesterWindowId, requesterActive) => getStatus(
        requesterTabId,
        requesterWindowId,
        requesterActive,
      ) as Effect.Effect<DesktopWindowMergeStatusResponse>,
      preview: (requesterTabId, destinationWindowId) => preview(
        requesterTabId,
        destinationWindowId,
      ) as Effect.Effect<DesktopWindowMergePreviewResponse>,
    })
  }))
}
