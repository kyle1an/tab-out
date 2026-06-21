import { lazy, Suspense } from 'react'
import type { ReactElement } from 'react'

type StopPropagationEvent = {
  stopPropagation: () => void
}

type TitleSuppressionTokenContextMenuTriggerElement = ReactElement<{ className?: string }>

export interface TitleSuppressionTokenContextMenuProps {
  closableCount: number
  suspendableCount?: number
  onSuspend?: (event: StopPropagationEvent) => void | Promise<void>
  onClose: (event: StopPropagationEvent) => void | Promise<void>
  onOpenChange?: (open: boolean) => void
  children: TitleSuppressionTokenContextMenuTriggerElement
}

const TitleSuppressionTokenContextMenuLoaded = lazy(() => import('./TitleSuppressionTokenContextMenuLoaded').then((module) => ({ default: module.TitleSuppressionTokenContextMenuLoaded })))

export function TitleSuppressionTokenContextMenu(props: TitleSuppressionTokenContextMenuProps) {
  return (
    <Suspense fallback={props.children}>
      <TitleSuppressionTokenContextMenuLoaded {...props} />
    </Suspense>
  )
}
