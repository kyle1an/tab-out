import { focusWindow, getCurrentWindow, getTab, queryAllTabsResult, requestExternalUnsuspend, updateTab } from './browser-tabs-gateway.js'
import { liveTabByValidatedId, liveTabsMatchingTarget, liveTabUrlForIdentity } from './live-tab-matching.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { PageTarget } from './page-target.js'

export type ExistingTabTarget = PageTarget & {
  tabId?: number
  windowId?: number
}

export type ExactTabFocusResult = {
  status: 'focused' | 'activated' | 'failed' | 'not-found' | 'unknown'
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

type MatchedTabFocusResult = {
  status: 'focused' | 'activated' | 'failed' | 'not-found'
}

type ApplyUnsuspendResult = 'not-suspended' | 'ready' | 'failed' | 'not-found'

function tabTargetEffectiveUrl(target: PageTarget | null | undefined, fallbackUrl = ''): string {
  return unwrapSuspenderUrl(target?.url || target?.tabUrl || target?.rawUrl || fallbackUrl || '')
}

function suspenderExtensionId(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return ''
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.endsWith('/suspended.html')) return ''
    return parsed.hostname
  } catch {
    return ''
  }
}

function isSuspendedUrlForTarget(tabUrl: string | undefined, targetEffective: string): boolean {
  if (!tabUrl || tabUrl === targetEffective) return false
  return unwrapSuspenderUrl(tabUrl) === targetEffective
}

async function requestSuspenderUnsuspend(tab: chrome.tabs.Tab, targetEffective: string): Promise<boolean> {
  if (typeof tab.id !== 'number') return false
  if (!isSuspendedUrlForTarget(tab.url, targetEffective)) return false
  const extensionId = suspenderExtensionId(tab.url)
  if (!extensionId) return false
  return requestExternalUnsuspend(extensionId, tab.id)
}

async function applyUnsuspend(tab: chrome.tabs.Tab, targetEffective: string, updateProperties?: chrome.tabs.UpdateProperties): Promise<ApplyUnsuspendResult> {
  if (typeof tab.id !== 'number') return 'failed'
  if (!isSuspendedUrlForTarget(tab.url, targetEffective)) return 'not-suspended'
  const didRequestUnsuspend = await requestSuspenderUnsuspend(tab, targetEffective)
  const liveTab = await getTab(tab.id)
  if (!liveTab || !liveTabByValidatedId([liveTab], {
    tabId: tab.id,
    url: targetEffective,
    rawUrl: tab.url
  })) {
    return 'not-found'
  }
  if (didRequestUnsuspend) return 'ready'
  if (updateProperties) {
    updateProperties.url = targetEffective
  } else {
    const updatedTab = await updateTab(tab.id, { url: targetEffective })
    if (!updatedTab) return 'failed'
  }
  return 'ready'
}

async function focusMatchedTabResult(
  match: chrome.tabs.Tab,
  targetEffective: string
): Promise<MatchedTabFocusResult> {
  if (typeof match.id !== 'number') return { status: 'failed' }
  const updateProperties: chrome.tabs.UpdateProperties = { active: true }
  const unsuspendResult = await applyUnsuspend(match, targetEffective, updateProperties)
  if (unsuspendResult === 'not-found') return { status: 'not-found' }
  if (unsuspendResult === 'failed') return { status: 'failed' }
  const updatedTab = await updateTab(match.id, updateProperties)
  if (!updatedTab) return { status: 'failed' }
  return { status: await focusWindow(updatedTab.windowId) ? 'focused' : 'activated' }
}

export async function unsuspendExistingTab(tab: chrome.tabs.Tab, target: PageTarget): Promise<boolean> {
  if (typeof tab.id !== 'number') return false
  return (await applyUnsuspend(tab, tabTargetEffectiveUrl(target, tab.url || ''))) === 'ready'
}

/**
 * Focus a tab that the caller already resolved from a successful live-browser
 * read or move. The identity guard stays at this seam, but the caller does not
 * pay for a second whole-browser inventory read.
 */
export async function focusResolvedTabTargetResult(
  tab: chrome.tabs.Tab,
  target: ExistingTabTarget
): Promise<ExistingTabFocusResult> {
  const match = liveTabByValidatedId([tab], target)
  if (!match) return { status: 'not-found' }
  return focusMatchedTabResult(match, tabTargetEffectiveUrl(target, match.url || ''))
}

export async function focusExistingTabTargetResult(target: ExistingTabTarget): Promise<ExistingTabFocusResult> {
  if (!Number.isInteger(target.tabId)) return { status: 'not-found' }

  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) return { status: 'unknown' }
  const match = liveTabByValidatedId(allTabsResult.value, target)
  if (!match) return { status: 'not-found' }
  return focusResolvedTabTargetResult(match, target)
}

export async function focusExactTabTargetResult(url: string): Promise<ExactTabFocusResult> {
  if (!url) return { status: 'not-found' }

  const currentWindowId = (await getCurrentWindow())?.id ?? -1
  // Keep tab identity as the last awaited read before activation. Chrome may
  // expose a navigation through pendingUrl while the window lookup settles.
  const allTabsResult = await queryAllTabsResult()
  if (!allTabsResult.ok) return { status: 'unknown' }
  const allTabs = allTabsResult.value
  const targetEffective = unwrapSuspenderUrl(url)
  const matches = liveTabsMatchingTarget(allTabs, { tabUrl: url })
  if (matches.length === 0) return { status: 'not-found' }

  const match = matches.find((tab) => tab.windowId === currentWindowId) || matches[0]
  if (!match) return { status: 'not-found' }
  return focusMatchedTabResult(match, targetEffective)
}

export async function focusTabTarget(url: string): Promise<boolean> {
  if (!url) return false

  const currentWindowId = (await getCurrentWindow())?.id ?? null
  const allTabs = (await queryAllTabsResult()).value
  const targetEffective = unwrapSuspenderUrl(url)

  let matches = liveTabsMatchingTarget(allTabs, { tabUrl: url })

  if (matches.length === 0) {
    try {
      const targetHost = new URL(targetEffective).hostname
      matches = allTabs.filter((tab) => {
        try {
          return new URL(unwrapSuspenderUrl(liveTabUrlForIdentity(tab))).hostname === targetHost
        } catch {
          return false
        }
      })
    } catch {}
  }

  if (matches.length === 0) return false

  const match = matches.find((tab) => tab.windowId !== currentWindowId) || matches[0]
  if (!match) return false
  return (await focusMatchedTabResult(match, targetEffective)).status === 'focused'
}
