import type { DashboardTab } from '../../src/extension/types'

export function makeCachedSuspendedTab(pageUrl: string): DashboardTab {
  return {
    id: 7,
    url: pageUrl,
    rawUrl: `chrome-extension://suspender-id/suspended.html#ttl=Example%20Docs&uri=${pageUrl}`,
    suspended: true,
    title: 'Example Docs',
    status: 'complete',
    favIconUrl: '',
    windowId: 1,
    active: false,
    pinned: false,
    groupId: -1,
    isTabOut: false,
    isApp: false,
    index: 0
  }
}
