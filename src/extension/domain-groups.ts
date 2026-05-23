import { domainGroupCardId } from './domain-card-id.js'
import { registrableDomain } from './domains.js'
import { isPinnableDomain, normalizePinnedDomains } from './domain-pins.js'
import { isClosedSavedDashboardTab } from './dashboard-source.js'
import type { CustomGroupRule, DashboardTab, DomainGroup, DomainGroupBuildOptions } from './types'

/**
 * @param {DashboardTab[]} realTabs
 * @param {DomainGroupBuildOptions} [opts]
 * @returns {DomainGroup[]}
 */
export function buildDomainGroups(
  realTabs: DashboardTab[],
  { previousOrder = new Map(), customGroups = [], pinnedDomains = [] }: DomainGroupBuildOptions = {}
): DomainGroup[] {
  // Group tabs by domain. Custom groups and utility cards (apps / new tabs)
  // still split out, but homepage-like routes stay in their native domain cards.
  const groupMap: Record<string, DomainGroup> = {}
  const appTabs: DashboardTab[] = []
  const tabOutTabs: DashboardTab[] = []

  function matchCustomGroup(url: string): CustomGroupRule | null {
    try {
      const parsed = new URL(url)
      return (
        customGroups.find((r) => {
          const hostMatch = r.hostname ? parsed.hostname === r.hostname : r.hostnameEndsWith ? parsed.hostname.endsWith(r.hostnameEndsWith) : false
          if (!hostMatch) return false
          if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix)
          return true
        }) || null
      )
    } catch {
      return null
    }
  }

  for (const tab of realTabs) {
    try {
      if (tab.isTabOut) {
        tabOutTabs.push(tab)
        continue
      }

      if (tab.isApp) {
        appTabs.push(tab)
        continue
      }

      const customRule = matchCustomGroup(tab.url)
      if (customRule) {
        const key = customRule.groupKey
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] }
        groupMap[key].tabs.push(tab)
        continue
      }

      let hostname
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files'
      } else {
        hostname = new URL(tab.url).hostname
      }
      if (!hostname) continue

      // Roll up subdomains so dev1.foo.com + dev2.foo.com share one
      // card. registrableDomain() is a no-op for IPs, localhost, and
      // user-space suffixes like user.github.io — see domains.js.
      const key = registrableDomain(hostname)
      if (!groupMap[key]) groupMap[key] = { domain: key, tabs: [] }
      groupMap[key].tabs.push(tab)
    } catch {
      // Skip malformed URLs
    }
  }

  if (tabOutTabs.length > 0) {
    groupMap['__tab-out__'] = { domain: '__tab-out__', label: 'New tabs', tabs: tabOutTabs }
  }
  if (appTabs.length > 0) {
    groupMap['__standalone-apps__'] = { domain: '__standalone-apps__', label: 'Apps', tabs: appTabs }
  }

  const normalizedPinnedDomains = normalizePinnedDomains(pinnedDomains)
  const pinnedOrder = new Map(normalizedPinnedDomains.map((domain, index) => [domain, index]))

  function orderTier(group: DomainGroup): number {
    if (group.pinned) return 0
    if (orderCount(group) > 0) return 1
    return 2
  }

  function orderCount(group: DomainGroup): number {
    return group.tabs.filter((tab) => !isClosedSavedDashboardTab(tab)).length
  }

  const groupedDomains = Object.values(groupMap)
  groupedDomains.forEach((group) => {
    group.pinned = isPinnableDomain(group.domain) && pinnedOrder.has(group.domain)
  })

  // Sort by user-pinned cards, then tab count. Utility cards stay in the
  // normal flow unless the user pins them explicitly.
  groupedDomains.sort((a, b) => {
    const tierDelta = orderTier(a) - orderTier(b)
    if (tierDelta !== 0) return tierDelta
    if (a.pinned && b.pinned) return (pinnedOrder.get(a.domain) ?? 0) - (pinnedOrder.get(b.domain) ?? 0)
    return orderCount(b) - orderCount(a)
  })

  // Stable re-sort: previously-seen cards keep their prior order; new
  // cards stay where the pinned/tab-count sort put them (at the end,
  // since `return 0` preserves Array.prototype.sort stability).
  groupedDomains.sort((a, b) => {
    const tierDelta = orderTier(a) - orderTier(b)
    if (tierDelta !== 0) return tierDelta
    if (a.pinned && b.pinned) return (pinnedOrder.get(a.domain) ?? 0) - (pinnedOrder.get(b.domain) ?? 0)
    const aPrev = previousOrder.get(domainGroupCardId(a))
    const bPrev = previousOrder.get(domainGroupCardId(b))
    if (aPrev !== undefined && bPrev !== undefined) return aPrev - bPrev
    if (aPrev !== undefined) return -1
    if (bPrev !== undefined) return 1
    return 0
  })

  return groupedDomains
}
