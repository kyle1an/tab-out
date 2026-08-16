import { useEffect, useRef, useState } from 'react'
import {
  isDesktopWindowMergeStatusChangedMessage,
  type DesktopWindowMergeAvailability,
  type DesktopWindowMergeJournal,
  type DesktopWindowMergeRequestFailureReason,
} from '../extension/desktop-window-merge-contract.js'
import {
  acknowledgeDesktopWindowMerge,
  confirmDesktopWindowMerge,
  getDesktopWindowMergeStatus,
  previewDesktopWindowMerge,
} from '../extension/desktop-window-merge-client.js'
import { closeAllSuspendedTabs, closeAllSuspendedTabsAndDedupe } from '../extension/tab-actions'
import { showToast } from '../extension/toast.js'
import {
  DesktopWindowMergeDialog,
  type DesktopWindowMergeDialogState,
} from './DesktopWindowMergeDialog'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/menu'

interface HeaderTabActionsMenuProps {
  ready: boolean
}

export function HeaderTabActionsMenu({ ready }: HeaderTabActionsMenuProps) {
  const mergeResultAcknowledgementPendingRef = useRef(false)
  const tabActionPendingRef = useRef(false)
  const handledSessionIdsRef = useRef(new Set<string>())
  const [availability, setAvailability] =
    useState<DesktopWindowMergeAvailability | null>(null)
  const [dialogState, setDialogState] =
    useState<DesktopWindowMergeDialogState | null>(null)
  const [mergePending, setMergePending] = useState(false)
  const [mergeSession, setMergeSession] =
    useState<DesktopWindowMergeJournal | null>(null)
  const [tabActionPending, setTabActionPending] = useState(false)

  useEffect(() => {
    let disposed = false
    let latestStatusRequest = 0

    const applyStatus = async () => {
      latestStatusRequest += 1
      const statusRequest = latestStatusRequest
      const response = await getDesktopWindowMergeStatus()
      if (disposed || statusRequest !== latestStatusRequest) return
      if (!response) {
        setAvailability({ available: false, reason: 'coordination-unavailable' })
        return
      }
      setAvailability(response.availability)
      setMergeSession(response.session?.journal ?? null)
      const owned = response.session
      if (!owned?.isOwner) return
      const journal = owned.journal
      if (journal.status === 'running') {
        setDialogState((current) =>
          current?.kind === 'result' ? current : { kind: 'progress' })
        return
      }
      if (handledSessionIdsRef.current.has(journal.sessionId)) return
      handledSessionIdsRef.current.add(journal.sessionId)
      if (journal.status === 'succeeded') {
        setDialogState(null)
        showToast(mergeSuccessMessage(journal))
        const acknowledged = await acknowledgeDesktopWindowMerge(journal.sessionId)
        if (!acknowledged) handledSessionIdsRef.current.delete(journal.sessionId)
        else if (!disposed) setMergeSession(null)
        return
      }
      setDialogState({ kind: 'result', journal })
    }

    void applyStatus()
    const onRuntimeMessage = (message: unknown) => {
      if (isDesktopWindowMergeStatusChangedMessage(message)) void applyStatus()
    }
    const onWindowFocus = () => void applyStatus()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void applyStatus()
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      latestStatusRequest += 1
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  function runHeaderTabAction(action: () => Promise<unknown>) {
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

  function mergeFailureMessage(reason: DesktopWindowMergeRequestFailureReason): string {
    switch (reason) {
      case 'browser-read-failed':
        return 'Could not read the current Chrome windows'
      case 'controller-update-required':
        return 'Update or restart the Tab Out Hammerspoon integration'
      case 'coordination-unavailable':
        return 'Window merge coordination is unavailable in this Chrome session'
      case 'desktop-selection-unavailable':
        return 'Could not safely identify the windows on this desktop'
      case 'native-integration-required':
        return 'Set up the Tab Out macOS integration to merge windows'
      case 'session-storage-unavailable':
        return 'Window merge status storage is unavailable'
    }
  }

  async function requestMergePreview() {
    if (tabActionPendingRef.current || mergePending || mergeSession) return
    setMergePending(true)
    const response = await previewDesktopWindowMerge().finally(() => {
      setMergePending(false)
    })
    if (!response) {
      showToast('Could not check windows on this desktop')
      return
    }
    if (!response.ok) {
      showToast(mergeFailureMessage(response.reason))
      return
    }
    if (response.status === 'ready') {
      setDialogState({
        kind: 'confirm',
        movingTabCount: response.movingTabCount,
        previewId: response.previewId,
        sourceWindowCount: response.sourceWindowCount,
      })
      return
    }
    if (response.status === 'already-merged') {
      showToast('All windows on this desktop are already merged.')
      return
    }
    if (response.status === 'busy') {
      showToast('Another window merge is already in progress')
      return
    }
  }

  async function confirmMerge(previewId: string) {
    setDialogState({ kind: 'progress' })
    setMergePending(true)
    const response = await confirmDesktopWindowMerge(previewId).finally(() => {
      setMergePending(false)
    })
    if (!response) {
      setDialogState(null)
      showToast('Could not read the window merge result')
      return
    }
    if (!response.ok) {
      setDialogState(null)
      showToast(mergeFailureMessage(response.reason))
      return
    }
    if (response.status === 'changed') {
      setDialogState({
        kind: 'confirm',
        movingTabCount: response.movingTabCount,
        notice: 'The windows or tabs changed. Review the updated counts before merging.',
        previewId: response.previewId,
        sourceWindowCount: response.sourceWindowCount,
      })
      return
    }
    if (response.status === 'already-merged') {
      setDialogState(null)
      showToast('All windows on this desktop are already merged.')
      return
    }
    if (response.status === 'busy') {
      setDialogState(null)
      showToast('Another window merge is already in progress')
      return
    }
    if (!('journal' in response)) return

    if (handledSessionIdsRef.current.has(response.journal.sessionId)) {
      if (response.status === 'succeeded') setDialogState(null)
      return
    }
    handledSessionIdsRef.current.add(response.journal.sessionId)
    setMergeSession(response.journal)
    if (response.status === 'succeeded') {
      setDialogState(null)
      showToast(mergeSuccessMessage(response.journal))
      const acknowledged = await acknowledgeDesktopWindowMerge(response.journal.sessionId)
      if (!acknowledged) {
        handledSessionIdsRef.current.delete(response.journal.sessionId)
      } else {
        setMergeSession(null)
      }
      return
    }
    setDialogState({ kind: 'result', journal: response.journal })
  }

  async function closeMergeResult(journal: DesktopWindowMergeJournal) {
    if (mergeResultAcknowledgementPendingRef.current) return
    mergeResultAcknowledgementPendingRef.current = true
    const acknowledged = await acknowledgeDesktopWindowMerge(journal.sessionId).finally(() => {
      mergeResultAcknowledgementPendingRef.current = false
    })
    if (!acknowledged) {
      handledSessionIdsRef.current.delete(journal.sessionId)
      setDialogState({ kind: 'result', journal })
      showToast('Could not clear the window merge result')
    } else {
      setDialogState(null)
      setMergeSession(null)
    }
  }

  function onDialogOpenChange(open: boolean) {
    if (open || !dialogState) return
    if (dialogState.kind === 'result') {
      void closeMergeResult(dialogState.journal)
    } else {
      setDialogState(null)
    }
  }

  const mergeUnavailableReason = availability == null
    ? 'Checking macOS integration…'
    : !availability.available
        ? mergeFailureMessage(availability.reason)
        : tabActionPending
          ? 'Another tab action is in progress'
          : mergeSession?.status === 'running'
            ? 'A window merge is already in progress'
            : mergeSession
              ? 'Finish the current window merge result'
              : mergePending
                ? 'Checking windows…'
                : null
  const otherActionsDisabled = tabActionPending || mergeSession?.status === 'running'

  return (
    <div data-tabout="tab-actions" className="inline-flex">
      <Menu>
        <MenuTrigger
          data-tabout-part="menu-trigger"
          className="header-tab-actions-menu-trigger grid size-(--header-control-height) shrink-0 cursor-pointer place-items-center rounded-(--header-control-radius) border border-(--warm-gray) bg-tab-card p-0 text-muted-foreground transition-[color,border-color,background-color] duration-200 outline-none [corner-shape:squircle] hover:border-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber) disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-popup-open:border-foreground data-popup-open:bg-[rgba(82,82,82,0.08)] data-popup-open:text-foreground"
          aria-label="Tab actions"
          disabled={!ready}
        >
          <span className="icon-[lucide--ellipsis] size-4" aria-hidden="true" />
        </MenuTrigger>
        <MenuContent>
          <MenuItem
            data-tabout-part="close-suspended-button"
            disabled={otherActionsDisabled}
            label="Close all suspended tabs"
            onClick={() => runHeaderTabAction(closeAllSuspendedTabs)}
          >
            <span className="icon-[lucide--circle-x] size-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">Close all suspended tabs</span>
          </MenuItem>
          <MenuItem
            data-tabout-part="close-suspended-and-dedupe-button"
            disabled={otherActionsDisabled}
            label="Close all suspended tabs and dedupe"
            onClick={() => runHeaderTabAction(closeAllSuspendedTabsAndDedupe)}
          >
            <span className="icon-[lucide--list-x] size-3.5" aria-hidden="true" />
            <span className="min-w-0 flex-1">Close all suspended tabs and dedupe</span>
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            data-tabout-part="merge-desktop-windows-button"
            className="items-start py-1.5"
            disabled={mergeUnavailableReason !== null}
            label="Merge windows on this desktop"
            onClick={() => void requestMergePreview()}
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
          </MenuItem>
        </MenuContent>
      </Menu>
      <DesktopWindowMergeDialog
        state={dialogState}
        onCloseResult={(journal) => void closeMergeResult(journal)}
        onConfirm={(previewId) => void confirmMerge(previewId)}
        onOpenChange={onDialogOpenChange}
      />
    </div>
  )
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

function mergeSuccessMessage(journal: DesktopWindowMergeJournal): string {
  return `Merged ${countLabel(journal.movedTabCount, 'tab')} from ${countLabel(journal.sourceWindowCount, 'other window')}.`
}
