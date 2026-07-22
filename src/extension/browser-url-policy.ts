const BROWSER_INTERNAL_PROTOCOLS = new Set([
  'about:',
  'brave:',
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:'
])

export function isBrowserInternalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  const separatorIndex = url.indexOf(':')
  if (separatorIndex < 0) return false
  return BROWSER_INTERNAL_PROTOCOLS.has(url.slice(0, separatorIndex + 1).toLowerCase())
}
