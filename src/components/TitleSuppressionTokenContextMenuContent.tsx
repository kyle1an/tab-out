import { ContextMenuContent, ContextMenuItem } from './ui/context-menu'
import { titleSuppressionCloseLabel } from './title-suppression'

type StopPropagationEvent = {
  stopPropagation: () => void
}

export interface TitleSuppressionTokenContextMenuContentProps {
  closableCount: number
  onClose: (event: StopPropagationEvent) => void | Promise<void>
}

export function TitleSuppressionTokenContextMenuContent({ closableCount, onClose }: TitleSuppressionTokenContextMenuContentProps) {
  const label = titleSuppressionCloseLabel(closableCount)
  return (
    <ContextMenuContent>
      <ContextMenuItem
        className="title-suppression-token-close-menu-item"
        label={label}
        onClick={onClose}
      >
        <span className="icon-[lucide--x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">{label}</span>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
