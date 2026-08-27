import { Effect } from 'effect'

import {
  DESKTOP_WINDOW_MERGE_START_CONFIRM_MESSAGE,
  isDesktopWindowMergeStartConfirmAcknowledgement,
} from '../desktop-window-merge-contract.js'
import { isTabOutPageUrl, tabOutDashboardCanonicalUrl } from '../tab-out-url.js'
import type { ChromeApi } from './chrome-api.js'

const START_PREVIEW_DELIVERY_ATTEMPTS = 40
const START_PREVIEW_RETRY_DELAY_MILLIS = 250

export type DesktopWindowMergeHandoffOptions = {
  deliveryAttempts?: number
  retryDelayMillis?: number
}

function dashboardTabInWindow(
  tabs: readonly chrome.tabs.Tab[],
  runtimeId: string | undefined,
): chrome.tabs.Tab | undefined {
  const dashboardTabs = tabs.filter((tab) => isTabOutPageUrl(tab.url, runtimeId))
  return dashboardTabs.find((tab) => tab.active) ??
    dashboardTabs.find((tab) => tab.pinned) ??
    dashboardTabs[0]
}

const focusOrCreateDashboardTab = Effect.fn(
  'desktopWindowMergeHandoff.focusOrCreateDashboardTab',
)(function* (chromeApi: ChromeApi, windowId: number) {
  const tabs = yield* Effect.tryPromise(() => chromeApi.tabs.query({ windowId })).pipe(
    Effect.catch(() => Effect.succeed<chrome.tabs.Tab[]>([])),
  )
  const existing = dashboardTabInWindow(tabs, chromeApi.runtime.id)
  if (typeof existing?.id === 'number') {
    const existingTabId = existing.id
    const activated = yield* Effect.tryPromise(
      () => chromeApi.tabs.update(existingTabId, { active: true }),
    ).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    )
    if (activated) return existingTabId
  }

  const url = tabOutDashboardCanonicalUrl(chromeApi.runtime.id)
  if (!url) return null
  const created = yield* Effect.tryPromise(
    () => chromeApi.tabs.create({ windowId, url, active: true }),
  ).pipe(
    Effect.catch(() => Effect.tryPromise(() => chromeApi.tabs.create({ url, active: true }))),
    Effect.catch(() => Effect.succeed(null)),
  )
  return typeof created?.id === 'number' ? created.id : null
})

/**
 * Toolbar handoff for a menu-confirmed `Merge windows on this desktop…`:
 * focus (or create) a Tab Out page in the invoking window, then deliver the
 * start-confirm intent until the page's merge host acknowledges it. That
 * page submits the confirmation so it becomes the journal owner and hosts
 * the progress, result, and revalidation surfaces; a freshly created or
 * discarded page needs the bounded retry window to finish hydrating its
 * message listener.
 */
export const handoffDesktopWindowMergeToWindowEffect = Effect.fn(
  'desktopWindowMergeHandoff.toWindow',
)(function* (
  chromeApi: ChromeApi,
  windowId: number,
  previewId: string,
  options: DesktopWindowMergeHandoffOptions = {},
) {
  const {
    deliveryAttempts = START_PREVIEW_DELIVERY_ATTEMPTS,
    retryDelayMillis = START_PREVIEW_RETRY_DELAY_MILLIS,
  } = options
  const dashboardTabId = yield* focusOrCreateDashboardTab(chromeApi, windowId)
  if (dashboardTabId === null) return false

  for (let attempt = 0; attempt < deliveryAttempts; attempt += 1) {
    if (attempt > 0) yield* Effect.sleep(retryDelayMillis)
    const response = yield* Effect.tryPromise(
      () => chromeApi.tabs.sendMessage(dashboardTabId, {
        type: DESKTOP_WINDOW_MERGE_START_CONFIRM_MESSAGE,
        previewId,
      }),
    ).pipe(Effect.catch(() => Effect.succeed(null)))
    if (isDesktopWindowMergeStartConfirmAcknowledgement(response)) return true
  }
  return false
})
