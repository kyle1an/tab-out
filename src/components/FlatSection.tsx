import { useState } from 'react'
import { PageChip } from './PageChip'
import { Button } from './ui/Button'
import { cn } from '../lib/cn'
import type { DashboardChipData, HoverUrlChangeHandler, LayoutChangeHandler } from './types'

interface FlatSectionProps {
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  afterSeparator?: boolean
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
}

export function FlatSection({ visibleChips, hiddenChips, hiddenCount, afterSeparator = false, onHoverUrlChange = null, onLayoutChange = null }: FlatSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const iconOnly = visibleChips.length > 0 && visibleChips.every((chip) => chip.iconOnly)

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
        <PageChip key={chip.rawUrl} chip={chip} onHoverUrlChange={onHoverUrlChange} />
      ))}
      {hiddenCount > 0 && (
        <div className={cn('page-chips-overflow', iconOnly && 'w-full', iconOnly && expanded && 'flex flex-wrap gap-2.5')}>
          {hiddenChips.map((chip) => (
            <PageChip key={chip.rawUrl} chip={chip} onHoverUrlChange={onHoverUrlChange} />
          ))}
        </div>
      )}
      {!expanded && hiddenCount > 0 && (
        <Button
          className={cn(
            "page-chip page-chip-overflow clickable relative flex cursor-pointer items-start gap-2 rounded-[10px] border-0 bg-transparent py-1.5 pr-1 text-left text-xs tabular-nums text-tab-muted [font-family:inherit] [corner-shape:squircle] transition-colors duration-150 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--group-color,transparent)] before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,color-mix(in_srgb,var(--card-bg)_96%,rgb(82_82_82))_50%)] after:opacity-0 after:transition-opacity after:duration-200 after:ease-[ease] after:[corner-shape:squircle] after:content-[''] hover:bg-[rgba(82,82,82,0.04)] [&:has(.chip-actions):hover::after]:opacity-100",
            iconOnly ? 'pl-1' : 'pl-3'
          )}
          onClick={onExpand}
        >
          <span className="chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal max-h-[calc(2lh)] [hyphenate-character:'']">+{hiddenCount} more</span>
        </Button>
      )}
    </div>
  )
}
