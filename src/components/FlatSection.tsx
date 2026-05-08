import { useState } from 'react'
import { PageChip } from './PageChip'
import { Button } from './ui/Button'
import { cn } from '../lib/cn'
import type { DashboardChipData, HoverUrlChangeHandler, LayoutChangeHandler } from './types'

interface FlatSectionProps {
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
}

export function FlatSection({ visibleChips, hiddenChips, hiddenCount, onHoverUrlChange = null, onLayoutChange = null }: FlatSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const iconOnly = visibleChips.length > 0 && visibleChips.every((chip) => chip.iconOnly)

  function onExpand() {
    setExpanded(true)
    if (onLayoutChange) onLayoutChange()
  }

  return (
    <div className={cn('flat-section flex flex-col', iconOnly && 'flat-section-icons flex-row flex-wrap gap-2.5')} data-expanded={expanded ? 'true' : undefined}>
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
            'page-chip page-chip-overflow clickable cursor-pointer py-1.5 pr-1 text-xs tabular-nums text-tab-muted transition-colors duration-150 hover:bg-[rgba(82,82,82,0.04)]',
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
