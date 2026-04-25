/* ================================================================
   Favicon resolver

   Uses Chrome's internal favicon cache for ordinary page URLs while
   preserving data: favicons that carry extension-specific styling.
   ================================================================ */

/**
 * @param {Pick<import('./types').DashboardTab, 'favIconUrl' | 'url'>} tab
 * @returns {string}
 */
export function pickFavicon(tab) {
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
