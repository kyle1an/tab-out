import { cloneElement, lazy, Suspense, useState } from 'react'
import type { FocusEventHandler, MouseEventHandler, PointerEventHandler, ReactElement } from 'react'
import type { PageChipContextMenuContentProps } from './PageChipContextMenuContent'

const PageChipContextMenuLoaded = lazy(() => import('./PageChipContextMenuLoaded').then((module) => ({ default: module.PageChipContextMenuLoaded })))

export type PageChipContextMenuTriggerElement = ReactElement<{
  className?: string
  'data-context-menu-open'?: string
  onFocus?: FocusEventHandler
  onMouseDown?: MouseEventHandler
  onPointerEnter?: PointerEventHandler
}>

type PageChipContextMenuProps = PageChipContextMenuContentProps & {
  children: PageChipContextMenuTriggerElement
  onOpenChange?: (open: boolean) => void
}

export function PageChipContextMenu({
  children,
  savedActionLabel,
  saved,
  titleText,
  onSavedSelect,
  pagePinActionLabel,
  pagePinned,
  onPagePinSelect,
  onCopyTitle,
  urlText,
  onCopyUrl,
  suspendEnabled,
  onSuspendSelect,
  onOpenChange
}: PageChipContextMenuProps) {
  const [armed, setArmed] = useState(false)
  const armedTrigger = cloneElement(children, {
    onFocus: (event) => {
      children.props.onFocus?.(event)
      setArmed(true)
    },
    onMouseDown: (event) => {
      children.props.onMouseDown?.(event)
      if (event.button === 2) setArmed(true)
    },
    onPointerEnter: (event) => {
      children.props.onPointerEnter?.(event)
      setArmed(true)
    }
  })

  if (!armed) return armedTrigger

  return (
    <Suspense fallback={armedTrigger}>
      <PageChipContextMenuLoaded
        savedActionLabel={savedActionLabel}
        saved={saved}
        onSavedSelect={onSavedSelect}
        pagePinActionLabel={pagePinActionLabel}
        pagePinned={pagePinned}
        onPagePinSelect={onPagePinSelect}
        titleText={titleText}
        onCopyTitle={onCopyTitle}
        urlText={urlText}
        onCopyUrl={onCopyUrl}
        suspendEnabled={suspendEnabled}
        onSuspendSelect={onSuspendSelect}
        onOpenChange={onOpenChange}
      >
        {armedTrigger}
      </PageChipContextMenuLoaded>
    </Suspense>
  )
}
