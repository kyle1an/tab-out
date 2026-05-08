import type { DomainGroup } from './types'

export function domainCardId(domain: string): string {
  return 'domain-' + domain.replace(/[^a-z0-9]/g, '-')
}

export function domainGroupCardId(group: Pick<DomainGroup, 'domain'>): string {
  return domainCardId(group.domain)
}
