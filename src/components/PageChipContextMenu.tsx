import { cloneElement, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
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
  const visualCloseTimerRef = useRef<number | null>(null)

  function clearVisualCloseTimer() {
    if (visualCloseTimerRef.current === null) return
    window.clearTimeout(visualCloseTimerRef.current)
    visualCloseTimerRef.current = null
  }

  useEffect(() => () => {
    if (visualCloseTimerRef.current !== null) {
      window.clearTimeout(visualCloseTimerRef.current)
    }
  }, [])

  function handleOpenChange(nextOpen: boolean, details: ContextMenuChangeEventDetails) {
    clearVisualCloseTimer()
    if (nextOpen) {
      setVisualOpen(true)
    } else {
      visualCloseTimerRef.current = window.setTimeout(() => {
        visualCloseTimerRef.current = null
        setVisualOpen(false)
      }, PAGE_CHIP_CONTEXT_MENU_VISUAL_CLOSE_DELAY_MS)
    }
    onOpenChange?.(nextOpen, details)
  }

  const trigger = visualOpen
    ? cloneElement(children, {
        className: cn(children.props.className, 'page-chip-context-menu-open'),
        'data-context-menu-open': ''
      })
    : children

  return (
    <ContextMenu onOpenChange={handleOpenChange}>
      <ContextMenuTrigger render={trigger} />
      <PageChipContextMenuContent {...contentProps} />
    </ContextMenu>
  )
}
