import {
  getTab,
  getWindow,
  highlightTabs,
  queryTabsInWindowResult,
  type BrowserReadResult
} from './browser-tabs-gateway.js'

export type NativeTabHighlightDependencies = {
  getTab(tabId: number): Promise<chrome.tabs.Tab | null>
  getWindow(windowId: number): Promise<chrome.windows.Window | null>
  highlightTabs(windowId: number, tabIndexes: number[]): Promise<boolean>
  queryTabsInWindowResult(windowId: number): Promise<BrowserReadResult<chrome.tabs.Tab[]>>
}

export type NativeTabHighlightController = {
  clear(): Promise<void>
  setTarget(tabId: number | null | undefined): Promise<void>
}

type DisplayedTarget = {
  owned: boolean
  tabId: number
  windowId: number
}

type ResolvedTarget = Omit<DisplayedTarget, 'owned'>

type TargetResolution =
  | { status: 'ready'; target: ResolvedTarget }
  | { status: 'invalid' }
  | { status: 'stale' }

const defaultDependencies: NativeTabHighlightDependencies = {
  getTab,
  getWindow,
  highlightTabs,
  queryTabsInWindowResult
}

function normalizedTabId(tabId: number | null | undefined): number | null {
  return typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? tabId : null
}

function numericTabId(tab: chrome.tabs.Tab | undefined): number | null {
  return typeof tab?.id === 'number' && Number.isInteger(tab.id) ? tab.id : null
}

function numericTabIndex(tab: chrome.tabs.Tab | undefined): number | null {
  return typeof tab?.index === 'number' && Number.isInteger(tab.index) && tab.index >= 0 ? tab.index : null
}

function sameIndexSelection(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false
  const rightIndexes = new Set(right)
  return left.every((index) => rightIndexes.has(index))
}

/**
 * Owns the one extra Chrome-native selection used for Tab Out's live target
 * preview. Requests are serialized and coalesced so a late chrome.* response
 * cannot leave a previously hovered tab selected.
 */
