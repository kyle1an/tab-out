import { registrableDomain } from './domains.js'
import { isPinnableDomain, normalizePinnedDomains } from './domain-pins.js'

/** @typedef {import('./types').DashboardTab} DashboardTab */
/** @typedef {import('./types').DomainGroup} DomainGroup */
/** @typedef {import('./types').DomainGroupBuildOptions} DomainGroupBuildOptions */

/**
 * @param {DashboardTab[]} realTabs
 * @param {DomainGroupBuildOptions} [opts]
 * @returns {DomainGroup[]}
 */
export function buildDomainGroups(
  realTabs,
  { previousOrder = new Map(), customGroups = [], pinnedDomains = [] } = {}
) {
  // Group tabs by domain. Custom groups and utility cards (apps / new tabs)
  // still split out, but homepage-like routes stay in their native domain cards.
  const groupMap = {}
  const appTabs = []
  const tabOutTabs = []

  function matchCustomGroup(url) {
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

  function orderTier(group) {
    if (group.domain === '__tab-out__') return 0
    if (group.domain === '__standalone-apps__') return 1
    if (group.pinned) return 2
    return 3
  }

  const groupedDomains = Object.values(groupMap)
  groupedDomains.forEach((group) => {
    group.pinned = isPinnableDomain(group.domain) && pinnedOrder.has(group.domain)
  })

  // Sort by fixed system cards, then user-pinned domains, then tab count.
  groupedDomains.sort((a, b) => {
    const tierDelta = orderTier(a) - orderTier(b)
    if (tierDelta !== 0) return tierDelta
    if (a.pinned && b.pinned) return pinnedOrder.get(a.domain) - pinnedOrder.get(b.domain)
    return b.tabs.length - a.tabs.length
  })

  // Stable re-sort: previously-seen cards keep their prior order; new
  // cards stay where the utility-card/tab-count sort put them (at the
  // end, since `return 0` preserves Array.prototype.sort stability).
  const stableDomainId = (g) => 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-')
  groupedDomains.sort((a, b) => {
    const tierDelta = orderTier(a) - orderTier(b)
    if (tierDelta !== 0) return tierDelta
    if (a.pinned && b.pinned) return pinnedOrder.get(a.domain) - pinnedOrder.get(b.domain)
    const aPrev = previousOrder.get(stableDomainId(a))
    const bPrev = previousOrder.get(stableDomainId(b))
    if (aPrev !== undefined && bPrev !== undefined) return aPrev - bPrev
    if (aPrev !== undefined) return -1
    if (bPrev !== undefined) return 1
    return 0
  })

  return groupedDomains
}
