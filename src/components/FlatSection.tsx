import { useState } from 'react'
import { useDomainCardContext } from './DomainCardContext'
import { PageChip } from './PageChip'
import { cn } from '@/lib/utils'
import { TITLE_SUPPRESSION_MARKER_SYMBOL, countHiddenSuppressedTitleMatches, titleSuppressionBadgeClass, titleSuppressionOverflowHighlightClass, titleSuppressionToneForText } from './title-suppression'
import type { TitleSuppressionTone } from './title-suppression'
import type { DashboardChipData } from './types'

interface FlatSectionProps {
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  afterSeparator?: boolean
  filter?: string
  suppressedTitleToneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
}

export function FlatSection({ visibleChips, hiddenChips, hiddenCount, afterSeparator = false, filter = '', suppressedTitleToneByText }: FlatSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const { activeSuppressedTitle, onLayoutChange } = useDomainCardContext()
  const iconOnly = visibleChips.length > 0 && visibleChips.every((chip) => chip.iconOnly)
  const activeSuppressionTone = titleSuppressionToneForText(activeSuppressedTitle, suppressedTitleToneByText)
  const hiddenSuppressionMatchCount = countHiddenSuppressedTitleMatches(hiddenChips, activeSuppressedTitle)
  const hiddenSuppressionCoversAll = hiddenSuppressionMatchCount > 0 && hiddenSuppressionMatchCount === hiddenCount

  function onExpand() {
    setExpanded(true)
    if (onLayoutChange) onLayoutChange()
  }

  return (
    <div
      className={cn(
        'flat-section flex flex-col',
        afterSeparator && 'mt-1.5',
        iconOnly && 'flat-section-icons flex-row flex-wrap gap-2.5'
      )}
      data-expanded={expanded ? 'true' : undefined}
    >
      {visibleChips.map((chip) => (
        <PageChip key={chip.rawUrl} chip={chip} filter={filter} suppressedTitleToneByText={suppressedTitleToneByText} />
      ))}
      {hiddenCount > 0 && (
        <div className={cn('page-chips-overflow', iconOnly && 'w-full', iconOnly && expanded && 'flex flex-wrap gap-2.5')}>
          {hiddenChips.map((chip) => (
            <PageChip key={chip.rawUrl} chip={chip} filter={filter} suppressedTitleToneByText={suppressedTitleToneByText} />
          ))}
        </div>
      )}
      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          className={cn(
            "page-chip page-chip-overflow clickable relative flex cursor-pointer items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 text-left text-[13px] leading-tight tabular-nums text-tab-muted [font-family:inherit] [corner-shape:squircle] transition-colors duration-150 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--group-color,transparent)] before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,color-mix(in_srgb,var(--card-bg)_96%,rgb(82_82_82))_50%)] after:opacity-0 after:transition-opacity after:duration-200 after:ease-[ease] after:[corner-shape:squircle] after:content-[''] hover:bg-[rgba(82,82,82,0.04)] [&:has(.chip-actions):hover::after]:opacity-100",
            hiddenSuppressionCoversAll && cn('page-chip-overflow-suppression-highlighted', titleSuppressionOverflowHighlightClass(activeSuppressionTone)),
            iconOnly ? 'pl-1' : 'pl-3'
          )}
          onClick={onExpand}
        >
          <span className="chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal text-[13px] max-h-[calc(2lh)] [hyphenate-character:'']">+{hiddenCount} more</span>
          {hiddenSuppressionMatchCount > 0 && (
            <span className={cn("page-chip-overflow-suppression-badge relative z-[2] inline-flex h-4 min-w-4 items-center justify-center rounded-lg border border-transparent px-1 text-xs leading-none font-semibold text-tab-ink [corner-shape:squircle]", titleSuppressionBadgeClass(activeSuppressionTone))}>
              {TITLE_SUPPRESSION_MARKER_SYMBOL}{hiddenSuppressionMatchCount}
            </span>
          )}
        </button>
      )}
    </div>
  )
}
