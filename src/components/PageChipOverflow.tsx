import { useEffect, useId, useLayoutEffect, useState, type ReactNode, type TransitionEvent } from 'react'
import { pageTargetMatchesHover } from '../extension/page-target.js'
import { useDomainCardContext } from './DomainCardContext'
import { useDashboardActions, useHoverState } from './DashboardInteractionContext'
import { PageChip } from './PageChip'
import { cn } from '@/lib/utils'
import { TITLE_SUPPRESSION_MARKER_SYMBOL, countHiddenSuppressedTitleMatches, titleSuppressionBadgeClass, titleSuppressionOverflowHighlightClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import type { DashboardChipData } from './types'

type OverflowContainerClassName =
  | string
  | ((state: { expanded: boolean }) => string | undefined)

interface PageChipOverflowOptions {
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  filter?: string
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>
  overflowContainerClassName?: OverflowContainerClassName
  overflowButtonClassName?: string
}

const OVERFLOW_BUTTON_CLASS_NAME =
  "page-chip page-chip-overflow clickable relative flex cursor-pointer items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 text-left text-[13px] leading-tight tabular-nums text-muted-foreground [font-family:inherit] [corner-shape:squircle] transition-[color,box-shadow,opacity] duration-100 ease-swift before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-(--group-color,transparent) before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,color-mix(in_srgb,var(--card-bg)_92%,rgb(82_82_82))_50%)] after:opacity-0 after:[corner-shape:squircle] after:content-[''] hover:bg-[rgba(82,82,82,0.08)] [&:has(.chip-actions):hover::after]:opacity-100"

function resolveClassName(className: OverflowContainerClassName | undefined, expanded: boolean) {
  return typeof className === 'function' ? className({ expanded }) : className
}

function chipMatchesActiveHover(chip: DashboardChipData, activeHoverUrl: string, activeHoverUrls: readonly string[]): boolean {
  return (
    pageTargetMatchesHover(chip, activeHoverUrl, activeHoverUrls) ||
    !!chip.titleVariantChips?.some((variant) => chipMatchesActiveHover(variant, activeHoverUrl, activeHoverUrls)) ||
    !!chip.envs?.some((env) => (
      pageTargetMatchesHover(env, activeHoverUrl, activeHoverUrls)
    ))
  )
}

export function usePageChipOverflow({
  visibleChips,
  hiddenChips,
  hiddenCount,
  filter = '',
  suppressedTitleToneByText,
  overflowContainerClassName,
  overflowButtonClassName
}: PageChipOverflowOptions): { expanded: boolean; pageChips: ReactNode } {
  const [expansionPhase, setExpansionPhase] = useState<'collapsed' | 'fading' | 'expanded'>('collapsed')
  const layoutScope = `page-chip:${useId()}`
  const expanded = expansionPhase === 'expanded'
  const { activeSuppressedTitle } = useDomainCardContext()
  const { url: activeHoverUrl, urls: activeHoverUrls, source: activeHoverSource } = useHoverState()
  const { onLayoutChange } = useDashboardActions()
  const activeSuppressionTone = titleSuppressionToneForText(activeSuppressedTitle, suppressedTitleToneByText)
  const hiddenSuppressionMatchCount = countHiddenSuppressedTitleMatches(hiddenChips, activeSuppressedTitle)
  const hiddenSuppressionCoversAll = hiddenSuppressionMatchCount > 0 && hiddenSuppressionMatchCount === hiddenCount
  const hiddenHoverMatched = !!activeHoverSource && activeHoverSource !== 'chip' && !!activeHoverUrl && hiddenChips.some((chip) => chipMatchesActiveHover(chip, activeHoverUrl, activeHoverUrls))

  function finishExpansion() {
    setExpansionPhase('expanded')
  }

  function onExpand() {
    if (expansionPhase !== 'collapsed') return
    setExpansionPhase('fading')
  }

  function onExpanderTransitionEnd(e: TransitionEvent<HTMLButtonElement>) {
    if (e.target !== e.currentTarget || e.propertyName !== 'opacity') return
    finishExpansion()
  }

  useEffect(() => {
    if (expansionPhase !== 'fading') return
    const fallback = window.setTimeout(() => {
      setExpansionPhase('expanded')
    }, 140)
    return () => window.clearTimeout(fallback)
  }, [expansionPhase])

  useLayoutEffect(() => {
    if (expansionPhase !== 'expanded') return
    onLayoutChange?.()
  }, [expansionPhase, onLayoutChange])

  const pageChips = (
    <>
      {visibleChips.map((chip) => (
        <PageChip key={chip.rawUrl} chip={chip} filter={filter} layoutScope={layoutScope} suppressedTitleToneByText={suppressedTitleToneByText} />
      ))}
      {hiddenCount > 0 && (
        <div className={cn('page-chips-overflow page-chips-overflow-reveal', resolveClassName(overflowContainerClassName, expanded), expanded ? 'contents' : 'hidden')}>
          {hiddenChips.map((chip) => (
            <PageChip key={chip.rawUrl} chip={chip} filter={filter} layoutScope={layoutScope} suppressedTitleToneByText={suppressedTitleToneByText} />
          ))}
        </div>
      )}
      {expansionPhase !== 'expanded' && hiddenCount > 0 && (
        <button
          type="button"
          data-tabout-part="overflow-expander"
          className={cn(
            OVERFLOW_BUTTON_CLASS_NAME,
            expansionPhase === 'fading' && 'pointer-events-none opacity-0',
            hiddenHoverMatched && 'page-chip-overflow-hover-match outline outline-1 outline-offset-1 outline-(--accent-amber)',
            hiddenSuppressionCoversAll && cn('page-chip-overflow-suppression-highlighted', titleSuppressionOverflowHighlightClass(activeSuppressionTone)),
            overflowButtonClassName
          )}
          onClick={onExpand}
          onTransitionEnd={onExpanderTransitionEnd}
        >
          <span className="chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal text-[13px] max-h-[calc(2lh)] [hyphenate-character:'']">+{hiddenCount} more</span>
          {hiddenSuppressionMatchCount > 0 && (
            <span className={cn("page-chip-overflow-suppression-badge relative z-2 inline-flex h-4 min-w-4 items-center justify-center rounded-lg border border-transparent px-1 text-xs leading-none font-semibold text-foreground [corner-shape:squircle]", titleSuppressionBadgeClass(activeSuppressionTone))}>
              {TITLE_SUPPRESSION_MARKER_SYMBOL}{hiddenSuppressionMatchCount}
            </span>
          )}
        </button>
      )}
    </>
  )

  return { expanded, pageChips }
}
