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
 * pickTabFavicon(tab) — favicon for an OPEN tab. data: favicons pass through
 * verbatim (suspended tabs report faded data: icons, and data: URIs cannot be
 * blocked cross-origin). Remote favicons resolve through Chrome's local
 * favicon cache instead of hot-linking: sites that send
 * Cross-Origin-Resource-Policy: same-origin (claude.ai, notion.so, …) make the
 * browser discard their favicon bytes on extension pages, so the raw
 * favIconUrl only serves as a fallback where the favicon API is unavailable.
 */
export function pickTabFavicon(tab: Pick<DashboardTab, 'favIconUrl' | 'url' | 'suspended'>): string {
  const fav = tab.favIconUrl || ''
  if (fav.startsWith('data:')) return fav
  if (fav || tab.suspended) return faviconCacheUrl(tab.url || '') || fav
  return ''
}
