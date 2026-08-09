import { isSuspended, unwrapSuspenderTitle, unwrapSuspenderUrl } from './suspension.js'
import { isTabOutPageUrl } from './tab-out-url.js'
import type { DashboardTab } from './types'

export type DashboardTabNormalizationContext = {
  previousTab?: DashboardTab
  runtimeId?: string | null
  windowType?: chrome.windows.Window['type']
}

/**
 * Translate one live Chrome tab into the Dashboard Item vocabulary shared by
 * the page, service worker, Working Set, and startup snapshot paths.
 */
export function normalizeChromeTabToDashboardItem(
  tab: chrome.tabs.Tab,
  {
    previousTab,
    runtimeId = null,
    windowType,
  }: DashboardTabNormalizationContext = {},
): DashboardTab {
  const rawUrl = tab.url || ''
  const effectiveUrl = unwrapSuspenderUrl(rawUrl)
  const suspended = isSuspended(rawUrl, effectiveUrl)
  let title = tab.title || ''

  if (suspended) {
    const suspenderTitle = unwrapSuspenderTitle(rawUrl)
    if (suspenderTitle) title = suspenderTitle
  }

  const retainsSuspendedTitle =
    !suspended &&
    tab.status === 'loading' &&
    previousTab?.url === effectiveUrl &&
    !!previousTab.title.replaceAll('\u200E', '').trim() &&
    (previousTab.suspended || previousTab.retainedSuspendedTitle === true)

  if (retainsSuspendedTitle) title = previousTab.title

  return {
    ...(tab.id === undefined ? {} : { id: tab.id }),
    url: effectiveUrl,
    rawUrl,
    suspended,
    title,
    ...(tab.status === undefined ? {} : { status: tab.status }),
    ...(retainsSuspendedTitle ? { retainedSuspendedTitle: true } : {}),
    favIconUrl: tab.favIconUrl || '',
    audible: !!tab.audible,
    muted: !!tab.mutedInfo?.muted,
    windowId: tab.windowId,
    active: !!tab.active,
    pinned: !!tab.pinned,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    isTabOut: isTabOutPageUrl(rawUrl, runtimeId),
    isApp: windowType === 'app' || windowType === 'popup',
    index: tab.index,
  }
}
