/* ================================================================
   Suspension — everything Tab Out knows about third-party tab
   suspenders (The Marvellous Suspender, The Great Suspender, etc.),
   behind one seam:

   • unwrapSuspenderUrl / unwrapSuspenderTitle — suspenders rewrite a
     tab's URL to chrome-extension://<id>/suspended.html#...&uri=<real>
     with the real URL in the fragment's `uri=` param. Because the
     real URL can itself contain `&` and `#`, it is always the LAST
     param — so we split on the literal `&uri=` marker (or leading
     `uri=`) instead of URLSearchParams, which would truncate at the
     first inner `&`.

   • isSuspended — THE predicate for "this item is a suspended tab".
     A raw URL differs from its unwrapped effective URL only when a
     suspender rewrote it; callers that already carry both URLs pass
     the pair, everyone else lets the default unwrap derive it.

   • Suspend Target memory + buildSuspendUrl — remembers which
     suspender the user runs (extension id + an observed
     suspended.html URL used as a format template) and rebuilds
     suspend URLs for new tabs. buildSuspendUrl is the inverse of the
     unwrap helpers: it keeps the observed suspender's fragment shape,
     swaps the `ttl=` (URL-encoded title) and trailing `uri=` (raw
     real URL, always last) values, and zeroes any `pos=` scroll
     offset, so the result round-trips through unwrapSuspenderUrl /
     unwrapSuspenderTitle.
   ================================================================ */

const SUSPEND_TARGET_STORAGE_KEY = 'tabOutSuspendTargetV1'
const SUSPEND_TARGET_STORAGE_WRITE_LOCK = 'tab-out:suspend-target-write'
const SUSPENDED_PATH_SUFFIX = '/suspended.html'

export function unwrapSuspenderUrl(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return url || ''
  const parsed = URL.parse(url)
  if (!parsed || !parsed.pathname.endsWith(SUSPENDED_PATH_SUFFIX)) return url
  const frag = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : ''
  const marker = '&uri='
  let encoded
  const idx = frag.indexOf(marker)
  if (idx >= 0) encoded = frag.slice(idx + marker.length)
  else if (frag.startsWith('uri=')) encoded = frag.slice(4)
  else return url
  try {
    return decodeURIComponent(encoded) || url
  } catch {
    return url
  }
}

/**
 * unwrapSuspenderTitle(url) — pull the `ttl=` param out of a suspender
 * fragment. The Marvellous/Great Suspender store the original page
 * title there, which is what we want to render on the chip — Chrome's
 * own `tab.title` for a not-yet-rendered suspended tab is unreliable
 * (sometimes the full suspender URL, sometimes empty, sometimes a
 * stale cached value). Returns '' when the URL isn't a suspender URL
 * or when no `ttl=` fragment is present.
 *
 * Unlike `uri=` which is always the LAST fragment param (since the
 * real URL can itself contain `&`), `ttl=` values are URL-encoded so
 * any literal `&` in the title shows up as `%26` — safe to split at
 * the next raw `&`.
 */
export function unwrapSuspenderTitle(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return ''
  const parsed = URL.parse(url)
  if (!parsed || !parsed.pathname.endsWith(SUSPENDED_PATH_SUFFIX)) return ''
  const frag = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : ''
  const match = frag.match(/(?:^|&)ttl=([^&]*)/)
  if (!match) return ''
  try {
    return decodeURIComponent(match[1] || '') || ''
  } catch {
    return ''
  }
}

/**
 * isSuspended(rawUrl, effectiveUrl) — true when a suspender rewrote
 * this item's URL. `rawUrl` is Chrome's actual tab URL; `effectiveUrl`
 * is the unwrapped real page URL and defaults to unwrapping rawUrl,
 * so callers that already carry both (normalized tabs, history
 * entries, chip envs) pass the pair and skip the re-unwrap.
 */
export function isSuspended(rawUrl: string | undefined, effectiveUrl = unwrapSuspenderUrl(rawUrl)): boolean {
  return !!rawUrl && rawUrl !== effectiveUrl
}

export interface SuspendTarget {
  id: string
  template: string
}

interface StoredSuspendTarget extends SuspendTarget {
  observedAt: number
}

interface PendingSuspendTargetSave {
  target: SuspendTarget
  observedAt: number
}

export type SuspendTargetStoreAdapter = {
  now: () => number
  read: () => Promise<unknown>
  runExclusive: <Value>(task: () => Promise<Value>) => Promise<Value>
  write: (value: StoredSuspendTarget) => Promise<void>
}

export type SuspendTargetStore = {
  get: () => Promise<SuspendTarget | null>
  rememberFromTabs: (tabs: readonly { suspended?: boolean; rawUrl?: string }[]) => void
}

