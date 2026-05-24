import { unwrapSuspenderUrl } from './suspender.js'
import type { PageTarget } from './page-target.js'

type ChromeTabFocusApi = {
  runtime?: {
    id?: string
    sendMessage?: (extensionId: string, message: unknown) => Promise<unknown>
  }
  tabs: {
    query: (queryInfo?: chrome.tabs.QueryInfo) => Promise<chrome.tabs.Tab[]>
    update: (tabId: number, updateProperties: chrome.tabs.UpdateProperties) => Promise<chrome.tabs.Tab | undefined>
  }
  windows: {
    getCurrent?: () => Promise<chrome.windows.Window>
    update: (windowId: number, updateInfo: chrome.windows.UpdateInfo) => Promise<chrome.windows.Window | undefined>
  }
}

export type ExistingTabTarget = PageTarget & {
  tabId?: number
  windowId?: number
}

function chromeApiOrNull(chromeApi?: ChromeTabFocusApi): ChromeTabFocusApi | null {
  return chromeApi || (globalThis.chrome as ChromeTabFocusApi | undefined) || null
}

function tabTargetEffectiveUrl(target: PageTarget | null | undefined, fallbackUrl = ''): string {
  return unwrapSuspenderUrl(target?.url || target?.tabUrl || target?.rawUrl || fallbackUrl || '')
}

function suspenderExtensionId(url?: string): string {
  if (!url || !url.startsWith('chrome-extension://')) return ''
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.endsWith('/suspended.html')) return ''
    return parsed.hostname
  } catch {
    return ''
  }
}

function isSuspendedUrlForTarget(tabUrl: string | undefined, targetEffective: string): boolean {
  if (!tabUrl || tabUrl === targetEffective) return false
  return unwrapSuspenderUrl(tabUrl) === targetEffective
}

async function requestSuspenderUnsuspend(chromeApi: ChromeTabFocusApi, tab: chrome.tabs.Tab, targetEffective: string): Promise<boolean> {
  if (typeof tab.id !== 'number') return false
  if (!isSuspendedUrlForTarget(tab.url, targetEffective)) return false
  const extensionId = suspenderExtensionId(tab.url)
  if (!extensionId || extensionId === chromeApi.runtime?.id || !chromeApi.runtime?.sendMessage) return false
  try {
    const response = await chromeApi.runtime.sendMessage(extensionId, { action: 'unsuspend', tabId: tab.id })
    return !(typeof response === 'string' && response.startsWith('Error:'))
  } catch {
    return false
  }
}

async function focusMatchedTab(chromeApi: ChromeTabFocusApi, match: chrome.tabs.Tab, targetEffective: string): Promise<boolean> {
  if (typeof match.id !== 'number') return false
  const didRequestUnsuspend = await requestSuspenderUnsuspend(chromeApi, match, targetEffective)
  const updateProperties: chrome.tabs.UpdateProperties = { active: true }
  if (!didRequestUnsuspend && isSuspendedUrlForTarget(match.url, targetEffective)) {
    updateProperties.url = targetEffective
  }
  await chromeApi.tabs.update(match.id, updateProperties)
  await chromeApi.windows.update(match.windowId, { focused: true })
  return true
}

export async function focusExistingTabTarget(target: ExistingTabTarget, chromeApi?: ChromeTabFocusApi): Promise<boolean> {
  const api = chromeApiOrNull(chromeApi)
  if (!api || !Number.isInteger(target.tabId)) return false

  try {
    const allTabs = await api.tabs.query({})
    const match = allTabs.find((tab) => tab.id === target.tabId)
    if (!match) return false
    const targetEffective = tabTargetEffectiveUrl(target, match.url || '')
    return focusMatchedTab(api, match, targetEffective)
  } catch {
    return false
  }
}

export async function focusExactTabTarget(url: string, chromeApi?: ChromeTabFocusApi): Promise<boolean> {
  const api = chromeApiOrNull(chromeApi)
  if (!api || !url) return false

  try {
    const allTabs = await api.tabs.query({})
    const targetEffective = unwrapSuspenderUrl(url)
    const matches = allTabs.filter((tab) => tab.url === url || unwrapSuspenderUrl(tab.url) === targetEffective)
    if (matches.length === 0) return false

    let currentWindowId = -1
    try {
      currentWindowId = (await api.windows.getCurrent?.())?.id ?? -1
    } catch {}

    const match = matches.find((tab) => tab.windowId === currentWindowId) || matches[0]
    if (!match) return false
    return focusMatchedTab(api, match, targetEffective)
  } catch {
    return false
  }
}

export async function focusTabTarget(url: string, chromeApi?: ChromeTabFocusApi): Promise<boolean> {
  const api = chromeApiOrNull(chromeApi)
  if (!api || !url) return false

  try {
    const allTabs = await api.tabs.query({})
    const currentWindow = await api.windows.getCurrent?.()
    const targetEffective = unwrapSuspenderUrl(url)

    let matches = allTabs.filter((tab) => tab.url === url || unwrapSuspenderUrl(tab.url) === targetEffective)

    if (matches.length === 0) {
      try {
        const targetHost = new URL(targetEffective).hostname
        matches = allTabs.filter((tab) => {
          try {
            return new URL(unwrapSuspenderUrl(tab.url)).hostname === targetHost
          } catch {
            return false
          }
        })
      } catch {}
    }

    if (matches.length === 0) return false

    const match = matches.find((tab) => tab.windowId !== currentWindow?.id) || matches[0]
    if (!match) return false
    return focusMatchedTab(api, match, targetEffective)
  } catch {
    return false
  }
}
