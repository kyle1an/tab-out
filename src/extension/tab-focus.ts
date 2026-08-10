import { Effect } from 'effect'

import { getAppRuntime } from './app-runtime.js'
import { BrowserTabs } from './browser-tabs-service.js'
import { liveTabByValidatedId, liveTabsMatchingTarget, liveTabUrlForIdentity } from './live-tab-matching.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { PageTarget } from './page-target.js'

export type ExistingTabTarget = PageTarget & {
  tabId?: number
  windowId?: number
}

/**
 * `activated` is a real partial success: Chrome accepted the tab update but
 * rejected focusing its window. `failed` means the exact tab still existed
 * but Chrome did not confirm activation. Only `not-found` proves the stored
 * identity is stale; `unknown` means the live-tab read itself failed.
 */
export type ExistingTabFocusResult = {
  status: 'focused' | 'activated' | 'failed' | 'not-found' | 'unknown'
}

export function tabFocusResultToastMessage(status: ExistingTabFocusResult['status']): string | null {
  switch (status) {
    case 'focused':
      return null
    case 'activated':
      return 'Tab activated, but its window could not be focused'
    case 'failed':
      return 'Could not activate tab'
    case 'not-found':
      return 'Tab is no longer open'
    case 'unknown':
      return 'Could not read open tabs'
  }
}

function focusResult(status: ExistingTabFocusResult['status']): ExistingTabFocusResult {
  return { status }
}

function tabTargetEffectiveUrl(target: PageTarget | null | undefined, fallbackUrl = ''): string {
  return unwrapSuspenderUrl(target?.url || target?.tabUrl || target?.rawUrl || fallbackUrl || '')
}

function suspenderExtensionId(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return ''
  const parsed = URL.parse(url)
  if (!parsed || !parsed.pathname.endsWith('/suspended.html')) return ''
  return parsed.hostname
}

function isSuspendedUrlForTarget(tabUrl: string | undefined, targetEffective: string): boolean {
  if (!tabUrl || tabUrl === targetEffective) return false
  return unwrapSuspenderUrl(tabUrl) === targetEffective
}

const requestSuspenderUnsuspend = Effect.fn('tabFocus.requestSuspenderUnsuspend')(function* (
  tab: chrome.tabs.Tab,
  targetEffective: string,
) {
  if (typeof tab.id !== 'number') return false
  if (!isSuspendedUrlForTarget(tab.url, targetEffective)) return false
  const extensionId = suspenderExtensionId(tab.url)
  if (!extensionId) return false
  const browserTabs = yield* BrowserTabs
  return yield* browserTabs.requestExternalUnsuspend(extensionId, tab.id)
})

const applyUnsuspend = Effect.fn('tabFocus.applyUnsuspend')(function* (
  tab: chrome.tabs.Tab,
  targetEffective: string,
  updateProperties?: chrome.tabs.UpdateProperties,
) {
  if (typeof tab.id !== 'number') return 'failed'
  if (!isSuspendedUrlForTarget(tab.url, targetEffective)) return 'not-suspended'
  const browserTabs = yield* BrowserTabs
  const didRequestUnsuspend = yield* requestSuspenderUnsuspend(tab, targetEffective)
  const liveTab = yield* browserTabs.getTab(tab.id)
  if (!liveTab || !liveTabByValidatedId([liveTab], {
    tabId: tab.id,
    url: targetEffective,
    rawUrl: tab.url,
  })) {
    return 'not-found'
  }
  if (didRequestUnsuspend) return 'ready'
  if (updateProperties) {
    updateProperties.url = targetEffective
  } else {
    const updatedTab = yield* browserTabs.updateTab(tab.id, { url: targetEffective })
    if (!updatedTab) return 'failed'
  }
  return 'ready'
})

const focusMatchedTabResult = Effect.fn('tabFocus.focusMatchedTab')(function* (
  match: chrome.tabs.Tab,
  targetEffective: string,
) {
  if (typeof match.id !== 'number') return focusResult('failed')
  const browserTabs = yield* BrowserTabs
  const updateProperties: chrome.tabs.UpdateProperties = { active: true }
  const unsuspendResult = yield* applyUnsuspend(match, targetEffective, updateProperties)
  if (unsuspendResult === 'not-found') return focusResult('not-found')
  if (unsuspendResult === 'failed') return focusResult('failed')
  const updatedTab = yield* browserTabs.updateTab(match.id, updateProperties)
  if (!updatedTab) return focusResult('failed')
  return focusResult(
    (yield* browserTabs.focusWindow(updatedTab.windowId)) ? 'focused' : 'activated',
  )
})

