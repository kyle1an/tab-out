import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  ComponentProps,
  FocusEvent as ReactFocusEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  Ref,
  ReactElement,
  ReactNode,
  WheelEvent as ReactWheelEvent
} from 'react'
import { flushSync } from 'react-dom'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { mergeRefs } from 'foxact/merge-refs'
import { useRetimer } from 'foxact/use-retimer'

import { cn } from '@/lib/utils'

const TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS = 200
const TOOLTIP_INITIAL_REST_DELAY_MS = 500
const TOOLTIP_ADJACENT_REST_DELAY_MS = 180
const TOOLTIP_ADJACENT_REST_WINDOW_MS = 700
const TOOLTIP_HOVERABLE_CLOSE_DELAY_MS = 160
const TOOLTIP_HOVER_WATCH_INTERVAL_MS = 80
const TOOLTIP_GLOBAL_CLOSE_REOPEN_BLOCK_MS = 320
const TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX = 1
const TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS = 900
const TOOLTIP_WHEEL_DELTA_LINE = 1
const TOOLTIP_WHEEL_DELTA_PAGE = 2
const TOOLTIP_WHEEL_LINE_HEIGHT_PX = 16
const TOOLTIP_COLLISION_AVOIDANCE: NonNullable<
  TooltipPrimitive.Positioner.Props['collisionAvoidance']
> = {
  side: 'flip',
  align: 'flip',
  fallbackAxisSide: 'none'
}

type TooltipProviderProps = {
  children?: ReactNode
}

let activeTooltipAnchorId: string | null = null
let latestTooltipActivityAt = 0
let wheelClosedTooltipBlockedUntil = 0

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function shouldUseAdjacentTooltipDelay(anchorId: string) {
  const hasActiveOtherTooltip =
    activeTooltipAnchorId !== null && activeTooltipAnchorId !== anchorId
  const recentlyClosed =
    activeTooltipAnchorId === null &&
    latestTooltipActivityAt > 0 &&
    now() - latestTooltipActivityAt <= TOOLTIP_ADJACENT_REST_WINDOW_MS
  return hasActiveOtherTooltip || recentlyClosed
}

