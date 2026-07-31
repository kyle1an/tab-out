import type { ChromeApi } from './chrome-api.js'

const DISPLAY_POSITIONS = [1, 2] as const

type InactiveWindowKind = 'filter' | 'newPage'
type InactiveWindowDisplayPosition = typeof DISPLAY_POSITIONS[number]

export const INACTIVE_WINDOW_COMMANDS = {
  filter: {
    1: 'create-inactive-filter-window-display-1',
    2: 'create-inactive-filter-window-display-2'
  },
  newPage: {
    1: 'create-inactive-new-page-window-display-1',
    2: 'create-inactive-new-page-window-display-2'
  }
} as const

type InactiveWindowCommandTarget = {
  kind: InactiveWindowKind
  displayPosition: InactiveWindowDisplayPosition
}

export function inactiveWindowCommandTarget(command: string): InactiveWindowCommandTarget | null {
  for (const kind of ['filter', 'newPage'] as const) {
    for (const displayPosition of DISPLAY_POSITIONS) {
      if (INACTIVE_WINDOW_COMMANDS[kind][displayPosition] === command) {
        return { kind, displayPosition }
      }
    }
  }

  return null
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
  window: WindowWithBounds,
  display: chrome.system.display.DisplayUnitInfo
): number {
  const left = Math.max(window.left, display.bounds.left)
  const top = Math.max(window.top, display.bounds.top)
  const right = Math.min(window.left + window.width, display.bounds.left + display.bounds.width)
  const bottom = Math.min(window.top + window.height, display.bounds.top + display.bounds.height)
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

function displaysByDesktopPosition(
  displays: chrome.system.display.DisplayUnitInfo[]
): chrome.system.display.DisplayUnitInfo[] {
  return displays.slice().sort((left, right) => (
    left.bounds.top - right.bounds.top
    || left.bounds.left - right.bounds.left
    || left.id.localeCompare(right.id)
  ))
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
  displayPosition: InactiveWindowDisplayPosition,
  chromeApi: ChromeApi = chrome
): Promise<void> {
  const displays = displaysByDesktopPosition(
    (await chromeApi.system.display.getInfo()).filter((display) => display.isEnabled !== false)
  )
  if (displays.length < 1 || displays.length > DISPLAY_POSITIONS.length) {
    throw new Error('Direct placement requires one or two enabled displays')
  }

  const targetDisplay = displays[displayPosition - 1]
  if (!targetDisplay) {
    throw new Error(`Direct placement display position ${displayPosition} is unavailable`)
  }

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

  const createData: chrome.windows.CreateData = {
    type: 'normal',
    ...(kind === 'filter' ? { url: filterFocusUrl(chromeApi) } : {}),
    focused: false,
    ...(source
      ? translatedBounds(source.window, source.display, targetDisplay)
      : workAreaBounds(targetDisplay))
  }
  await chromeApi.windows.create(createData)
}
