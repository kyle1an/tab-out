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
  ReactNode
} from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'

import { cn } from '@/lib/utils'

const TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS = 200
const TOOLTIP_INITIAL_REST_DELAY_MS = 500
const TOOLTIP_ADJACENT_REST_DELAY_MS = 180
const TOOLTIP_ADJACENT_REST_WINDOW_MS = 700
const TOOLTIP_HOVERABLE_CLOSE_DELAY_MS = 160
const TOOLTIP_HOVER_WATCH_INTERVAL_MS = 80
const TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX = 1
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
  sideOffset = 10,
  align = 'start',
  alignOffset = TOOLTIP_EDGE_BORDER_ALIGN_OFFSET_PX,
  arrowPadding = 0,
  collisionAvoidance = TOOLTIP_COLLISION_AVOIDANCE,
  collisionPadding = 0,
  positionMethod,
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
            'z-50 flex w-fit max-w-xs origin-(--transform-origin) flex-col rounded-[10px] bg-[canvas] px-2 py-1 text-sm leading-5 whitespace-normal text-tab-ink shadow-lg shadow-[var(--warm-gray)] outline-1 outline-[var(--warm-gray)] transition-[transform,opacity] duration-150 [corner-shape:squircle] [overflow-wrap:anywhere] data-[align=end]:data-[side=bottom]:rounded-tr-none data-[align=end]:data-[side=top]:rounded-br-none data-[align=start]:data-[side=bottom]:rounded-tl-none data-[align=start]:data-[side=top]:rounded-bl-none data-ending-style:transform-[scale(0.9)] data-ending-style:opacity-0 data-instant:transition-none data-starting-style:transform-[scale(0.9)] data-starting-style:opacity-0',
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
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void
}>

type TooltipAnchorProps = Omit<
  ComponentProps<typeof TooltipContent>,
  'children' | 'content'
> & {
  content?: ReactNode
  children: TooltipTriggerElement
}

