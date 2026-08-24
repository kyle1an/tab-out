import { useEffect, useRef } from 'react'
import { createTitleExpansionController } from './controller'
import type { TitleExpansionController, TitleExpansionLane } from './controller'

export type UseTitleExpansionControllerOptions = {
  id: string
  lane: TitleExpansionLane
  closeDelayMs: number
  onExpandedChange: (expanded: boolean) => void
}

/**
 * React binding for the Title Expansion controller. Returns a stable
 * facade; the real controller (which subscribes to the lane) is created
 * lazily on first use so render stays side-effect free, reads the latest
 * options through a ref, and is disposed (and recreated on demand) when
 * the owner unmounts.
 */
export function useTitleExpansionController(options: UseTitleExpansionControllerOptions): TitleExpansionController {
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  })

  const instanceRef = useRef<TitleExpansionController | null>(null)
  const facadeRef = useRef<TitleExpansionController | null>(null)
  if (facadeRef.current === null) {
    const getInstance = (): TitleExpansionController => {
      if (instanceRef.current === null) {
        const { id, lane, closeDelayMs } = optionsRef.current
        instanceRef.current = createTitleExpansionController({
          id,
          lane,
          closeDelayMs,
          onExpandedChange: (expanded) => optionsRef.current.onExpandedChange(expanded),
        })
      }
      return instanceRef.current
    }
    facadeRef.current = {
      open: () => getInstance().open(),
      close: (closeOptions) => getInstance().close(closeOptions),
      closeNow: () => getInstance().closeNow(),
      cancelPendingClose: () => instanceRef.current?.cancelPendingClose(),
      hold: (owner) => getInstance().hold(owner),
      isExpanded: () => instanceRef.current?.isExpanded() ?? false,
      dispose: () => {
        instanceRef.current?.dispose()
        instanceRef.current = null
      },
    }
  }

  useEffect(() => {
    const facade = facadeRef.current
    return () => facade?.dispose()
  }, [])

  return facadeRef.current
}
