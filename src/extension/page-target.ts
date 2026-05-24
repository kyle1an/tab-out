export type PageTarget = {
  tabUrl?: string
  url?: string
  rawUrl?: string
}

export function pageTargetUrl(target: PageTarget | null | undefined): string {
  return target?.tabUrl || target?.url || ''
}

export function pageTargetRawUrl(target: PageTarget | null | undefined): string {
  return target?.rawUrl || pageTargetUrl(target)
}

export function pageTargetMatchUrls(target: PageTarget | null | undefined): string[] {
  return [...new Set([pageTargetUrl(target), pageTargetRawUrl(target)].filter(Boolean))]
}

export function pageTargetMatchesHover(
  target: PageTarget | null | undefined,
  activeHoverUrl: string,
  activeHoverUrls: readonly string[] = []
): boolean {
  return pageTargetMatchUrls(target).some((url) => url === activeHoverUrl || activeHoverUrls.includes(url))
}
