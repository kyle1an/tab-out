/* ================================================================
   Domain utilities

   • registrableDomain(hostname) — rolls subdomains up to their
     registrable ("eTLD+1") domain, so dev2ca.zenniaws.com and
     dev11us.zenniaws.com share a single "zenniaws.com" card.
   • subdomainPrefix(hostname, registrable) — the bit that was rolled
     away, used to label individual chips so the user can still tell
     dev2ca apart from dev11us at a glance. "www" is filtered as
     noise.

   Hardcoded subset of publicsuffix.org: user-space suffixes (github.io,
   vercel.app, …) and multi-label ccTLDs (co.uk, com.au, …) are treated
   as single eTLD units so user.github.io stays on its own card.
   ================================================================ */

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

const PUBLIC_SUFFIXES = new Set([
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
  // Multi-label ccTLDs: the "TLD" is already two labels, so the
  // registrable domain is three labels (example.co.uk, not co.uk).
  'co.uk',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.in',
  'com.au',
  'com.br',
  'com.cn',
  'com.mx',
  'ac.uk',
  'gov.uk',
  'edu.au',
]);

/**
 * registrableDomain(hostname) — the "eTLD+1" of hostname.
 *
 *   "dev2ca.zenniaws.com"       → "zenniaws.com"
 *   "www.example.co.uk"         → "example.co.uk"
 *   "user.github.io"            → "user.github.io"   (github.io is a public suffix)
 *   "localhost"                 → "localhost"
 *   "192.168.1.1"               → "192.168.1.1"      (IPs never roll up)
 *   ""                          → ""
 */
export function registrableDomain(hostname) {
  if (!hostname) return '';
  if (IPV4_RE.test(hostname)) return hostname;
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;

  const lastTwo = parts.slice(-2).join('.');
  if (PUBLIC_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * subdomainPrefix(hostname, registrable) — the part of `hostname`
 * above `registrable`. Returns "" when there's nothing meaningful
 * to show (no subdomain, or a lone "www").
 *
 *   ("dev2ca.zenniaws.com", "zenniaws.com") → "dev2ca"
 *   ("a.b.zenniaws.com",    "zenniaws.com") → "a.b"
 *   ("www.example.com",     "example.com")  → ""
 *   ("example.com",         "example.com")  → ""
 */
export function subdomainPrefix(hostname, registrable) {
  if (!hostname || !registrable || hostname === registrable) return '';
  const suffix = '.' + registrable;
  if (!hostname.endsWith(suffix)) return '';
  const prefix = hostname.slice(0, -suffix.length);
  if (prefix === 'www') return '';
  return prefix;
}
