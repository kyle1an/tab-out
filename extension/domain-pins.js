/* ================================================================
   Domain card pins

   User-facing domain-card pins are separate from Chrome's tab.pinned
   flag. They only affect dashboard card ordering.
   ================================================================ */

export const DOMAIN_PIN_STORAGE_KEY = 'tabOutPinnedDomainsV1'

export function isPinnableDomain(domain) {
  return !!domain && typeof domain === 'string' && !domain.startsWith('__')
}

export function normalizePinnedDomains(domains = []) {
  const seen = new Set()
  const normalized = []
  for (const domain of domains) {
    if (!isPinnableDomain(domain) || seen.has(domain)) continue
    seen.add(domain)
    normalized.push(domain)
  }
  return normalized
}

export function togglePinnedDomainInList(domains = [], domain) {
  const normalized = normalizePinnedDomains(domains)
  if (!isPinnableDomain(domain)) return normalized
  return normalized.includes(domain) ? normalized.filter((d) => d !== domain) : [...normalized, domain]
}

export async function loadPinnedDomains() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
  try {
    const stored = await chrome.storage.local.get(DOMAIN_PIN_STORAGE_KEY)
    return normalizePinnedDomains(stored[DOMAIN_PIN_STORAGE_KEY])
  } catch {
    return []
  }
}

export async function savePinnedDomains(domains = []) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.set({
    [DOMAIN_PIN_STORAGE_KEY]: normalizePinnedDomains(domains)
  })
}