export const unsuspendExistingTabEffect = Effect.fn('tabFocus.unsuspendExistingTab')(function* (
  tab: chrome.tabs.Tab,
  target: PageTarget,
) {
  if (typeof tab.id !== 'number') return false
  return (yield* applyUnsuspend(tab, tabTargetEffectiveUrl(target, tab.url || ''))) === 'ready'
})

/**
 * Focus a tab that the caller already resolved from a successful live-browser
 * read or move. The identity guard stays at this seam, but the caller does not
 * pay for a second whole-browser inventory read.
 */
export const focusResolvedTabTargetEffect = Effect.fn('tabFocus.focusResolvedTarget')(function* (
  tab: chrome.tabs.Tab,
  target: ExistingTabTarget,
) {
  const match = liveTabByValidatedId([tab], target)
  if (!match) return focusResult('not-found')
  return yield* focusMatchedTabResult(match, tabTargetEffectiveUrl(target, match.url || ''))
})

export const focusExistingTabTargetEffect = Effect.fn('tabFocus.focusExistingTarget')(function* (
  target: ExistingTabTarget,
) {
  if (!Number.isInteger(target.tabId)) return focusResult('not-found')

  const browserTabs = yield* BrowserTabs
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) return focusResult('unknown')
  const match = liveTabByValidatedId(allTabsResult.value, target)
  if (!match) return focusResult('not-found')
  return yield* focusResolvedTabTargetEffect(match, target)
})

export function focusExistingTabTargetResult(target: ExistingTabTarget): Promise<ExistingTabFocusResult> {
  return getAppRuntime().runPromise(focusExistingTabTargetEffect(target))
}

export const focusExactTabTargetEffect = Effect.fn('tabFocus.focusExactTarget')(function* (url: string) {
  if (!url) return focusResult('not-found')

  const browserTabs = yield* BrowserTabs
  const currentWindowId = (yield* browserTabs.getCurrentWindow())?.id ?? -1
  // Keep tab identity as the last awaited read before activation. Chrome may
  // expose a navigation through pendingUrl while the window lookup settles.
  const allTabsResult = yield* browserTabs.queryAllTabsResult()
  if (!allTabsResult.ok) return focusResult('unknown')
  const allTabs = allTabsResult.value
  const targetEffective = unwrapSuspenderUrl(url)
  const matches = liveTabsMatchingTarget(allTabs, { tabUrl: url })
  if (matches.length === 0) return focusResult('not-found')

  const match = matches.find((tab) => tab.windowId === currentWindowId) || matches[0]
  if (!match) return focusResult('not-found')
  return yield* focusMatchedTabResult(match, targetEffective)
})

export function focusExactTabTargetResult(url: string): Promise<ExistingTabFocusResult> {
  return getAppRuntime().runPromise(focusExactTabTargetEffect(url))
}

export const focusTabTargetEffect = Effect.fn('tabFocus.focusTarget')(function* (url: string) {
  if (!url) return false

  const browserTabs = yield* BrowserTabs
  const currentWindowId = (yield* browserTabs.getCurrentWindow())?.id ?? null
  const allTabs = (yield* browserTabs.queryAllTabsResult()).value
  const targetEffective = unwrapSuspenderUrl(url)

  let matches = liveTabsMatchingTarget(allTabs, { tabUrl: url })

  if (matches.length === 0) {
    const targetParsed = URL.parse(targetEffective)
    if (targetParsed) {
      const targetHost = targetParsed.hostname
      matches = allTabs.filter((tab) => {
        return URL.parse(unwrapSuspenderUrl(liveTabUrlForIdentity(tab)))?.hostname === targetHost
      })
    }
  }

  if (matches.length === 0) return false

  const match = matches.find((tab) => tab.windowId !== currentWindowId) || matches[0]
  if (!match) return false
  return (yield* focusMatchedTabResult(match, targetEffective)).status === 'focused'
})
