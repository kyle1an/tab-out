import type { ReactElement } from 'react'
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import { TitleSuppressionTokenContextMenuContent } from './TitleSuppressionTokenContextMenuContent'

type StopPropagationEvent = {
  stopPropagation: () => void
}

type TitleSuppressionTokenContextMenuTriggerElement = ReactElement<{ className?: string }>

export interface TitleSuppressionTokenContextMenuProps {
  closableCount: number
  suspendableCount?: number | undefined
  onSuspend?: ((event: StopPropagationEvent) => void | Promise<void>) | undefined
  onClose: (event: StopPropagationEvent) => void | Promise<void>
  onOpenChange?: ((open: boolean) => void) | undefined
  children: TitleSuppressionTokenContextMenuTriggerElement
}

export function TitleSuppressionTokenContextMenu({
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
