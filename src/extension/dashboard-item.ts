import type { DashboardTab } from './types'

/**
 * makeDashboardItem — the one constructor for Dashboard Items that are not
 * normalized open tabs (bookmark, history, and saved-page Sources). Owns the
 * read-only-item baseline so adding a DashboardTab field is a one-module
 * change instead of a per-Source literal hunt; `rawUrl` defaults to the
 * effective url (these Sources never carry suspender-rewritten URLs).
 *
 * Live open tabs are normalized in tabs.ts instead — their fields come from
 * Chrome, not from defaults.
 */
export function makeDashboardItem(
  item: Pick<DashboardTab, 'url' | 'title' | 'sourceType'> & Partial<DashboardTab>,
): DashboardTab {
  return {
    rawUrl: item.url,
    suspended: false,
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    ...item,
  }
}