export function createNativeTabHighlightController(
  dependencies: NativeTabHighlightDependencies = defaultDependencies
): NativeTabHighlightController {
  let desiredTabId: number | null = null
  let displayedTarget: DisplayedTarget | null = null
  let requestRevision = 0
  let runner: Promise<void> | null = null

  function requestIsCurrent(revision: number): boolean {
    return revision === requestRevision
  }

  async function resolveTarget(tabId: number, revision: number): Promise<TargetResolution> {
    const tab = await dependencies.getTab(tabId)
    if (!requestIsCurrent(revision)) return { status: 'stale' }
    if (numericTabId(tab ?? undefined) !== tabId || typeof tab?.windowId !== 'number') {
      return { status: 'invalid' }
    }

    const targetWindow = await dependencies.getWindow(tab.windowId)
    if (!requestIsCurrent(revision)) return { status: 'stale' }
    // Standalone app/PWA and popup windows do not expose the normal tab rail
    // this preview is intended to annotate.
    if (!targetWindow || targetWindow.type !== 'normal') return { status: 'invalid' }

    return { status: 'ready', target: { tabId, windowId: tab.windowId } }
  }

  async function updateWindowSelection(
    previous: DisplayedTarget | null,
    next: ResolvedTarget | null,
    revision: number
  ): Promise<boolean> {
    const windowId = next?.windowId ?? previous?.windowId
    if (typeof windowId !== 'number') {
      displayedTarget = null
      return true
    }

    if (previous && !previous.owned && !next) {
      displayedTarget = null
      return true
    }

    const result = await dependencies.queryTabsInWindowResult(windowId)
    if (!requestIsCurrent(revision)) return false
    if (!result.ok) return false

    const windowTabs = result.value.filter((tab) => tab.windowId === windowId)
    const activeTab = windowTabs.find((tab) => tab.active)
    const activeTabId = numericTabId(activeTab)
    const activeTabIndex = numericTabIndex(activeTab)
    if (activeTabId === null || activeTabIndex === null) return false

    const highlightedTabs = windowTabs.filter((tab) => tab.active || tab.highlighted)
    if (highlightedTabs.some((tab) => numericTabId(tab) === null || numericTabIndex(tab) === null)) {
      return false
    }

    const highlightedTabIds = new Set(highlightedTabs.map((tab) => numericTabId(tab) as number))
    const selectedTabIds = new Set(highlightedTabIds)
    const previousTab = previous
      ? windowTabs.find((tab) => numericTabId(tab) === previous.tabId)
      : undefined

    if (previous?.owned && previousTab?.highlighted && !previousTab.active) {
      selectedTabIds.delete(previous.tabId)
    }

    const nextTabId = next?.tabId
    const nextTabCandidate = nextTabId !== undefined
      ? windowTabs.find((tab) => numericTabId(tab) === nextTabId)
      : undefined
    const nextTab = numericTabIndex(nextTabCandidate) !== null ? nextTabCandidate : undefined
    const nextWasHighlighted = nextTabId !== undefined && !!nextTab && highlightedTabIds.has(nextTabId)
    const nextOwned = !!nextTab && !nextWasHighlighted && !nextTab.active
    if (nextTabId !== undefined && nextTab) selectedTabIds.add(nextTabId)
    selectedTabIds.add(activeTabId)

    const currentIndexes = highlightedTabs.map((tab) => numericTabIndex(tab) as number)
    const nextIndexes = [
      activeTabIndex,
      ...windowTabs
        .filter((tab) => {
          const id = numericTabId(tab)
          return id !== null && id !== activeTabId && selectedTabIds.has(id)
        })
        .map((tab) => numericTabIndex(tab) as number)
        .sort((left, right) => left - right)
    ]

    if (!sameIndexSelection(currentIndexes, nextIndexes)) {
      const highlighted = await dependencies.highlightTabs(windowId, nextIndexes)
      if (!highlighted) return false
    }

    displayedTarget = nextTab && next
      ? { ...next, owned: nextOwned }
      : null
    return true
  }

  async function transitionTo(next: ResolvedTarget | null, revision: number): Promise<void> {
    const previous = displayedTarget
    if (previous && next && previous.tabId === next.tabId && previous.windowId === next.windowId) return

    if (previous && next && previous.windowId === next.windowId) {
      await updateWindowSelection(previous, next, revision)
      return
    }

    if (previous) {
      const released = await updateWindowSelection(previous, null, revision)
      if (!released || !requestIsCurrent(revision)) return
    }

    if (next) await updateWindowSelection(null, next, revision)
  }

  async function reconcileRequest(tabId: number | null, revision: number): Promise<void> {
    if (tabId === null) {
      await transitionTo(null, revision)
      return
    }

    const resolution = await resolveTarget(tabId, revision)
    if (resolution.status === 'stale') return
    await transitionTo(resolution.status === 'ready' ? resolution.target : null, revision)
  }

  async function run(): Promise<void> {
    while (true) {
      const revision = requestRevision
      const tabId = desiredTabId
      try {
        await reconcileRequest(tabId, revision)
      } catch {
        // Hover feedback is best-effort. URL preview and all tab actions remain
        // usable when Chrome rejects a transient selection read or mutation.
      }
      if (requestIsCurrent(revision)) {
        runner = null
        return
      }
    }
  }

  function setTarget(tabId: number | null | undefined): Promise<void> {
    const nextTabId = normalizedTabId(tabId)
    const alreadyDisplayed = nextTabId === null
      ? displayedTarget === null
      : displayedTarget?.tabId === nextTabId

    if (desiredTabId === nextTabId && runner) return runner
    if (desiredTabId === nextTabId && alreadyDisplayed) return Promise.resolve()

    desiredTabId = nextTabId
    requestRevision += 1
    if (runner) return runner
    runner = run()
    return runner
  }

  return {
    clear() {
      return setTarget(null)
    },
    setTarget
  }
}
