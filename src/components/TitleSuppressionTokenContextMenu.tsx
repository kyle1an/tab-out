import type { ReactElement } from 'react'
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import { TitleSuppressionTokenContextMenuContent } from './TitleSuppressionTokenContextMenuContent'

type StopPropagationEvent = {
  stopPropagation: () => void
}

type TitleSuppressionTokenContextMenuTriggerElement = ReactElement<{ className?: string }>

interface TitleSuppressionTokenContextMenuProps {
  closableCount: number
  onClose: (event: StopPropagationEvent) => void | Promise<void>
  onOpenChange?: (open: boolean) => void
  children: TitleSuppressionTokenContextMenuTriggerElement
}

export function TitleSuppressionTokenContextMenu({ closableCount, onClose, onOpenChange, children }: TitleSuppressionTokenContextMenuProps) {
  return (
    <ContextMenu onOpenChange={(open) => onOpenChange?.(open)}>
      <ContextMenuTrigger render={children} />
      <TitleSuppressionTokenContextMenuContent closableCount={closableCount} onClose={onClose} />
    </ContextMenu>
  )
}
