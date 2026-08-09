import { usePageChipOverflow } from './PageChipOverflow'
import { cn } from '@/lib/utils'
import type { TitleSuppressionTone } from './title-suppression'
import type { DashboardChipData } from './types'

interface FlatSectionProps {
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  afterSeparator?: boolean | undefined
  filter?: string | undefined
  suppressedTitleToneByText?: Readonly<Record<string, TitleSuppressionTone | ''>> | undefined
}

export function FlatSection({ visibleChips, hiddenChips, hiddenCount, afterSeparator = false, filter = '', suppressedTitleToneByText }: FlatSectionProps) {
  const iconOnly = visibleChips.length > 0 && visibleChips.every((chip) => chip.iconOnly)
  const { expanded, pageChips } = usePageChipOverflow({
    visibleChips,
    hiddenChips,
    hiddenCount,
    filter,
    suppressedTitleToneByText,
    overflowContainerClassName: ({ expanded }) => cn(iconOnly && 'w-full', iconOnly && expanded && 'flex flex-wrap gap-2.5'),
    overflowButtonClassName: iconOnly ? 'pl-1' : 'pl-3',
  })

  return (
    <div
      className={cn(
        'flat-section flex flex-col',
        afterSeparator && 'mt-1.5',
        iconOnly && 'flat-section-icons flex-row flex-wrap gap-2.5',
      )}
      data-expanded={expanded ? 'true' : undefined}
    >
      {pageChips}
    </div>
  )
}
