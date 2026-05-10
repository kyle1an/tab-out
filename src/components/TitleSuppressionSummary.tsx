import { cn } from '@/lib/utils'
import { titleSuppressionKey, titleSuppressionTokenToneClass } from './title-suppression'
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
  if (suppressedTitleParts.length === 0) return null

  return (
    <div className={cn('title-suppression-summary flex flex-wrap items-center gap-1 text-xs leading-4 text-tab-muted', className)}>
      {suppressedTitleParts.map((part, index) => {
        const label = `Suppressed in ${part.count} title${part.count !== 1 ? 's' : ''}: ${part.text}`
        const active = activeSuppressedTitle === part.text
        const toneIndex = suppressedTitleToneIndexByText.get(titleSuppressionKey(part.text)) ?? index
        return (
          <button
            key={part.text}
            type="button"
            className={cn(
              'title-suppression-token inline-flex h-5 items-center gap-1 rounded-[6px] border border-transparent bg-[rgba(115,115,115,0.08)] px-1.5 py-0 text-xs leading-none font-medium text-tab-muted transition-[background,border-color,color,box-shadow] duration-150 [corner-shape:squircle] hover:border-[rgba(234,179,8,0.32)] hover:bg-[rgba(234,179,8,0.12)] hover:text-tab-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-amber)]',
              titleSuppressionTokenToneClass(toneIndex, useSuppressionTokenTones, active)
            )}
            aria-label={label}
            onMouseEnter={() => setActiveSuppressedTitle(part.text)}
            onMouseLeave={() => setActiveSuppressedTitle('')}
            onFocus={() => setActiveSuppressedTitle(part.text)}
            onBlur={() => setActiveSuppressedTitle('')}
          >
            <span className="title-suppression-token-text max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap">{part.text}</span>
            {part.count > 1 && <span className="title-suppression-token-count tabular-nums opacity-65">{part.count}</span>}
          </button>
        )
      })}
    </div>
  )
}
