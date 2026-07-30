import type { ChromeApi } from './chrome-api.js'
import { buildOpenTabDedupePlan } from '../open-tab-dedupe-plan.js'

type BadgePresentation = {
  color: string | null
  text: string
  title: string
}

export type BadgeRefreshService = {
  refresh: () => Promise<void>
}

/**
 * Counts tabs that the global dedupe action can safely close and updates the
 * extension toolbar badge. The count is close targets, not duplicate groups.
 */
function badgePresentationForTabs(tabs: chrome.tabs.Tab[], currentWindowId: number): BadgePresentation {
  const { closableCount: count } = buildOpenTabDedupePlan(tabs, currentWindowId)
  const text = count > 0 ? String(count) : ''
  const title = count > 0
    ? `Dedupe ${count} duplicate tab${count === 1 ? '' : 's'}`
    : 'Tab Out: no duplicates to dedupe'
  if (count === 0) return { color: null, text, title }
  if (count <= 10) return { color: '#3d7a4a', text, title }
  if (count <= 20) return { color: '#b8892e', text, title }
  return { color: '#b35a5a', text, title }
}

export function createBadgeRefreshService(chromeApi: ChromeApi = chrome): BadgeRefreshService {
  let inFlight: Promise<void> | null = null
  let requestedVersion = 0
  let appliedText: string | null = null
  let appliedColor: string | null = null
  let appliedTitle: string | null = null

  async function applyPresentation(presentation: BadgePresentation, version: number): Promise<void> {
    if (presentation.text !== appliedText) {
      try {
        await chromeApi.action.setBadgeText({ text: presentation.text })
        appliedText = presentation.text
      } catch {
        return
      }
    }

    if (version !== requestedVersion) return
    if (presentation.color != null && presentation.color !== appliedColor) {
      try {
        await chromeApi.action.setBadgeBackgroundColor({ color: presentation.color })
        appliedColor = presentation.color
      } catch {}
    }

    if (version !== requestedVersion || presentation.title === appliedTitle) return
    try {
      await chromeApi.action.setTitle({ title: presentation.title })
      appliedTitle = presentation.title
    } catch {}
  }

  async function runRefreshLoop(): Promise<void> {
    while (true) {
      const version = requestedVersion
      let presentation: BadgePresentation
      try {
        const [tabs, currentWindow] = await Promise.all([
          chromeApi.tabs.query({}),
          chromeApi.windows.getCurrent()
        ])
        if (currentWindow.id == null) throw new Error('Current window unavailable')
        presentation = badgePresentationForTabs(tabs, currentWindow.id)
      } catch {
        // A failed browser-state read is unknown, not a real zero-tab
        // snapshot. Preserve the last visible badge until a later event can
        // prove a replacement count.
        if (version === requestedVersion) return
        continue
      }

      if (version !== requestedVersion) continue
      await applyPresentation(presentation, version)
      if (version === requestedVersion) return
    }
  }

  async function clearInFlightWhenSettled(run: Promise<void>): Promise<void> {
    await run
    if (inFlight === run) inFlight = null
  }

  function refresh(): Promise<void> {
    requestedVersion += 1
    if (inFlight) return inFlight
    const run = runRefreshLoop()
    inFlight = run
    void clearInFlightWhenSettled(run)
    return run
  }

  return { refresh }
}
