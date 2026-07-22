/* ================================================================
   Live-tab matching — resolves a Dashboard Item Identity to the
   live open tabs it names (see CONTEXT.md).

   A tab matches by exact URL, or by effective URL after unwrapping
   a suspender wrapper on either side. Folded same-title chips match
   every variant's URL. Close, mute, and suspend all resolve through
   this one matching — pure: plain tab data in, matching tabs out.
   ================================================================ */

import { unwrapSuspenderUrl } from './suspension.js'

export type LiveTabMatchTarget = {
  tabUrl: string
  envs?: readonly { tabUrl: string }[] | null
}

export type LiveTabIdentityTarget = {
  tabId?: number | string
  tabUrl?: string
  url?: string
  rawUrl?: string
}

type MatchableTab = { url?: string; pendingUrl?: string }

/**
 * Chrome keeps the committed page in `url` while an uncommitted navigation is
 * exposed through `pendingUrl`. Mutation and activation identity must follow
 * that newest browser target so a stale dashboard action cannot operate on
 * the page a tab is already leaving.
 */
export function liveTabUrlForIdentity(tab: MatchableTab): string {
  return tab.pendingUrl || tab.url || ''
}

export function liveTabMatchesIdentity(tab: MatchableTab, target: LiveTabIdentityTarget): boolean {
  const openUrl = liveTabUrlForIdentity(tab)
  if (!openUrl) return false
  const targetUrls = [target.url, target.tabUrl, target.rawUrl].filter((url): url is string => !!url)
  if (targetUrls.length === 0) return false
  const openEffectiveUrl = unwrapSuspenderUrl(openUrl)
  return targetUrls.some((targetUrl) => openUrl === targetUrl || openEffectiveUrl === unwrapSuspenderUrl(targetUrl))
}

export function liveTabByValidatedId<T extends MatchableTab & { id?: number }>(
  tabs: readonly T[],
  target: LiveTabIdentityTarget
): T | null {
  if (typeof target.tabId !== 'number') return null
  const match = tabs.find((tab) => tab.id === target.tabId)
  return match && liveTabMatchesIdentity(match, target) ? match : null
}

export function liveTabsMatchingTarget<T extends MatchableTab>(tabs: readonly T[], { tabUrl, envs = null }: LiveTabMatchTarget): T[] {
  const foldedEnvs = Array.isArray(envs) ? envs : []
  const foldedTargetUrls = foldedEnvs.map((env) => env.tabUrl).filter(Boolean)
  if (foldedTargetUrls.length > 0) {
    const targetUrls = new Set(foldedTargetUrls)
    const targetEffectives = new Set(foldedTargetUrls.map((url) => unwrapSuspenderUrl(url)))
    return tabs.filter((tab) => {
      const openUrl = liveTabUrlForIdentity(tab)
      return !!openUrl && (targetUrls.has(openUrl) || targetEffectives.has(unwrapSuspenderUrl(openUrl)))
    })
  }

  if (!tabUrl) return []
  const targetEffective = unwrapSuspenderUrl(tabUrl)
  return tabs.filter((tab) => {
    const openUrl = liveTabUrlForIdentity(tab)
    return !!openUrl && (openUrl === tabUrl || unwrapSuspenderUrl(openUrl) === targetEffective)
  })
}
