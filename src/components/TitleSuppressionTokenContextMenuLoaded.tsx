import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import { TitleSuppressionTokenContextMenuContent } from './TitleSuppressionTokenContextMenuContent'
import type { TitleSuppressionTokenContextMenuProps } from './TitleSuppressionTokenContextMenu'

export function TitleSuppressionTokenContextMenuLoaded({
  closableCount,
  suspendableCount = 0,
  onSuspend,
  onClose,
  onOpenChange,
  children
}: TitleSuppressionTokenContextMenuProps) {
  return (
    <ContextMenu onOpenChange={(open) => onOpenChange?.(open)}>
      <ContextMenuTrigger render={children} />
      <TitleSuppressionTokenContextMenuContent
        closableCount={closableCount}
        suspendableCount={suspendableCount}
        onSuspend={onSuspend}
        onClose={onClose}
      />
    </ContextMenu>
  )
}
