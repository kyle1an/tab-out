import type { ChromeApi } from './chrome-api.js'

const NORMAL_WINDOW_CREATE_ATTEMPTS = 32
const NORMAL_WINDOW_FOCUS_ATTEMPTS = 2

async function normalBrowserWindowCandidates(chromeApi: ChromeApi): Promise<Array<chrome.windows.Window & { id: number }>> {
  const candidates: Array<chrome.windows.Window & { id: number }> = []
  const seen = new Set<number>()
  function add(window: chrome.windows.Window | null | undefined) {
    if (typeof window?.id !== 'number' || seen.has(window.id)) return
    seen.add(window.id)
    candidates.push(window as chrome.windows.Window & { id: number })
  }

  try {
    const lastFocusedNormal = await chromeApi.windows.getLastFocused({ windowTypes: ['normal'] })
    add(lastFocusedNormal)
  } catch {}

  try {
    const normalWindows = await chromeApi.windows.getAll({ windowTypes: ['normal'] })
    for (const window of normalWindows.filter((candidate) => candidate.focused)) add(window)
    for (const window of normalWindows) add(window)
  } catch {}
  return candidates.slice(0, NORMAL_WINDOW_CREATE_ATTEMPTS)
}

async function focusNormalBrowserWindow(chromeApi: ChromeApi, windowId: number): Promise<void> {
  for (let attempt = 0; attempt < NORMAL_WINDOW_FOCUS_ATTEMPTS; attempt += 1) {
    try {
      const focusedWindow = await chromeApi.windows.update(windowId, { focused: true })
      if (focusedWindow.focused) return
    } catch {}
  }
}

export async function createActiveTabInNormalWindow(
  chromeApi: ChromeApi,
  createProperties: Omit<chrome.tabs.CreateProperties, 'active' | 'windowId'>
): Promise<boolean> {
  const candidates = await normalBrowserWindowCandidates(chromeApi)
  for (const normalWindow of candidates) {
    try {
      await chromeApi.tabs.create({
        ...createProperties,
        windowId: normalWindow.id,
        active: true
      })
    } catch {
      continue
    }

    await focusNormalBrowserWindow(chromeApi, normalWindow.id)
    return true
  }

  return false
}
