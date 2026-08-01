import type { ChromeApi } from './chrome-api.js'

export type InactiveWindowKind = 'filter' | 'newPage'

export type TargetDisplayBounds = {
  height: number
  left: number
  top: number
  width: number
}

type WindowWithBounds = chrome.windows.Window & {
  height: number
  left: number
  top: number
  width: number
}

function isWindowWithBounds(window: chrome.windows.Window): window is WindowWithBounds {
  return Number.isFinite(window.left)
    && Number.isFinite(window.top)
    && Number.isFinite(window.width)
    && Number.isFinite(window.height)
    && (window.width ?? 0) > 0
    && (window.height ?? 0) > 0
}

function intersectionArea(
  bounds: TargetDisplayBounds,
  display: chrome.system.display.DisplayUnitInfo
): number {
  const left = Math.max(bounds.left, display.bounds.left)
  const top = Math.max(bounds.top, display.bounds.top)
  const right = Math.min(bounds.left + bounds.width, display.bounds.left + display.bounds.width)
  const bottom = Math.min(bounds.top + bounds.height, display.bounds.top + display.bounds.height)
  return Math.max(0, right - left) * Math.max(0, bottom - top)
}

function owningDisplay(
  window: WindowWithBounds,
  displays: chrome.system.display.DisplayUnitInfo[]
): chrome.system.display.DisplayUnitInfo | null {
  let owner: chrome.system.display.DisplayUnitInfo | null = null
  let ownerArea = 0

  for (const display of displays) {
    const area = intersectionArea(window, display)
    if (area > ownerArea) {
      owner = display
      ownerArea = area
    }
  }

  return owner
}

function targetDisplayForBounds(
  targetBounds: TargetDisplayBounds,
  displays: chrome.system.display.DisplayUnitInfo[]
): chrome.system.display.DisplayUnitInfo {
  const matches = displays.filter((display) => (
    targetBounds.left === display.bounds.left
    && targetBounds.top === display.bounds.top
    && targetBounds.width === display.bounds.width
    && targetBounds.height === display.bounds.height
  ))

  if (matches.length !== 1) {
    throw new Error('Native placement target bounds do not identify one enabled display')
  }

  return matches[0]!
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum))
}

function translatedBounds(
  sourceWindow: WindowWithBounds,
  sourceDisplay: chrome.system.display.DisplayUnitInfo,
  targetDisplay: chrome.system.display.DisplayUnitInfo
): Pick<chrome.windows.CreateData, 'height' | 'left' | 'top' | 'width'> {
  const width = Math.min(sourceWindow.width, targetDisplay.workArea.width)
  const height = Math.min(sourceWindow.height, targetDisplay.workArea.height)
  const offsetLeft = sourceWindow.left - sourceDisplay.workArea.left
  const offsetTop = sourceWindow.top - sourceDisplay.workArea.top
  const left = targetDisplay.workArea.left
    + clamp(offsetLeft, 0, targetDisplay.workArea.width - width)
  const top = targetDisplay.workArea.top
    + clamp(offsetTop, 0, targetDisplay.workArea.height - height)

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function workAreaBounds(
  display: chrome.system.display.DisplayUnitInfo
): Pick<chrome.windows.CreateData, 'height' | 'left' | 'top' | 'width'> {
  return {
    left: Math.round(display.workArea.left),
    top: Math.round(display.workArea.top),
    width: Math.round(display.workArea.width),
    height: Math.round(display.workArea.height)
  }
}

function filterFocusUrl(chromeApi: ChromeApi): string {
  return `chrome-extension://${chromeApi.runtime.id}/index.html?focusFilter=1`
}

export async function createInactiveWindow(
  kind: InactiveWindowKind,
  targetBounds: TargetDisplayBounds,
  chromeApi: ChromeApi = chrome
): Promise<void> {
  const displays = (await chromeApi.system.display.getInfo())
    .filter((display) => display.isEnabled !== false)
  const targetDisplay = targetDisplayForBounds(targetBounds, displays)

  const normalWindows = (await chromeApi.windows.getAll({ windowTypes: ['normal'] }))
    .filter((window) => window.state !== 'minimized')

  const windowsWithDisplays = normalWindows.map((window) => {
    if (!isWindowWithBounds(window)) {
      throw new Error('A normal Chrome window has unavailable display bounds')
    }
    const display = owningDisplay(window, displays)
    if (!display) {
      throw new Error('A normal Chrome window could not be matched to a display')
    }
    return { display, window }
  })
  const sourceWindows = windowsWithDisplays.filter(({ display }) => display.id !== targetDisplay.id)
  const source = sourceWindows.find(({ window }) => window.focused) ?? sourceWindows[0]

  const placement = source
    ? translatedBounds(source.window, source.display, targetDisplay)
    : workAreaBounds(targetDisplay)
  const createdWindow = await chromeApi.windows.create({
    type: 'normal',
    ...(kind === 'filter' ? { url: filterFocusUrl(chromeApi) } : {}),
    focused: false,
    ...placement
  })
  if (typeof createdWindow?.id !== 'number') {
    throw new Error('Chrome did not return the placed window identity')
  }
}
