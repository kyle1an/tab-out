import { useRef } from 'react'

import type { DesktopWindowMergeJournal } from '../extension/desktop-window-merge-contract.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './ui/dialog'

export type DesktopWindowMergeDialogState =
  | {
    readonly kind: 'confirm'
    readonly movingTabCount: number
    readonly notice?: string | undefined
    readonly previewId: string
    readonly sourceWindowCount: number
  }
  | { readonly kind: 'progress' }
  | {
    readonly journal: DesktopWindowMergeJournal
    readonly kind: 'result'
  }

interface DesktopWindowMergeDialogProps {
  readonly onCloseResult: (journal: DesktopWindowMergeJournal) => void
  readonly onConfirm: (previewId: string) => void
  readonly onOpenChange: (open: boolean) => void
  readonly state: DesktopWindowMergeDialogState | null
}

const secondaryButtonClassName =
  'inline-flex h-8 cursor-pointer items-center justify-center rounded-xl border border-border bg-transparent px-3 text-sm text-foreground outline-none [corner-shape:squircle] hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)'
const primaryButtonClassName =
  'inline-flex h-8 cursor-pointer items-center justify-center rounded-xl border border-foreground bg-foreground px-3 text-sm text-background outline-none [corner-shape:squircle] hover:opacity-[0.88] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--accent-amber)'

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function DesktopWindowMergeDialog({
  onCloseResult,
  onConfirm,
  onOpenChange,
  state,
}: DesktopWindowMergeDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const resultCloseButtonRef = useRef<HTMLButtonElement>(null)
  const progress = state?.kind === 'progress'

  return (
    <Dialog
      open={state !== null}
      disablePointerDismissal={progress}
      onOpenChange={(open) => {
        if (!open && progress) return
        onOpenChange(open)
      }}
    >
      {state && (
        <DialogContent
          data-tabout="desktop-window-merge-dialog"
          initialFocus={state.kind === 'confirm'
            ? cancelButtonRef
            : state.kind === 'result'
              ? resultCloseButtonRef
              : false}
        >
          {state.kind === 'confirm' && (
            <>
              <DialogTitle>Merge windows on this desktop?</DialogTitle>
              <DialogDescription>
                Move {countLabel(state.movingTabCount, 'tab')} from{' '}
                {countLabel(state.sourceWindowCount, 'other window')} into this window.
                The other windows will close. Pinned tabs and tab groups will be
                preserved. The original window layout cannot be restored automatically.
              </DialogDescription>
              {state.notice && (
                <p className="mt-3 rounded-xl bg-accent px-3 py-2 text-sm leading-5 text-foreground [corner-shape:squircle]">
                  {state.notice}
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <DialogClose
                  ref={cancelButtonRef}
                  data-tabout-part="cancel-button"
                  className={secondaryButtonClassName}
                >
                  Cancel
                </DialogClose>
                <button
                  type="button"
                  data-tabout-part="confirm-button"
                  className={primaryButtonClassName}
                  onClick={() => onConfirm(state.previewId)}
                >
                  Merge windows
                </button>
              </div>
            </>
          )}

          {state.kind === 'progress' && (
            <div aria-live="polite" aria-busy="true">
              <DialogTitle>Merging windows…</DialogTitle>
              <DialogDescription>
                Keep Chrome open while Tab Out moves the selected tabs.
              </DialogDescription>
              <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
                <span
                  className="icon-[lucide--loader-circle] size-4 animate-spin"
                  aria-hidden="true"
                />
                Preserving tab order, pins, and groups
              </div>
            </div>
          )}

          {state.kind === 'result' && (
            <>
              <DialogTitle>
                {state.journal.status === 'interrupted'
                  ? 'Window merge was interrupted'
                  : 'Some windows couldn’t be merged'}
              </DialogTitle>
              <DialogDescription>
                {state.journal.remainingTabCount > 0
                  ? `Moved ${countLabel(state.journal.movedTabCount, 'tab')}. ${countLabel(state.journal.remainingTabCount, 'tab')} remained in the original windows.`
                  : `Moved ${countLabel(state.journal.movedTabCount, 'tab')}, but Tab Out could not verify every pin, group, and tab position.`}
                {' '}No automatic retry or rollback was attempted.
              </DialogDescription>
              <div className="mt-5 flex justify-end">
                <button
                  ref={resultCloseButtonRef}
                  type="button"
                  data-tabout-part="close-button"
                  className={primaryButtonClassName}
                  onClick={() => onCloseResult(state.journal)}
                >
                  Close
                </button>
              </div>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  )
}
