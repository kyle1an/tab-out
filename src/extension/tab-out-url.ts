/* ================================================================
   Tab Out page URL helpers

   Single source of truth for "is this URL the Tab Out dashboard?",
   shared by dedup canonicalization (url-canonical.ts), the
   close-duplicates protection (tabs.ts), and startup detection
   (app.tsx). One definition guarantees the dedup identity and the
   "protect the active dashboard" logic agree on the dashboard base.

   The dashboard overrides the native new tab, but blank new tabs are
   kept as their own dedup identity, so:
     - isTabOutDashboardUrl EXCLUDES chrome://newtab/
     - isTabOutPageUrl (protection / startup) INCLUDES it
   ================================================================ */

const NEW_TAB_URL = 'chrome://newtab/'

/**
 * The Tab Out dashboard's canonical URL (no search/hash), or null when no
 * extension runtime id is available (e.g. a unit test without a mock).
 */
export function tabOutDashboardCanonicalUrl(runtimeId: string | null | undefined = globalThis.chrome?.runtime?.id): string | null {
  const id = runtimeId
  return id ? `chrome-extension://${id}/index.html` : null
}

/**
 * True when url is the Tab Out dashboard page (index.html), ignoring any
 * search params or hash. Does NOT match chrome://newtab/.
 */
export function isTabOutDashboardUrl(url?: string, runtimeId: string | null | undefined = globalThis.chrome?.runtime?.id): boolean {
  if (!url) return false
  const base = tabOutDashboardCanonicalUrl(runtimeId)
  if (!base) return false
  return url === base || url.startsWith(`${base}?`) || url.startsWith(`${base}#`)
}

/**
 * True when url is any Tab Out page: the dashboard (any search/hash) or a
 * native new tab. Used for active-tab protection and startup detection.
 */
export function isTabOutPageUrl(url?: string, runtimeId: string | null | undefined = globalThis.chrome?.runtime?.id): boolean {
  return url === NEW_TAB_URL || isTabOutDashboardUrl(url, runtimeId)
}