export function extractSuspenderId(rawUrl: string | undefined): string | null {
  if (!rawUrl || !rawUrl.startsWith('chrome-extension://')) return null
  const parsed = URL.parse(rawUrl)
  if (!parsed || !parsed.pathname.endsWith(SUSPENDED_PATH_SUFFIX)) return null
  return parsed.hostname || null
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

  // The template's pos= is the observed tab's own scroll offset (Great/
  // Marvellous Suspender convention) — zero it so a freshly suspended tab
  // restores at the top instead of at another page's position.
  head = head.replace(/(^|&)pos=[^&]*/, '$1pos=0')

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

function storedSuspendTargetObservedAt(value: unknown): number | null {
  if (!isSuspendTarget(value)) return null
  const observedAt = (value as Partial<StoredSuspendTarget>).observedAt
  return typeof observedAt === 'number' && Number.isFinite(observedAt) ? observedAt : null
}

function nextSuspendTargetObservationAt(): number {
  if (typeof performance !== 'undefined') {
    const highResolutionNow = performance.timeOrigin + performance.now()
    if (Number.isFinite(highResolutionNow)) return highResolutionNow
  }
  return Date.now()
}

export function createSuspendTargetStore(adapter: SuspendTargetStoreAdapter): SuspendTargetStore {
  let cachedTarget: SuspendTarget | null = null
  let cachedTargetRevision = 0

  async function save(saveRequest: PendingSuspendTargetSave): Promise<void> {
    const storedTarget: StoredSuspendTarget = {
      ...saveRequest.target,
      observedAt: saveRequest.observedAt
    }

    try {
      // Request the shared lock at observation time. Deferring this request
      // behind a module-local queue can reverse equal-time observations from
      // separate extension contexts.
      await adapter.runExclusive(async () => {
        let existingValue: unknown
        try {
          existingValue = await adapter.read()
        } catch {
          // Without the current generation it is unsafe to replace a value that
          // may have been written by a newer page or service-worker context.
          return
        }

        const existingObservedAt = storedSuspendTargetObservedAt(existingValue)
        if (existingObservedAt !== null && existingObservedAt > saveRequest.observedAt) return
        await adapter.write(storedTarget)
      })
    } catch {}
  }

  async function get(): Promise<SuspendTarget | null> {
    if (cachedTarget) return cachedTarget
    const revisionBeforeLoad = cachedTargetRevision
    let storedTarget: SuspendTarget | null = null
    try {
      const value = await adapter.read()
      if (isSuspendTarget(value)) storedTarget = { id: value.id, template: value.template }
    } catch {}
    // Live tab collection is synchronous and authoritative. Do not let a
    // storage read that started earlier replace a target learned while it waited.
    if (cachedTarget || cachedTargetRevision !== revisionBeforeLoad) return cachedTarget
    cachedTarget = storedTarget
    return cachedTarget
  }

  function rememberFromTabs(
    tabs: readonly { suspended?: boolean; rawUrl?: string }[]
  ): void {
    for (const tab of tabs) {
      if (!tab.suspended || !tab.rawUrl) continue
      const id = extractSuspenderId(tab.rawUrl)
      if (!id) continue
      if (cachedTarget?.id === id && cachedTarget.template === tab.rawUrl) return
      const idChanged = cachedTarget?.id !== id
      cachedTargetRevision += 1
      cachedTarget = { id, template: tab.rawUrl }
      if (idChanged) {
        void save({
          target: cachedTarget,
          observedAt: adapter.now()
        })
      }
      return
    }
  }

  return { get, rememberFromTabs }
}

function suspendTargetStorageArea(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('Suspend target storage is unavailable')
  }
  return chrome.storage.local
}

async function readStoredSuspendTarget(): Promise<unknown> {
  const stored = await suspendTargetStorageArea().get(SUSPEND_TARGET_STORAGE_KEY)
  return stored[SUSPEND_TARGET_STORAGE_KEY]
}

async function writeStoredSuspendTarget(value: StoredSuspendTarget): Promise<void> {
  await suspendTargetStorageArea().set({ [SUSPEND_TARGET_STORAGE_KEY]: value })
}

const suspendTargetStore = createSuspendTargetStore({
  now: nextSuspendTargetObservationAt,
  read: readStoredSuspendTarget,
  runExclusive: <Value>(task: () => Promise<Value>) => (
    navigator.locks.request(SUSPEND_TARGET_STORAGE_WRITE_LOCK, task)
  ),
  write: writeStoredSuspendTarget
})

export function getSuspendTarget(): Promise<SuspendTarget | null> {
  return suspendTargetStore.get()
}

/**
 * Scan normalized open tabs for the first recognizable suspended page and cache
 * it as the target. Persist only when the suspender id changes; a same-id
 * template refresh updates memory without another storage write.
 */
export function rememberSuspendTargetFromTabs(
  tabs: readonly { suspended?: boolean; rawUrl?: string }[]
): void {
  suspendTargetStore.rememberFromTabs(tabs)
}
