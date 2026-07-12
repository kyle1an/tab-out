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

type MatchableTab = { url?: string }

export function liveTabsMatchingTarget<T extends MatchableTab>(tabs: readonly T[], { tabUrl, envs = null }: LiveTabMatchTarget): T[] {
  const foldedEnvs = Array.isArray(envs) ? envs : []
  if (foldedEnvs.length > 0) {
    const targetUrls = new Set(foldedEnvs.map((env) => env.tabUrl))
    const targetEffectives = new Set(foldedEnvs.map((env) => unwrapSuspenderUrl(env.tabUrl)))
    return tabs.filter((tab) => {
      const openUrl = tab.url || ''
      return targetUrls.has(openUrl) || targetEffectives.has(unwrapSuspenderUrl(openUrl))
    })
  }

  const targetEffective = unwrapSuspenderUrl(tabUrl)
  return tabs.filter((tab) => {
    const openUrl = tab.url || ''
    return openUrl === tabUrl || unwrapSuspenderUrl(openUrl) === targetEffective
  })
}
