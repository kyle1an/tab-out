import { focusWindow, getCurrentWindow, queryAllTabs, requestExternalUnsuspend, updateTab } from './browser-tabs-gateway.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { PageTarget } from './page-target.js'

export type ExistingTabTarget = PageTarget & {
  tabId?: number
  windowId?: number
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

async function requestSuspenderUnsuspend(tab: chrome.tabs.Tab, targetEffective: string): Promise<boolean> {
  if (typeof tab.id !== 'number') return false
  if (!isSuspendedUrlForTarget(tab.url, targetEffective)) return false
  const extensionId = suspenderExtensionId(tab.url)
  if (!extensionId) return false
  return requestExternalUnsuspend(extensionId, tab.id)
}

async function applyUnsuspend(tab: chrome.tabs.Tab, targetEffective: string, updateProperties?: chrome.tabs.UpdateProperties): Promise<boolean> {
  if (typeof tab.id !== 'number') return false
  if (!isSuspendedUrlForTarget(tab.url, targetEffective)) return false
  const didRequestUnsuspend = await requestSuspenderUnsuspend(tab, targetEffective)
  if (didRequestUnsuspend) return true
  if (updateProperties) {
    updateProperties.url = targetEffective
  } else {
    await updateTab(tab.id, { url: targetEffective })
  }
  return true
}

async function focusMatchedTab(match: chrome.tabs.Tab, targetEffective: string): Promise<boolean> {
  if (typeof match.id !== 'number') return false
  const updateProperties: chrome.tabs.UpdateProperties = { active: true }
  await applyUnsuspend(match, targetEffective, updateProperties)
  await updateTab(match.id, updateProperties)
  await focusWindow(match.windowId)
  return true
}

export async function unsuspendExistingTab(tab: chrome.tabs.Tab, target: PageTarget): Promise<boolean> {
  if (typeof tab.id !== 'number') return false
  return applyUnsuspend(tab, tabTargetEffectiveUrl(target, tab.url || ''))
}

export async function focusExistingTabTarget(target: ExistingTabTarget): Promise<boolean> {
  if (!Number.isInteger(target.tabId)) return false

  const allTabs = await queryAllTabs()
  const match = allTabs.find((tab) => tab.id === target.tabId)
  if (!match) return false
  return focusMatchedTab(match, tabTargetEffectiveUrl(target, match.url || ''))
}

export async function focusExactTabTarget(url: string): Promise<boolean> {
  if (!url) return false

  const allTabs = await queryAllTabs()
  const targetEffective = unwrapSuspenderUrl(url)
  const matches = allTabs.filter((tab) => tab.url === url || unwrapSuspenderUrl(tab.url) === targetEffective)
  if (matches.length === 0) return false

  const currentWindowId = (await getCurrentWindow())?.id ?? -1
  const match = matches.find((tab) => tab.windowId === currentWindowId) || matches[0]
  if (!match) return false
  return focusMatchedTab(match, targetEffective)
}

export async function focusTabTarget(url: string): Promise<boolean> {
  if (!url) return false

  const allTabs = await queryAllTabs()
  const currentWindowId = (await getCurrentWindow())?.id ?? null
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

  const match = matches.find((tab) => tab.windowId !== currentWindowId) || matches[0]
  if (!match) return false
  return focusMatchedTab(match, targetEffective)
}
