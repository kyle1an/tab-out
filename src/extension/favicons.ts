/* ================================================================
   Favicon resolver

   Uses Chrome's internal favicon cache for ordinary page URLs while
   preserving data: favicons that carry extension-specific styling.
   ================================================================ */

import type { DashboardTab } from './types'

export function pickFavicon(tab?: Pick<DashboardTab, 'favIconUrl' | 'url'> | null): string {
  const fav = tab?.favIconUrl || ''
  if (fav.startsWith('data:')) return fav

  const url = tab?.url || ''
  if (!url) return ''
  if (!globalThis.chrome?.runtime?.getURL) return fav

  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'))
  faviconUrl.searchParams.set('pageUrl', url)
  faviconUrl.searchParams.set('size', '32')
  return faviconUrl.toString()
}

/**
 * pickTabFavicon(tab) — favicon for an OPEN tab. A live tab's own favIconUrl is
 * authoritative, but a suspended tab reports the suspender page's (empty or
 * greyed) icon, so recover the real page favicon from Chrome's cache by the
 * unwrapped url — mirroring how the title is recovered for suspended tabs.
 */
export function pickTabFavicon(tab: Pick<DashboardTab, 'favIconUrl' | 'url' | 'suspended'>): string {
  if (tab.suspended) return pickFavicon(tab)
  return tab.favIconUrl || ''
}
