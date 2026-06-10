/* ================================================================
   Suspend target — remembers which third-party suspender the user
   runs (extension id + an observed suspended.html URL used as a
   format template) and rebuilds suspend URLs for new tabs.

   buildSuspendUrl is the inverse of suspender.ts's unwrap helpers:
   it keeps the observed suspender's fragment shape and only swaps
   the `ttl=` (URL-encoded title) and trailing `uri=` (raw real URL,
   always last) values, so the result round-trips through
   unwrapSuspenderUrl / unwrapSuspenderTitle.
   ================================================================ */

export const SUSPEND_TARGET_STORAGE_KEY = 'tabOutSuspendTargetV1'
const SUSPENDED_PATH_SUFFIX = '/suspended.html'

export interface SuspendTarget {
  id: string
  template: string
}

let cachedTarget: SuspendTarget | null = null

export function extractSuspenderId(rawUrl: string | undefined): string | null {
  if (!rawUrl || !rawUrl.startsWith('chrome-extension://')) return null
  try {
    const parsed = new URL(rawUrl)
    if (!parsed.pathname.endsWith(SUSPENDED_PATH_SUFFIX)) return null
    return parsed.hostname || null
  } catch {
    return null
  }
}

export function buildSuspendUrl(target: SuspendTarget, opts: { url: string; title: string }): string {
  const { url, title } = opts
  const hashIndex = target.template.indexOf('#')
  const base = hashIndex >= 0 ? target.template.slice(0, hashIndex) : target.template
  const frag = hashIndex >= 0 ? target.template.slice(hashIndex + 1) : ''

  // Drop everything from the `uri=` marker onward (it is always last); we re-append it.
  const marker = '&uri='
  const markerIndex = frag.indexOf(marker)
  let head = frag
  if (markerIndex >= 0) head = frag.slice(0, markerIndex)
  else if (frag.startsWith('uri=')) head = ''

  const encodedTitle = encodeURIComponent(title)
  let titledHead: string
  if (/(^|&)ttl=/.test(head)) {
    titledHead = head.replace(/(^|&)ttl=[^&]*/, (_match, prefix: string) => `${prefix}ttl=${encodedTitle}`)
  } else if (head) {
    titledHead = `${head}&ttl=${encodedTitle}`
  } else {
    titledHead = `ttl=${encodedTitle}`
  }

  return `${base}#${titledHead}&uri=${url}`
}

function isSuspendTarget(value: unknown): value is SuspendTarget {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<SuspendTarget>
  return typeof candidate.id === 'string' && candidate.id !== ''
    && typeof candidate.template === 'string' && candidate.template !== ''
}

export async function loadSuspendTarget(): Promise<SuspendTarget | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null
  try {
    const stored = await chrome.storage.local.get(SUSPEND_TARGET_STORAGE_KEY)
    const value = stored[SUSPEND_TARGET_STORAGE_KEY]
    return isSuspendTarget(value) ? value : null
  } catch {
    return null
  }
}

async function saveSuspendTarget(target: SuspendTarget): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return
  try {
    await chrome.storage.local.set({ [SUSPEND_TARGET_STORAGE_KEY]: target })
  } catch {}
}

export async function getSuspendTarget(): Promise<SuspendTarget | null> {
  if (cachedTarget) return cachedTarget
  cachedTarget = await loadSuspendTarget()
  return cachedTarget
}

/**
 * rememberSuspendTargetFromTabs — scan normalized open tabs for the first
 * suspended one whose rawUrl is a recognizable suspended.html URL, and cache +
 * persist it as the suspend target. Cheap and idempotent: re-observing the same
 * URL is a no-op. Called on every fetchOpenTabs so the target stays current.
 */
export function rememberSuspendTargetFromTabs(
  tabs: readonly { suspended?: boolean; rawUrl?: string }[]
): void {
  for (const tab of tabs) {
    if (!tab.suspended || !tab.rawUrl) continue
    const id = extractSuspenderId(tab.rawUrl)
    if (!id) continue
    if (cachedTarget && cachedTarget.id === id && cachedTarget.template === tab.rawUrl) return
    cachedTarget = { id, template: tab.rawUrl }
    void saveSuspendTarget(cachedTarget)
    return
  }
}
