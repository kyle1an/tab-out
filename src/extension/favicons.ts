/* ================================================================
   Favicon resolver

   Uses Chrome's internal favicon cache for ordinary page URLs while
   preserving data: favicons that carry extension-specific styling.
   ================================================================ */

import type { DashboardTab } from './types'

function faviconCacheUrl(url: string): string {
  if (!url || !globalThis.chrome?.runtime?.getURL) return ''
  const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'))
  faviconUrl.searchParams.set('pageUrl', url)
  faviconUrl.searchParams.set('size', '32')
  return faviconUrl.toString()
}

export function pickFavicon(tab?: Pick<DashboardTab, 'favIconUrl' | 'url'> | null): string {
  const fav = tab?.favIconUrl || ''
  if (fav.startsWith('data:')) return fav

  const url = tab?.url || ''
  if (!url) return ''
  return faviconCacheUrl(url) || fav
}

/**
 * pickTabFavicon(tab) — favicon for an OPEN tab. A live tab's own favIconUrl is
 * authoritative, but a suspended tab reports the suspender page's icon — a
 * faded data: copy of the original (or the suspender's default) — so the cache
 * lookup by the unwrapped url must win over the tab's own favIconUrl. The
 * data: short-circuit in pickFavicon would keep the faded copy, hence the
 * direct cache lookup here; the tab's own icon is only the no-API fallback.
 */
export function pickTabFavicon(tab: Pick<DashboardTab, 'favIconUrl' | 'url' | 'suspended'>): string {
  if (tab.suspended) return faviconCacheUrl(tab.url || '') || tab.favIconUrl || ''
  return tab.favIconUrl || ''
}
