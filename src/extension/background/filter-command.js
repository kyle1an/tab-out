export const OPEN_FILTER_TAB_COMMAND = 'open-filter-tab'
export const FOCUS_FILTER_PARAM = 'focusFilter'

function filterFocusUrl() {
  return `chrome-extension://${chrome.runtime.id}/index.html?${FOCUS_FILTER_PARAM}=1`
}

async function findNormalBrowserWindow() {
  try {
    const lastFocusedNormal = await chrome.windows.getLastFocused({ windowTypes: ['normal'] })
    if (typeof lastFocusedNormal?.id === 'number') return lastFocusedNormal
  } catch {}

  try {
    const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] })
    return normalWindows.find((win) => win.focused) || normalWindows[0] || null
  } catch {
    return null
  }
}

export async function openFilterTab() {
  const url = filterFocusUrl()
  const normalWindow = await findNormalBrowserWindow()

  if (typeof normalWindow?.id === 'number') {
    await chrome.tabs.create({
      windowId: normalWindow.id,
      url,
      active: true
    })
    try {
      await chrome.windows.update(normalWindow.id, { focused: true })
    } catch {}
    return
  }

  try {
    await chrome.windows.create({ type: 'normal', url, focused: true })
  } catch {
    await chrome.tabs.create({ url, active: true })
  }
}
