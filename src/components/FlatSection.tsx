import { useState } from 'react'
import { PageChip } from './PageChip'
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
    <div className={'flat-section' + (iconOnly ? ' flat-section-icons' : '')} data-expanded={expanded ? 'true' : undefined}>
      {visibleChips.map((chip) => (
        <PageChip key={chip.rawUrl} chip={chip} onHoverUrlChange={onHoverUrlChange} />
      ))}
      {hiddenCount > 0 && (
        <div className="page-chips-overflow">
          {hiddenChips.map((chip) => (
            <PageChip key={chip.rawUrl} chip={chip} onHoverUrlChange={onHoverUrlChange} />
          ))}
        </div>
      )}
      {!expanded && hiddenCount > 0 && (
        <div className="page-chip page-chip-overflow clickable" onClick={onExpand}>
          <span className="chip-text">+{hiddenCount} more</span>
        </div>
      )}
    </div>
  )
}
