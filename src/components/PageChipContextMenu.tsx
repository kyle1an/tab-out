import { cloneElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useRetimer } from 'foxact/use-retimer'
import { cn } from '@/lib/utils'
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu'
import { PageChipContextMenuContent } from './PageChipContextMenuContent'
import type { PageChipContextMenuContentProps } from './PageChipContextMenuContent'
import type { ContextMenuChangeEventDetails } from './context-menu-outside-press'

const PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS = 80

export type PageChipContextMenuTriggerElement = ReactElement<{
  className?: string
  'data-context-menu-open'?: string
}>

type PageChipContextMenuProps = PageChipContextMenuContentProps & {
  children: PageChipContextMenuTriggerElement
  onOpenChange?: ((open: boolean, details: ContextMenuChangeEventDetails) => void) | undefined
}

export function PageChipContextMenu({
  children,
  onOpenChange,
  ...contentProps
}: PageChipContextMenuProps) {
  const [visualOpen, setVisualOpen] = useState(false)
  const retimeVisualClose = useRetimer()

  useEffect(() => () => {
    retimeVisualClose()
  }, [retimeVisualClose])

  function handleOpenChange(nextOpen: boolean, details: ContextMenuChangeEventDetails) {
    retimeVisualClose()
    if (nextOpen) {
      setVisualOpen(true)
    } else {
      retimeVisualClose(window.setTimeout(() => {
        setVisualOpen(false)
      }, PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS))
    }
    onOpenChange?.(nextOpen, details)
  }

  const trigger = visualOpen
    ? cloneElement(children, {
        className: cn(children.props.className, 'page-chip-context-menu-open'),
        'data-context-menu-open': '',
      })
    : children

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger render={trigger} />
      <PageChipContextMenuContent {...contentProps} />
    </ContextMenu>
  )
}
