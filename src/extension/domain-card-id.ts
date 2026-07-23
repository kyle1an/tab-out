import type { DomainGroup } from './types'

export function domainCardId(domain: string): string {
  // Keep the DOM-friendly prefix while preserving the domain as an injective
  // identity. Replacing punctuation with one delimiter made unrelated hosts
  // such as `foo_bar.test` and `foo-bar.test` share React keys and order maps.
  return `domain-${encodeURIComponent(domain)}`
}

export function domainGroupCardId(group: Pick<DomainGroup, 'domain'>): string {
  return domainCardId(group.domain)
}
