import { useEffect, useRef, useState } from 'react'
import {
  DESKTOP_WINDOW_MERGE_OPEN_MESSAGE,
  isDesktopWindowMergeStatusChangedMessage,
  type DesktopWindowMergeAvailability,
  type DesktopWindowMergeJournal,
} from '../extension/desktop-window-merge-contract.js'
import { getDesktopWindowMergeStatus } from '../extension/desktop-window-merge-client.js'
import { desktopWindowMergeFailureMessage } from '../extension/desktop-window-merge-strings.js'
import { moveActiveTabToNewWindow } from '../extension/move-current-tab-action.js'
import { buildOpenTabDedupePlan, type OpenTabDedupePlan } from '../extension/open-tab-dedupe-plan.js'
import {
  closeAllSuspendedTabs,
  closeAllSuspendedTabsAndDedupe,
  dedupeTabs,
} from '../extension/tab-actions'
import { showToast } from '../extension/toast.js'

const DEDUPE_PLAN_REFRESH_DELAY_MS = 150

const popupItemClassName =
  'relative flex w-full min-h-6 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left text-[13px] leading-tight text-foreground outline-none select-none [corner-shape:squircle] hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50'

function dedupeItemLabel(plan: OpenTabDedupePlan | null): string {
  if (!plan || plan.closableCount === 0) return 'Dedupe duplicate tabs'
  return `Dedupe ${plan.closableCount} duplicate tab${plan.closableCount === 1 ? '' : 's'}`
}

async function requestDesktopWindowMergeHandoff(): Promise<void> {
  const currentWindow = await chrome.windows.getCurrent().catch(() => null)
  if (typeof currentWindow?.id !== 'number') {
    showToast('Could not identify this Chrome window')
    return
  }
  void chrome.runtime.sendMessage({
    type: DESKTOP_WINDOW_MERGE_OPEN_MESSAGE,
    windowId: currentWindow.id,
  }).catch(() => undefined)
  // The background worker owns the rest of the handoff; focusing the target
  // page would close the popup anyway, so close it deliberately.
  window.close()
}

/**
 * The Tab Actions Menu rendered by popup.html behind the toolbar action.
 * Cleanup items run in this popup page so their result toast and one-shot
 * Undo render inline; the merge item hands off to a Tab Out page in the
 * invoking window, which owns the preview/confirm dialogs.
 */
export function TabActionsPopup() {
  const tabActionPendingRef = useRef(false)
  const mergeOpenPendingRef = useRef(false)
  const [dedupePlan, setDedupePlan] = useState<OpenTabDedupePlan | null>(null)
  const [availability, setAvailability] =
    useState<DesktopWindowMergeAvailability | null>(null)
  const [mergeSession, setMergeSession] =
    useState<DesktopWindowMergeJournal | null>(null)
  const [tabActionPending, setTabActionPending] = useState(false)
  const [mergeOpenPending, setMergeOpenPending] = useState(false)

  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- the returned cleanup clears refreshTimer; the id is reassigned per debounce, which the rule cannot track.
  useEffect(() => {
    let disposed = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const refreshDedupePlan = () => {
      Promise.all([
        chrome.tabs.query({}),
        chrome.windows.getCurrent(),
      ]).then(([tabs, currentWindow]) => {
        if (disposed) return
        setDedupePlan(buildOpenTabDedupePlan(tabs, currentWindow?.id ?? -1))
      }).catch(() => {
        if (!disposed) setDedupePlan({ closableCount: 0, urls: [] })
      })
    }

    const scheduleDedupePlanRefresh = () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        refreshDedupePlan()
      }, DEDUPE_PLAN_REFRESH_DELAY_MS)
    }

    const applyMergeStatus = async () => {
      const response = await getDesktopWindowMergeStatus()
      if (disposed) return
      if (!response) {
        setAvailability({ available: false, reason: 'coordination-unavailable' })
        return
      }
      setAvailability(response.availability)
      setMergeSession(response.session?.journal ?? null)
    }

    refreshDedupePlan()
    void applyMergeStatus()
    const onRuntimeMessage = (message: unknown) => {
      if (isDesktopWindowMergeStatusChangedMessage(message)) void applyMergeStatus()
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    chrome.tabs.onCreated.addListener(scheduleDedupePlanRefresh)
    chrome.tabs.onRemoved.addListener(scheduleDedupePlanRefresh)
    chrome.tabs.onUpdated.addListener(scheduleDedupePlanRefresh)
    chrome.tabs.onReplaced.addListener(scheduleDedupePlanRefresh)
    return () => {
      disposed = true
      if (refreshTimer !== null) clearTimeout(refreshTimer)
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      chrome.tabs.onCreated.removeListener(scheduleDedupePlanRefresh)
      chrome.tabs.onRemoved.removeListener(scheduleDedupePlanRefresh)
      chrome.tabs.onUpdated.removeListener(scheduleDedupePlanRefresh)
      chrome.tabs.onReplaced.removeListener(scheduleDedupePlanRefresh)
    }
  }, [])

  function runPopupTabAction(action: () => Promise<unknown>) {
    if (tabActionPendingRef.current || mergeSession?.status === 'running') return
    tabActionPendingRef.current = true
    setTabActionPending(true)
    return action()
      .then(() => undefined)
      .finally(() => {
        tabActionPendingRef.current = false
        setTabActionPending(false)
      })
  }

  function openMergeOnDashboard() {
    if (tabActionPendingRef.current || mergeOpenPendingRef.current) return
    mergeOpenPendingRef.current = true
    setMergeOpenPending(true)
    void requestDesktopWindowMergeHandoff().finally(() => {
      mergeOpenPendingRef.current = false
      setMergeOpenPending(false)
    })
  }

  const mergeUnavailableReason = availability == null
    ? 'Checking macOS integration…'
    : !availability.available
        ? desktopWindowMergeFailureMessage(availability.reason)
        : tabActionPending
          ? 'Another tab action is in progress'
          : mergeSession?.status === 'running'
            ? 'A window merge is already in progress'
            : mergeSession
              ? 'Finish the current window merge result'
              : mergeOpenPending
                ? 'Opening Tab Out…'
                : null
  const otherActionsDisabled = tabActionPending || mergeSession?.status === 'running'
  const dedupeDisabled =
    otherActionsDisabled || !dedupePlan || dedupePlan.closableCount === 0

  return (
    <div data-tabout="tab-actions" className="flex w-full flex-col">
      <button
        type="button"
        data-tabout-part="dedupe-button"
        className={popupItemClassName}
        disabled={dedupeDisabled}
        onClick={() => {
          const plan = dedupePlan
          if (!plan || plan.urls.length === 0) return
          void runPopupTabAction(() =>
            dedupeTabs({ urls: plan.urls, preservePinnedTabOut: true }))
        }}
      >
        <span className="icon-[lucide--copy-x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">{dedupeItemLabel(dedupePlan)}</span>
      </button>
      <button
        type="button"
        data-tabout-part="close-suspended-button"
        className={popupItemClassName}
        disabled={otherActionsDisabled}
        onClick={() => void runPopupTabAction(closeAllSuspendedTabs)}
      >
        <span className="icon-[lucide--circle-x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Close all suspended tabs</span>
      </button>
      <button
        type="button"
        data-tabout-part="close-suspended-and-dedupe-button"
        className={popupItemClassName}
        disabled={otherActionsDisabled}
        onClick={() => void runPopupTabAction(closeAllSuspendedTabsAndDedupe)}
      >
        <span className="icon-[lucide--list-x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Close all suspended tabs and dedupe</span>
      </button>
      <div role="separator" aria-orientation="horizontal" className="pointer-events-none mx-1 my-1 h-px bg-border" />
      <button
        type="button"
        data-tabout-part="move-current-tab-button"
        className={popupItemClassName}
        disabled={otherActionsDisabled}
        onClick={() => void runPopupTabAction(async () => {
          const moved = await moveActiveTabToNewWindow()
          // The new window takes focus in real Chrome, which closes the
          // popup; closing deliberately keeps that deterministic.
          if (moved) window.close()
        })}
      >
        <span className="icon-[lucide--app-window] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Move current tab to new window</span>
      </button>
      <button
        type="button"
        data-tabout-part="merge-desktop-windows-button"
        className={`${popupItemClassName} items-start`}
        aria-label="Merge windows on this desktop"
        disabled={mergeUnavailableReason !== null}
        onClick={openMergeOnDashboard}
      >
        <span className="icon-[lucide--panels-top-left] mt-px size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block">Merge windows on this desktop…</span>
          {mergeUnavailableReason && (
            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
              {mergeUnavailableReason}
            </span>
          )}
        </span>
      </button>
    </div>
  )
}
