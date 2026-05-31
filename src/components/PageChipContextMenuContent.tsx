import { ContextMenuContent, ContextMenuItem } from './ui/context-menu'
import { SavedPageIcon } from './SavedPageIcon'

type StopPropagationEvent = {
  stopPropagation: () => void
}

export type PageChipContextMenuContentProps = {
  savedActionLabel: string
  saved: boolean
  titleText: string
  onSavedSelect: (event: StopPropagationEvent) => void | Promise<void>
  onCopyTitle: (event: StopPropagationEvent) => void | Promise<void>
}

export function PageChipContextMenuContent({
  savedActionLabel,
  saved,
  titleText,
  onSavedSelect,
  onCopyTitle
}: PageChipContextMenuContentProps) {
  return (
    <ContextMenuContent>
      <ContextMenuItem
        className="page-chip-save-menu-item"
        label={savedActionLabel}
        onClick={onSavedSelect}
      >
        <SavedPageIcon saved={saved} className="size-3.5" />
        <span className="min-w-0 flex-1">{savedActionLabel}</span>
      </ContextMenuItem>
      <ContextMenuItem
        className="page-chip-copy-title-menu-item"
        disabled={!titleText}
        label="Copy page title text"
        onClick={onCopyTitle}
      >
        <svg className="icon-[ooui--copy-ltr] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">Copy page title text</span>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
