import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { closeExactTabSection, suspendExactTabSection } from '../extension/tab-actions'
import { pointerIsOverElement, startPointerPositionTracking } from './pointer-position'
import { titleSuppressionKey, titleSuppressionTokenToneClass } from './title-suppression'
import { useDomainCardContext } from './DomainCardContext'
import { TitleSuppressionTokenContextMenu } from './TitleSuppressionTokenContextMenu'
import type { DashboardTitleSuppression } from './types'

interface TitleSuppressionSummaryProps {
  suppressedTitleParts: DashboardTitleSuppression[]
  activeSuppressedTitle: string
  setActiveSuppressedTitle: (text: string) => void
  useSuppressionTokenTones: boolean
  suppressedTitleToneIndexByText: ReadonlyMap<string, number>
  className?: string
}

export function TitleSuppressionSummary({
  suppressedTitleParts,
  activeSuppressedTitle,
  setActiveSuppressedTitle,
  useSuppressionTokenTones,
  suppressedTitleToneIndexByText,
  className
}: TitleSuppressionSummaryProps) {
  const { suppressionCloseUrlsByText, suppressionSuspendUrlsByText } = useDomainCardContext()
  // Synchronous flag for which token's context menu is open. Base UI's context menu
  // opens a full-screen backdrop that steals the pointer/focus, firing the token's
  // mouseLeave/blur right after onOpenChange sets the highlight. A ref (not state)
  // lets those handlers see "my menu is open" the same tick and skip clearing it.
  const openMenuTextRef = useRef('')
  const tokenButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => { startPointerPositionTracking() }, [])
  if (suppressedTitleParts.length === 0) return null

  return (
    <div className={cn('title-suppression-summary flex flex-wrap items-center gap-1 text-xs leading-4 text-tab-muted', className)}>
      {suppressedTitleParts.map((part, index) => {
        const label = `Suppressed in ${part.count} title${part.count !== 1 ? 's' : ''}: ${part.text}`
        const active = activeSuppressedTitle === part.text
        const toneIndex = suppressedTitleToneIndexByText.get(titleSuppressionKey(part.text)) ?? index
        const closableUrls = suppressionCloseUrlsByText[titleSuppressionKey(part.text)] ?? []
        const suspendableUrls = suppressionSuspendUrlsByText[titleSuppressionKey(part.text)] ?? []
        const tokenButton = (
          <button
            key={part.text}
            ref={(el) => { const map = tokenButtonsRef.current; if (el) map.set(part.text, el); else map.delete(part.text) }}
            type="button"
            className={cn(
              'title-suppression-token inline-flex h-5 items-center gap-1 rounded-[6px] border border-transparent bg-neutral-100 px-1.5 py-0 text-xs leading-none font-medium text-tab-muted transition-[background,border-color,color,box-shadow] duration-150 [corner-shape:squircle] hover:border-yellow-200 hover:bg-yellow-50 hover:text-tab-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-yellow-400',
              titleSuppressionTokenToneClass(toneIndex, useSuppressionTokenTones, active)
            )}
            aria-label={label}
            onMouseEnter={() => setActiveSuppressedTitle(part.text)}
            onMouseLeave={() => { if (openMenuTextRef.current !== part.text) setActiveSuppressedTitle('') }}
            // Only keyboard focus highlights — not the mouse-modality focus Base UI
            // restores to this button when its context menu closes (that would re-show
            // the highlight after the user clicked away).
            onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) setActiveSuppressedTitle(part.text) }}
            onBlur={() => { if (openMenuTextRef.current !== part.text) setActiveSuppressedTitle('') }}
          >
            <span className="title-suppression-token-text max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap">{part.text}</span>
            {part.count > 1 && <span className="title-suppression-token-count tabular-nums opacity-65">{part.count}</span>}
          </button>
        )

        if (closableUrls.length === 0 && suspendableUrls.length === 0) return tokenButton

        return (
          <TitleSuppressionTokenContextMenu
            key={part.text}
            closableCount={closableUrls.length}
            suspendableCount={suspendableUrls.length}
            onOpenChange={(open) => {
              openMenuTextRef.current = open ? part.text : ''
              if (open) {
                setActiveSuppressedTitle(part.text)
              } else {
                // On close Base UI restores focus to the token and may re-expose it under
                // the pointer. Set the final highlight in one step — kept only if the
                // pointer is genuinely over the token — so a closing click on the token
                // doesn't clear-then-rehighlight (a visible flash).
                setActiveSuppressedTitle(pointerIsOverElement(tokenButtonsRef.current.get(part.text)) ? part.text : '')
              }
            }}
            onSuspend={suspendableUrls.length > 0 ? async (event) => {
              event.stopPropagation()
              await suspendExactTabSection({ urls: suspendableUrls })
            } : undefined}
            onClose={async (event) => {
              event.stopPropagation()
              await closeExactTabSection({ urls: closableUrls })
            }}
          >
            {tokenButton}
          </TitleSuppressionTokenContextMenu>
        )
      })}
    </div>
  )
}
