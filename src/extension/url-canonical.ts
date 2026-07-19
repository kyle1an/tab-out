/* ================================================================
   URL canonicalization for dedup

   canonicalDedupeKey(url) maps a page URL to the key Tab Out uses to
   decide whether two tabs are "the same page" for duplicate counting,
   chip grouping, and the close-duplicates action.

   Per-site rules (mirroring path-groups.ts) strip redundant/noise
   params and fragments so URLs that render the identical page share a
   key.

   SAFE BY DEFAULT: when no rule matches, a rule returns null, or
   anything throws, the ORIGINAL url is returned — i.e. today's exact
   string match. A missing/buggy rule can only ever under-dedupe.

   Callers pass an already-suspender-unwrapped URL (same convention as
   path-groups.ts).
   ================================================================ */

import { isTabOutDashboardUrl, tabOutDashboardCanonicalUrl } from './tab-out-url.js'
import type { UrlCanonicalizerRule } from './types'

const BUILT_IN_CANONICALIZERS: UrlCanonicalizerRule[] = [
  // Atlassian Jira: /browse/{ISSUE}-{N} → dedup by issue + focused comment.
  // Drops sourceType, page, and the redundant #comment-N hash. The focused
  // comment is taken from focusedCommentId or the #comment-N hash, whichever
  // is present (focusedCommentId wins). Distinct purpose from the /browse
  // path-GROUP rule (which clusters by project); both share the host and the
  // first non-null result wins.
  {
    hostnameEndsWith: '.atlassian.net',
    canonicalize: (u: URL) => {
      const m = u.pathname.match(/^\/browse\/([A-Z][A-Z0-9]+-\d+)/)
      if (!m) return null
      const comment = u.searchParams.get('focusedCommentId') || (u.hash.match(/^#comment-(\d+)$/)?.[1] ?? '')
      const base = `${u.origin}/browse/${m[1]}`
      return comment ? `${base}?focusedCommentId=${comment}` : base
    }
  }
]

export function canonicalDedupeKey(url: string): string {
  if (!url) return url

  // Tab Out's own dashboard: collapse every filter/search/hash variant to a
  // single identity so redundant dashboards are counted + closable as dupes.
  // chrome://newtab/ is intentionally left as-is (see tab-out-url.ts).
  if (isTabOutDashboardUrl(url)) return tabOutDashboardCanonicalUrl() ?? url

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  for (const rule of BUILT_IN_CANONICALIZERS) {
    const hostMatch = rule.hostname
      ? parsed.hostname === rule.hostname
      : rule.hostnameEndsWith
        ? parsed.hostname.endsWith(rule.hostnameEndsWith)
        : false
    if (!hostMatch) continue
    try {
      const key = rule.canonicalize(parsed)
      if (key) return key
    } catch {
      // Adapter threw on an unexpected URL shape — fall through to exact.
    }
  }

  return url
}
