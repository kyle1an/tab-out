/* ================================================================
   Domain utilities

   • registrableDomain(hostname) — rolls subdomains up to their
     registrable ("eTLD+1") domain, so dev1.example.com and
     dev2.example.com share a single "example.com" card.
   • subdomainPrefix(hostname, registrable) — the bit that was rolled
     away, used to label individual chips so the user can still tell
     dev2ca apart from dev11us at a glance. "www" is filtered as
     noise.

   The complete Public Suffix List supplies registry and private suffixes.
   A short product override list retains user-space providers that intentionally
   isolate customer subdomains regardless of upstream PSL classification changes.
   ================================================================ */

import { getDomain, getPublicSuffix } from 'tldts'

const USER_SPACE_SUFFIX_OVERRIDES = new Set([
  // User-space subdomains: each subdomain is an independent site, so
  // rolling up would merge unrelated projects. Keep intact.
  'github.io',
  'gitlab.io',
  'bitbucket.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'netlify.com',
  'herokuapp.com',
  'firebaseapp.com',
  'web.app',
  'appspot.com',
  'azurewebsites.net',
  'ngrok.io',
  'ngrok-free.app',
  'loca.lt',
  'surge.sh',
  'blogspot.com',
  'wordpress.com',
  'tumblr.com',
])

// Callers already pass a normalized hostname extracted by the platform URL
// parser. Skip tldts' duplicate URL-host extraction on every grouping pass.
const PUBLIC_SUFFIX_OPTIONS = { allowPrivateDomains: true, extractHostname: false } as const

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.+$/, '')
}

function overriddenUserSpaceSuffix(hostname: string): string | null {
  let match: string | null = null
  for (const suffix of USER_SPACE_SUFFIX_OVERRIDES) {
    if (hostname !== suffix && !hostname.endsWith(`.${suffix}`)) continue
    if (!match || suffix.length > match.length) match = suffix
  }
  return match
}

/**
 * registrableDomain(hostname) — the "eTLD+1" of hostname.
 *
 *   "dev1.example.com"       → "example.com"
 *   "www.example.co.uk"         → "example.co.uk"
 *   "user.github.io"            → "user.github.io"   (github.io is a public suffix)
 *   "localhost"                 → "localhost"
 *   "192.168.1.1"               → "192.168.1.1"      (IPs never roll up)
 *   ""                          → ""
 */
export function registrableDomain(hostname: string): string {
  const normalized = normalizeHostname(hostname)
  if (!normalized) return ''
  const override = overriddenUserSpaceSuffix(normalized)
  if (override && normalized !== override) {
    const prefix = normalized.slice(0, -(override.length + 1))
    const registrableLabel = prefix.split('.').at(-1)
    if (registrableLabel) return `${registrableLabel}.${override}`
  }
  return getDomain(normalized, PUBLIC_SUFFIX_OPTIONS) || normalized
}

export function splitDomainForDisplay(domain: string): { name: string, suffix: string } {
  const normalized = normalizeHostname(domain)
  if (!normalized) return { name: normalized, suffix: '' }
  const matchedOverride = overriddenUserSpaceSuffix(normalized)
  const override = matchedOverride && normalized !== matchedOverride ? matchedOverride : null
  const suffix = override || getPublicSuffix(normalized, PUBLIC_SUFFIX_OPTIONS)
  if (!suffix || suffix === normalized) return { name: normalized, suffix: '' }
  const suffixWithDot = `.${suffix}`
  if (!normalized.endsWith(suffixWithDot)) return { name: normalized, suffix: '' }

  const name = normalized.slice(0, -suffixWithDot.length)
  if (!name) return { name: normalized, suffix: '' }
  return { name, suffix: suffixWithDot }
}

/**
 * subdomainPrefix(hostname, registrable) — the part of `hostname`
 * above `registrable`. Returns "" when there's nothing meaningful
 * to show (no subdomain, or a lone "www").
 *
 *   ("dev1.example.com", "example.com") → "dev1"
 *   ("a.b.example.com",    "example.com") → "a.b"
 *   ("www.example.com",     "example.com")  → ""
 *   ("example.com",         "example.com")  → ""
 */
export function subdomainPrefix(hostname: string, registrable: string): string {
  const normalizedHostname = normalizeHostname(hostname)
  const normalizedRegistrable = normalizeHostname(registrable)
  if (!normalizedHostname || !normalizedRegistrable || normalizedHostname === normalizedRegistrable) return ''
  const suffix = '.' + normalizedRegistrable
  if (!normalizedHostname.endsWith(suffix)) return ''
  const prefix = normalizedHostname.slice(0, -suffix.length)
  if (prefix === 'www') return ''
  return prefix
}