function TooltipAnchor({
  content,
  children,
  ...contentProps
}: TooltipAnchorProps) {
  const anchorId = useId()
  const triggerElementRef = useRef<HTMLElement | null>(null)
  const popupElementRef = useRef<HTMLDivElement | null>(null)
  const latestPointerPointRef = useRef<CursorPoint | null>(null)
  const frozenPointerClearTimerRef = useRef<number | null>(null)
  const hoverOpenTimerRef = useRef<number | null>(null)
  const hoverCloseTimerRef = useRef<number | null>(null)
  const hoverDelayRef = useRef(TOOLTIP_INITIAL_REST_DELAY_MS)
  const pointerInsideRef = useRef(false)
  const popupPointerInsideRef = useRef(false)
  const [frozenPointerPoint, setFrozenPointerPoint] =
    useState<CursorPoint | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)

  const clearFrozenPointerClearTimer = useCallback(() => {
    if (frozenPointerClearTimerRef.current === null) return

    window.clearTimeout(frozenPointerClearTimerRef.current)
    frozenPointerClearTimerRef.current = null
  }, [])

  const clearHoverOpenTimer = useCallback(() => {
    if (hoverOpenTimerRef.current === null) return

    window.clearTimeout(hoverOpenTimerRef.current)
    hoverOpenTimerRef.current = null
  }, [])

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current === null) return

    window.clearTimeout(hoverCloseTimerRef.current)
    hoverCloseTimerRef.current = null
  }, [])

  const clearFrozenPointerPointAfterClose = useCallback(() => {
    clearFrozenPointerClearTimer()
    frozenPointerClearTimerRef.current = window.setTimeout(() => {
      setFrozenPointerPoint(null)
      frozenPointerClearTimerRef.current = null
    }, TOOLTIP_CLOSE_ANCHOR_CLEAR_DELAY_MS)
  }, [clearFrozenPointerClearTimer])

  useEffect(
    () => () => {
      clearFrozenPointerClearTimer()
      clearHoverCloseTimer()
      clearHoverOpenTimer()
      if (activeTooltipAnchorId === anchorId) {
        activeTooltipAnchorId = null
        latestTooltipActivityAt = now()
      }
    },
    [anchorId, clearFrozenPointerClearTimer, clearHoverCloseTimer, clearHoverOpenTimer]
  )

  const closeTooltip = useCallback(() => {
    clearHoverOpenTimer()
    clearHoverCloseTimer()
    setTooltipOpen(false)
    if (activeTooltipAnchorId === anchorId) {
      activeTooltipAnchorId = null
      latestTooltipActivityAt = now()
    }
    clearFrozenPointerPointAfterClose()
  }, [anchorId, clearFrozenPointerPointAfterClose, clearHoverCloseTimer, clearHoverOpenTimer])

  const openTooltip = useCallback((point: CursorPoint | null) => {
    clearHoverOpenTimer()
    clearHoverCloseTimer()
    if (!pointerInsideRef.current && point !== null) return

    activeTooltipAnchorId = anchorId
    latestTooltipActivityAt = now()
    setFrozenPointerPoint(point)
    setTooltipOpen(true)
  }, [anchorId, clearHoverCloseTimer, clearHoverOpenTimer])

  const scheduleHoverClose = useCallback(() => {
    clearHoverOpenTimer()
    clearHoverCloseTimer()

    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null
      if (pointerInsideRef.current || popupPointerInsideRef.current) return

      closeTooltip()
    }, TOOLTIP_HOVERABLE_CLOSE_DELAY_MS)
  }, [clearHoverCloseTimer, clearHoverOpenTimer, closeTooltip])

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
      clearHoverOpenTimer()

      const point = latestPointerPointRef.current
      hoverOpenTimerRef.current = window.setTimeout(() => {
        openTooltip(point)
        hoverOpenTimerRef.current = null
      }, hoverDelayRef.current)
    },
    [clearHoverOpenTimer, openTooltip, updateLatestPointerPoint]
  )

  useEffect(() => {
    if (!tooltipOpen) return

    const handleScroll = () => closeTooltip()
    const isTooltipRegionActive = () => {
      const triggerElement = triggerElementRef.current
      const popupElement = popupElementRef.current
      const activeElement = document.activeElement
      const triggerHasFocus =
        activeElement instanceof Node && !!triggerElement?.contains(activeElement)

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
      if (hoverCloseTimerRef.current === null) {
        scheduleHoverClose()
      }
    }
    const hoverWatchId = window.setInterval(() => {
      if (isTooltipRegionActive()) {
        clearHoverCloseTimer()
        return
      }
      if (hoverCloseTimerRef.current === null) {
        scheduleHoverClose()
      }
    }, TOOLTIP_HOVER_WATCH_INTERVAL_MS)

    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('pointermove', handlePointerOrMouseMove, true)
    window.addEventListener('mousemove', handlePointerOrMouseMove, true)
    document.addEventListener('pointermove', handlePointerOrMouseMove, true)
    document.addEventListener('mousemove', handlePointerOrMouseMove, true)
    return () => {
      window.clearInterval(hoverWatchId)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('pointermove', handlePointerOrMouseMove, true)
      window.removeEventListener('mousemove', handlePointerOrMouseMove, true)
      document.removeEventListener('pointermove', handlePointerOrMouseMove, true)
      document.removeEventListener('mousemove', handlePointerOrMouseMove, true)
    }
  }, [clearHoverCloseTimer, closeTooltip, scheduleHoverClose, tooltipOpen])

  const handlePointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerEnter?.(event)
      pointerInsideRef.current = true
      clearHoverCloseTimer()
      hoverDelayRef.current = shouldUseAdjacentTooltipDelay(anchorId)
        ? TOOLTIP_ADJACENT_REST_DELAY_MS
        : TOOLTIP_INITIAL_REST_DELAY_MS
      scheduleHoverOpen(event)
    },
    [anchorId, children.props, clearHoverCloseTimer, scheduleHoverOpen]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      children.props.onPointerMove?.(event)
      if (!pointerInsideRef.current) return
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
      openTooltip(null)
    },
    [children.props, openTooltip]
  )

  const handleBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      children.props.onBlur?.(event)
      closeTooltip()
    },
    [children.props, closeTooltip]
  )

  const markContentPointerInside = useCallback(() => {
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

  const trigger = useMemo(
    () =>
      cloneElement(children, {
        onBlur: handleBlur,
        onFocus: handleFocus,
        onPointerEnter: handlePointerEnter,
        onPointerLeave: handlePointerLeave,
        onPointerMove: handlePointerMove,
        ref: triggerElementRef
      }),
    [children, handleBlur, handleFocus, handlePointerEnter, handlePointerLeave, handlePointerMove]
  )

  const cursorAnchor = useMemo(() => {
    if (!frozenPointerPoint) return undefined

    return {
      getBoundingClientRect: () =>
        new DOMRect(frozenPointerPoint.x, frozenPointerPoint.y, 0, 0)
    }
  }, [frozenPointerPoint])

  if (content === null || content === undefined || content === '') return children

  return (
    <Tooltip open={tooltipOpen}>
      <TooltipTrigger render={trigger} disabled />
      <TooltipContent
        anchor={cursorAnchor}
        popupRef={popupElementRef}
        positionMethod={cursorAnchor ? 'fixed' : undefined}
        onMouseEnter={handleContentMouseEnter}
        onMouseLeave={handleContentMouseLeave}
        onPointerEnter={handleContentPointerEnter}
        onPointerLeave={handleContentPointerLeave}
        {...contentProps}
      >
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipAnchor }
