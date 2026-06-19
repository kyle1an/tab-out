/* ================================================================
   Domain card pins

   User-facing domain-card pins are separate from Chrome's tab.pinned
   flag. They only affect dashboard card ordering.
   ================================================================ */

export const DOMAIN_PIN_STORAGE_KEY = 'tabOutPinnedDomainsV1'

const PINNABLE_SYSTEM_DOMAINS = new Set(['__tab-out__', '__standalone-apps__'])

export type PinnedDomainReorderPlacement =
  | { direction: 'previous' | 'next' }
  | { targetDomain: string; position: 'before' | 'after' }

export function isPinnableDomain(domain: unknown): domain is string {
  return !!domain && typeof domain === 'string' && (!domain.startsWith('__') || PINNABLE_SYSTEM_DOMAINS.has(domain))
}

export function normalizePinnedDomains(domains: unknown = []): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const domain of Array.isArray(domains) ? domains : []) {
    if (!isPinnableDomain(domain) || seen.has(domain)) continue
    seen.add(domain)
    normalized.push(domain)
  }
  return normalized
}

export function togglePinnedDomainInList(domains: unknown = [], domain: unknown): string[] {
  const normalized = normalizePinnedDomains(domains)
  if (!isPinnableDomain(domain)) return normalized
  return normalized.includes(domain) ? normalized.filter((d) => d !== domain) : [...normalized, domain]
}

export function reorderPinnedDomainInList(
  domains: unknown = [],
  domain: unknown,
  targetDomain: unknown,
  position: 'before' | 'after' = 'before'
): string[] {
  const normalized = normalizePinnedDomains(domains)
  if (!isPinnableDomain(domain) || !isPinnableDomain(targetDomain) || domain === targetDomain) return normalized

  const fromIndex = normalized.indexOf(domain)
  const targetIndex = normalized.indexOf(targetDomain)
  if (fromIndex === -1 || targetIndex === -1) return normalized

  const next = normalized.filter((candidate) => candidate !== domain)
  const adjustedTargetIndex = next.indexOf(targetDomain)
  const insertIndex = position === 'after' ? adjustedTargetIndex + 1 : adjustedTargetIndex
  next.splice(insertIndex, 0, domain)
  return next
}

export function movePinnedDomainInList(domains: unknown = [], domain: unknown, direction: 'previous' | 'next'): string[] {
  const normalized = normalizePinnedDomains(domains)
  if (!isPinnableDomain(domain)) return normalized

  const fromIndex = normalized.indexOf(domain)
  if (fromIndex === -1) return normalized

  const targetIndex = direction === 'previous' ? fromIndex - 1 : fromIndex + 1
  if (targetIndex < 0 || targetIndex >= normalized.length) return normalized

  const next = normalized.slice()
  const [moved] = next.splice(fromIndex, 1)
  if (!moved) return normalized
  next.splice(targetIndex, 0, moved)
  return next
}

export async function loadPinnedDomains(): Promise<string[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return []
  try {
    const stored = await chrome.storage.local.get(DOMAIN_PIN_STORAGE_KEY)
    return normalizePinnedDomains(stored[DOMAIN_PIN_STORAGE_KEY])
  } catch {
    return []
  }
}

export async function savePinnedDomains(domains: unknown = []): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  await chrome.storage.local.set({
    [DOMAIN_PIN_STORAGE_KEY]: normalizePinnedDomains(domains)
  })
}