function tooltipOverflowAllowsScroll(value: string) {
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

function tooltipScrollableAncestors(element: HTMLElement | null) {
  const ancestors: HTMLElement[] = []

  for (
    let candidate = element?.parentElement ?? null;
    candidate !== null;
    candidate = candidate.parentElement
  ) {
    const styles = window.getComputedStyle(candidate)
    const canScrollY =
      tooltipOverflowAllowsScroll(styles.overflowY) &&
      candidate.scrollHeight > candidate.clientHeight
    const canScrollX =
      tooltipOverflowAllowsScroll(styles.overflowX) &&
      candidate.scrollWidth > candidate.clientWidth

    if (canScrollY || canScrollX) {
      ancestors.push(candidate)
    }
  }

  const scrollingElement = document.scrollingElement
  if (scrollingElement instanceof HTMLElement) {
    const alreadyIncluded = ancestors.includes(scrollingElement)
    const canScrollPage =
      scrollingElement.scrollHeight > scrollingElement.clientHeight ||
      scrollingElement.scrollWidth > scrollingElement.clientWidth
    if (!alreadyIncluded && canScrollPage) {
      ancestors.push(scrollingElement)
    }
  }

  return ancestors
}

function tooltipWheelDeltaToPixels(
  delta: number,
  deltaMode: number,
  pageSize: number
) {
  if (deltaMode === TOOLTIP_WHEEL_DELTA_LINE) {
    return delta * TOOLTIP_WHEEL_LINE_HEIGHT_PX
  }
  if (deltaMode === TOOLTIP_WHEEL_DELTA_PAGE) {
    return delta * pageSize
  }
  return delta
}

function tooltipScrollElementByWheel(
  element: HTMLElement,
  event: ReactWheelEvent<HTMLElement>
) {
  const deltaX = tooltipWheelDeltaToPixels(
    event.deltaX,
    event.deltaMode,
    element.clientWidth
  )
  const deltaY = tooltipWheelDeltaToPixels(
    event.deltaY,
    event.deltaMode,
    element.clientHeight
  )
  const previousLeft = element.scrollLeft
  const previousTop = element.scrollTop

  if (deltaX !== 0) {
    element.scrollLeft += deltaX
  }
  if (deltaY !== 0) {
    element.scrollTop += deltaY
  }

  return element.scrollLeft !== previousLeft || element.scrollTop !== previousTop
}

function setTooltipWheelPassthrough(
  element: HTMLElement | null,
  enabled: boolean
) {
  const targets = [element, element?.parentElement]
  for (const target of targets) {
    if (!target) continue
    if (enabled) target.style.setProperty('pointer-events', 'none')
    else target.style.removeProperty('pointer-events')
  }
}

function TooltipProvider({ children }: TooltipProviderProps) {
  return <>{children}</>
}

function Tooltip({
  disableHoverablePopup = false,
  trackCursorAxis = 'none',
  ...props
}: TooltipPrimitive.Root.Props) {
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      disableHoverablePopup={disableHoverablePopup}
      trackCursorAxis={trackCursorAxis}
      {...props}
    />
  )
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  anchor,
  popupRef,
  side = 'bottom',
  sideOffset = 16,
  align = 'start',
  alignOffset = TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX,
  arrowPadding = 0,
  collisionAvoidance = TOOLTIP_COLLISION_AVOIDANCE,
  collisionPadding = 0,
  positionMethod,
  instant = false,
  children,
  onClick,
  onPointerDown,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    | 'align'
    | 'alignOffset'
    | 'anchor'
    | 'arrowPadding'
    | 'collisionAvoidance'
    | 'collisionPadding'
    | 'positionMethod'
    | 'side'
    | 'sideOffset'
  > & {
    instant?: boolean
    popupRef?: Ref<HTMLDivElement>
  }) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        arrowPadding={arrowPadding}
        collisionAvoidance={collisionAvoidance}
        collisionPadding={collisionPadding}
        positionMethod={positionMethod}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          ref={popupRef}
          data-slot="tooltip-content"
          className={cn(
            'z-50 flex w-fit max-w-xs origin-(--transform-origin) flex-col rounded-[10px] bg-[canvas] px-2 py-1 text-sm leading-5 whitespace-normal text-tab-ink shadow-lg shadow-[var(--warm-gray)] outline-1 outline-[var(--warm-gray)] [corner-shape:squircle] [overflow-wrap:anywhere] data-[align=end]:data-[side=bottom]:rounded-tr-none data-[align=end]:data-[side=top]:rounded-br-none data-[align=start]:data-[side=bottom]:rounded-tl-none data-[align=start]:data-[side=top]:rounded-bl-none',
            instant
              ? 'transition-none'
              : 'transition-[transform,opacity] duration-150 data-ending-style:transform-[scale(0.9)] data-ending-style:opacity-0 data-starting-style:transform-[scale(0.9)] data-starting-style:opacity-0',
            className
          )}
          onClick={(event) => {
            onClick?.(event)
            event.stopPropagation()
          }}
          onPointerDown={(event) => {
            onPointerDown?.(event)
            event.stopPropagation()
          }}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

type CursorPoint = {
  x: number
  y: number
}

type TooltipTriggerElement = ReactElement<{
  ref?: Ref<HTMLElement>
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void
}>

type TooltipAnchorProps = Omit<
  ComponentProps<typeof TooltipContent>,
  'children' | 'content'
> & {
  anchorToCursor?: boolean
  content?: ReactNode
  children: TooltipTriggerElement
}

