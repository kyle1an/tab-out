import { ContextMenuContent, ContextMenuItem } from './ui/context-menu'
import { titleSuppressionCloseLabel, titleSuppressionSuspendLabel } from './title-suppression'

type StopPropagationEvent = {
  stopPropagation: () => void
}

export interface TitleSuppressionTokenContextMenuContentProps {
  closableCount: number
  suspendableCount?: number
  onSuspend?: (event: StopPropagationEvent) => void | Promise<void>
  onClose: (event: StopPropagationEvent) => void | Promise<void>
}

export function TitleSuppressionTokenContextMenuContent({ closableCount, suspendableCount = 0, onSuspend, onClose }: TitleSuppressionTokenContextMenuContentProps) {
  const suspendLabel = titleSuppressionSuspendLabel(suspendableCount)
  const closeLabel = titleSuppressionCloseLabel(closableCount)
  return (
    <ContextMenuContent>
      {suspendableCount > 0 && onSuspend && (
        <ContextMenuItem
          className="title-suppression-token-suspend-menu-item"
          label={suspendLabel}
          onClick={onSuspend}
        >
          <span className="icon-[lucide--circle-pause] size-3.5" aria-hidden="true" />
          <span className="min-w-0 flex-1">{suspendLabel}</span>
        </ContextMenuItem>
      )}
      <ContextMenuItem
        className="title-suppression-token-close-menu-item"
        label={closeLabel}
        onClick={onClose}
      >
        <span className="icon-[lucide--x] size-3.5" aria-hidden="true" />
        <span className="min-w-0 flex-1">{closeLabel}</span>
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
