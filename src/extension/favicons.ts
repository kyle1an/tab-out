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
 * pickTabFavicon(tab) — favicon for an OPEN tab. Chrome's tab.favIconUrl is
 * the source of truth for the browser-visible favicon, including suspended
 * tabs. Suspended tabs only fall back to the unwrapped page's favicon cache
 * when Chrome has no favicon URL yet.
 */
export function pickTabFavicon(tab: Pick<DashboardTab, 'favIconUrl' | 'url' | 'suspended'>): string {
  if (tab.favIconUrl) return tab.favIconUrl
  if (tab.suspended) return faviconCacheUrl(tab.url || '')
  return tab.favIconUrl || ''
}