function TooltipAnchor({
  anchorToCursor = true,
  content,
  children,
  onWheel: contentOnWheel,
  ...contentProps
}: TooltipAnchorProps) {
  const anchorId = useId()
  const tooltipActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null)
  const triggerElementRef = useRef<HTMLElement | null>(null)
  const popupElementRef = useRef<HTMLDivElement | null>(null)
  const latestPointerPointRef = useRef<CursorPoint | null>(null)
  const hoverDelayRef = useRef(TOOLTIP_INITIAL_REST_DELAY_MS)
  const pointerInsideRef = useRef(false)
  const pointerFocusedRef = useRef(false)
  const popupPointerInsideRef = useRef(false)
  const hoverOpenBlockedUntilRef = useRef(0)
  const hoverCloseScheduledRef = useRef(false)
  const retimeFrozenPointerClear = useRetimer()
  const retimeHoverOpen = useRetimer()
  const retimeHoverClose = useRetimer()
  const [frozenPointerPoint, setFrozenPointerPoint] =
    useState<CursorPoint | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const closeInstantly = contentProps.instant === true

  const clearHoverCloseTimer = useCallback(() => {
    hoverCloseScheduledRef.current = false
    retimeHoverClose()
  }, [retimeHoverClose])

  const clearFrozenPointerPointAfterClose = useCallback(() => {
    retimeFrozenPointerClear(
      window.setTimeout(() => {
        setFrozenPointerPoint(null)
      }, TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS)
    )
  }, [retimeFrozenPointerClear])

  useEffect(
    () => () => {
      retimeFrozenPointerClear()
      clearHoverCloseTimer()
      retimeHoverOpen()
      if (activeTooltipAnchorId === anchorId) {
        activeTooltipAnchorId = null
        latestTooltipActivityAt = now()
      }
    },
    [anchorId, clearHoverCloseTimer, retimeFrozenPointerClear, retimeHoverOpen]
  )

  const closeTooltip = useCallback(() => {
    retimeHoverOpen()
    clearHoverCloseTimer()
    if (closeInstantly) {
      flushSync(() => setTooltipOpen(false))
      tooltipActionsRef.current?.unmount()
    } else {
      setTooltipOpen(false)
    }
    if (activeTooltipAnchorId === anchorId) {
      activeTooltipAnchorId = null
      latestTooltipActivityAt = now()
    }
    clearFrozenPointerPointAfterClose()
  }, [anchorId, clearFrozenPointerPointAfterClose, clearHoverCloseTimer, closeInstantly, retimeHoverOpen])

  const openTooltip = useCallback((point: CursorPoint | null) => {
    retimeHoverOpen()
    clearHoverCloseTimer()
    if (point !== null && now() < wheelClosedTooltipBlockedUntil) return
    if (point !== null && now() < hoverOpenBlockedUntilRef.current) return
    if (!pointerInsideRef.current && point !== null) return

    setTooltipWheelPassthrough(popupElementRef.current, false)
    activeTooltipAnchorId = anchorId
    latestTooltipActivityAt = now()
    setFrozenPointerPoint(point)
    setTooltipOpen(true)
  }, [anchorId, clearHoverCloseTimer, retimeHoverOpen])

  const scheduleHoverClose = useCallback(() => {
    retimeHoverOpen()
    clearHoverCloseTimer()

    hoverCloseScheduledRef.current = true
    retimeHoverClose(window.setTimeout(() => {
      hoverCloseScheduledRef.current = false
      if (pointerInsideRef.current || popupPointerInsideRef.current) return

      closeTooltip()
    }, TOOLTIP_HOVERABLE_CLOSE_DELAY_MS))
  }, [clearHoverCloseTimer, closeTooltip, retimeHoverClose, retimeHoverOpen])

  const updateLatestPointerPoint = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      latestPointerPointRef.current = {
        x: event.clientX,
        y: event.clientY
      }
    },
    []
  )

  const scheduleHoverOpen = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      updateLatestPointerPoint(event)
      retimeHoverOpen()

      const point = latestPointerPointRef.current
      retimeHoverOpen(window.setTimeout(() => {
        openTooltip(point)
      }, hoverDelayRef.current))
    },
    [openTooltip, retimeHoverOpen, updateLatestPointerPoint]
  )

  useEffect(() => {
    if (!tooltipOpen) return

    const closeFromGlobalEvent = () => {
      pointerInsideRef.current = false
      popupPointerInsideRef.current = false
      hoverOpenBlockedUntilRef.current = now() + TOOLTIP_GLOBAL_CLOSE_REOPEN_BLOCK_MS
      closeTooltip()
    }
    const handleScroll = () => closeFromGlobalEvent()
    const handleWindowBlur = () => closeFromGlobalEvent()
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') closeFromGlobalEvent()
    }
    const isTooltipRegionActive = () => {
      const triggerElement = triggerElementRef.current
      const popupElement = popupElementRef.current
      const activeElement = document.activeElement
      const triggerHasFocus =
        !pointerFocusedRef.current &&
        activeElement instanceof Node &&
        !!triggerElement?.contains(activeElement)

      return !!(
        triggerHasFocus ||
        triggerElement?.matches(':hover') ||
        popupElement?.matches(':hover')
      )
    }
    const handlePointerOrMouseMove = (event: PointerEvent | MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null
      const isInsideTooltipRegion =
        target !== null &&
        (triggerElementRef.current?.contains(target) ||
          popupElementRef.current?.contains(target))

      if (isInsideTooltipRegion) return

      pointerInsideRef.current = false
      popupPointerInsideRef.current = false
      if (!hoverCloseScheduledRef.current) {
        scheduleHoverClose()
      }
    }
    const hoverWatchId = window.setInterval(() => {
      if (isTooltipRegionActive()) {
        clearHoverCloseTimer()
        return
      }
      if (!hoverCloseScheduledRef.current) {
        scheduleHoverClose()
      }
    }, TOOLTIP_HOVER_WATCH_INTERVAL_MS)

    window.addEventListener('scroll', handleScroll, true)
    document.addEventListener('scroll', handleScroll, true)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('pointermove', handlePointerOrMouseMove, true)
    window.addEventListener('mousemove', handlePointerOrMouseMove, true)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    document.addEventListener('pointermove', handlePointerOrMouseMove, true)
    document.addEventListener('mousemove', handlePointerOrMouseMove, true)
    return () => {
      window.clearInterval(hoverWatchId)
      window.removeEventListener('scroll', handleScroll, true)
      document.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('pointermove', handlePointerOrMouseMove, true)
      window.removeEventListener('mousemove', handlePointerOrMouseMove, true)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      document.removeEventListener('pointermove', handlePointerOrMouseMove, true)
      document.removeEventListener('mousemove', handlePointerOrMouseMove, true)
    }
  }, [clearHoverCloseTimer, closeTooltip, scheduleHoverClose, tooltipOpen])

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event)
      if (now() < hoverOpenBlockedUntilRef.current) return
      pointerInsideRef.current = true
      clearHoverCloseTimer()
      hoverDelayRef.current = shouldUseAdjacentTooltipDelay(anchorId)
        ? TOOLTIP_ADJACENT_REST_DELAY_MS
        : TOOLTIP_INITIAL_REST_DELAY_MS
      scheduleHoverOpen(event)
    },
    [anchorId, children.props, clearHoverCloseTimer, scheduleHoverOpen]
  )

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerDown?.(event)
      pointerFocusedRef.current = true
      closeTooltip()
    },
    [children.props, closeTooltip]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerMove?.(event)
      if (now() < hoverOpenBlockedUntilRef.current) return
      if (!pointerInsideRef.current) {
        pointerInsideRef.current = true
      }
      if (tooltipOpen) {
        updateLatestPointerPoint(event)
        return
      }
      scheduleHoverOpen(event)
    },
    [children.props, scheduleHoverOpen, tooltipOpen, updateLatestPointerPoint]
  )

  const handlePointerLeave = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerLeave?.(event)
      pointerInsideRef.current = false
      if (tooltipOpen) {
        scheduleHoverClose()
      } else {
        closeTooltip()
      }
    },
    [children.props, closeTooltip, scheduleHoverClose, tooltipOpen]
  )

  const handleFocus = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onFocus?.(event)
      const focusVisible = event.currentTarget.matches(':focus-visible')
      pointerFocusedRef.current = !focusVisible
      if (!focusVisible) return
      openTooltip(null)
    },
    [children.props, openTooltip]
  )

  const handleBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event)
      pointerFocusedRef.current = false
      closeTooltip()
    },
    [children.props, closeTooltip]
  )

  const markContentPointerInside = useCallback(() => {
    setTooltipWheelPassthrough(popupElementRef.current, false)
    pointerInsideRef.current = false
    popupPointerInsideRef.current = true
    clearHoverCloseTimer()
  }, [clearHoverCloseTimer])

  const markContentPointerOutside = useCallback(() => {
    popupPointerInsideRef.current = false
    scheduleHoverClose()
  }, [scheduleHoverClose])

  const handleContentPointerEnter = useCallback(
    (_event: ReactPointerEvent<HTMLDivElement>) => {
      markContentPointerInside()
    },
    [markContentPointerInside]
  )

  const handleContentPointerLeave = useCallback(
    (_event: ReactPointerEvent<HTMLDivElement>) => {
      markContentPointerOutside()
    },
    [markContentPointerOutside]
  )

  const handleContentMouseEnter = useCallback(
    (_event: ReactMouseEvent<HTMLDivElement>) => {
      markContentPointerInside()
    },
    [markContentPointerInside]
  )

  const handleContentMouseLeave = useCallback(
    (_event: ReactMouseEvent<HTMLDivElement>) => {
      markContentPointerOutside()
    },
    [markContentPointerOutside]
  )

  const handleContentWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      contentOnWheel?.(
        event as Parameters<NonNullable<typeof contentOnWheel>>[0]
      )
      if (event.defaultPrevented) return

      const scrollContainers = tooltipScrollableAncestors(
        triggerElementRef.current
      )
      for (const scrollContainer of scrollContainers) {
        if (tooltipScrollElementByWheel(scrollContainer, event)) {
          setTooltipWheelPassthrough(popupElementRef.current, true)
          pointerInsideRef.current = false
          popupPointerInsideRef.current = false
          wheelClosedTooltipBlockedUntil =
            now() + TOOLTIP_WHEEL_CLOSE_REOPEN_BLOCK_MS
          hoverOpenBlockedUntilRef.current =
            now() + TOOLTIP_GLOBAL_CLOSE_REOPEN_BLOCK_MS
          closeTooltip()
          event.preventDefault()
          event.stopPropagation()
          return
        }
      }
    },
    [closeTooltip, contentOnWheel]
  )

  const triggerRef = useMemo(
    () => mergeRefs<HTMLElement>(children.props.ref, triggerElementRef),
    [children.props.ref]
  )

  const trigger = useMemo(
    () =>
      cloneElement(children, {
        onBlur: handleBlur,
        onFocus: handleFocus,
        onPointerDown: handlePointerDown,
        onPointerEnter: handlePointerEnter,
        onPointerLeave: handlePointerLeave,
        onPointerMove: handlePointerMove,
        ref: triggerRef
      }),
    [children, handleBlur, handleFocus, handlePointerDown, handlePointerEnter, handlePointerLeave, handlePointerMove, triggerRef]
  )

  const cursorAnchor = useMemo(() => {
    if (!frozenPointerPoint) return undefined

    return {
      getBoundingClientRect: () =>
        new DOMRect(frozenPointerPoint.x, frozenPointerPoint.y, 0, 0)
    }
  }, [frozenPointerPoint])
  const tooltipAnchor = anchorToCursor ? cursorAnchor : undefined

  if (content === null || content === undefined || content === '') return children

  return (
    <Tooltip actionsRef={tooltipActionsRef} open={tooltipOpen}>
      <TooltipTrigger render={trigger} disabled />
      <TooltipContent
        anchor={tooltipAnchor}
        popupRef={popupElementRef}
        positionMethod={tooltipAnchor ? 'fixed' : undefined}
        onMouseEnter={handleContentMouseEnter}
        onMouseLeave={handleContentMouseLeave}
        onPointerEnter={handleContentPointerEnter}
        onPointerLeave={handleContentPointerLeave}
        onWheel={handleContentWheel}
        {...contentProps}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipAnchor }
