import type { ChromeApi } from './chrome-api.js'
import { isBrowserInternalUrl } from '../browser-url-policy.js'

type BadgePresentation = {
  color: string | null
  text: string
}

export type BadgeRefreshService = {
  refresh: () => Promise<void>
}

/**
 * Counts open real-web tabs and updates the extension toolbar badge.
 * "Real" tabs = not browser internals, extension pages, or about:blank.
 */
function badgePresentationForTabs(tabs: chrome.tabs.Tab[]): BadgePresentation {
  const count = tabs.filter((tab) => !isBrowserInternalUrl(tab.url)).length
  const text = count > 0 ? String(count) : ''
  if (count === 0) return { color: null, text }
  if (count <= 10) return { color: '#3d7a4a', text }
  if (count <= 20) return { color: '#b8892e', text }
  return { color: '#b35a5a', text }
}

export function createBadgeRefreshService(chromeApi: ChromeApi = chrome): BadgeRefreshService {
  let inFlight: Promise<void> | null = null
  let requestedVersion = 0
  let appliedText: string | null = null
  let appliedColor: string | null = null

  async function applyPresentation(presentation: BadgePresentation, version: number): Promise<void> {
    if (presentation.text !== appliedText) {
      try {
        await chromeApi.action.setBadgeText({ text: presentation.text })
        appliedText = presentation.text
      } catch {
        return
      }
    }

    if (version !== requestedVersion || presentation.color == null || presentation.color === appliedColor) return
    try {
      await chromeApi.action.setBadgeBackgroundColor({ color: presentation.color })
      appliedColor = presentation.color
    } catch {}
  }

  async function runRefreshLoop(): Promise<void> {
    while (true) {
      const version = requestedVersion
      let presentation: BadgePresentation
      try {
        presentation = badgePresentationForTabs(await chromeApi.tabs.query({}))
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

export async function updateBadge(chromeApi: ChromeApi = chrome): Promise<void> {
  await createBadgeRefreshService(chromeApi).refresh()
}
