const GITHUB_RESERVED_ROUTE_OWNERS = new Set([
  'orgs',
  'settings',
  'notifications',
  'marketplace',
  'explore',
  'pulls',
  'issues',
  'search',
  'login',
  'join',
  'about',
  'new',
  'topics',
  'trending',
  'collections',
  'events',
  'sponsors',
  'codespaces',
  'account',
])

export function isGitHubRepositoryOwnerPathSegment(segment: string): boolean {
  return !!segment && !GITHUB_RESERVED_ROUTE_OWNERS.has(segment)
}

export function isGitHubRepositoryRootPath(pathname: string): boolean {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
  return !!match?.[1] && isGitHubRepositoryOwnerPathSegment(match[1])
}
