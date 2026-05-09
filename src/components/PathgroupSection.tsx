import { useState } from 'react'
import { closeExactTabSection } from '../extension/tab-actions'
import { PageChip } from './PageChip'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import type { DashboardChipData, HoverUrlChangeHandler, LayoutChangeHandler } from './types'

interface PathgroupCloseButtonProps {
  count: number
  isFirstContent?: boolean
  onClick: () => void | Promise<void>
}

interface PathgroupSectionProps {
  label: string
  isPR: boolean
  count: number
  closableUrls: string[]
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  className?: string
  isFirstContent?: boolean
  filter?: string
  activeSuppressedTitle?: string
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
}

function pathGroupDisplayLabel(label: string): string {
  return label.startsWith('/') ? label : `/${label}`
}

function PathgroupCloseButton({ count, isFirstContent = false, onClick }: PathgroupCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        className={cn(
          'pathgroup-close-btn absolute top-1/2 right-0 grid h-5 w-5 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-0 bg-tab-card p-0 text-tab-muted opacity-0 transition-[opacity,background] duration-150 group-hover/pathgroup-section:opacity-100 hover:bg-[#ededed]',
          isFirstContent && 'top-[calc(50%_-_1px)]'
        )}
        aria-label={title}
        onClick={onClick}
      >
        <svg className="block h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </TooltipAnchor>
  )
}

export function PathgroupSection({ label, isPR, count, closableUrls, visibleChips, hiddenChips, hiddenCount, className, isFirstContent = false, filter = '', activeSuppressedTitle = '', onHoverUrlChange = null, onLayoutChange = null }: PathgroupSectionProps) {
  const [expanded, setExpanded] = useState(false)
  const displayLabel = pathGroupDisplayLabel(label)

  function onExpand() {
    setExpanded(true)
    if (onLayoutChange) onLayoutChange()
  }

  async function onCloseCluster() {
    if (!closableUrls || closableUrls.length === 0) return
    await closeExactTabSection({ urls: closableUrls })
  }

  return (
    <div className={cn('pathgroup-section group/pathgroup-section flex flex-col', className)} data-expanded={expanded ? 'true' : undefined}>
      <div
        className={cn(
          'pathgroup-header relative flex items-center gap-1.5 pr-6 pb-0.5 pl-0',
          isFirstContent ? 'pt-0' : 'pt-[3px]'
        )}
      >
        <TooltipAnchor content={displayLabel}>
          <span className="chip-pathgroup inline-block min-w-0 overflow-hidden rounded-lg bg-[rgba(115,115,115,0.1)] px-1.5 text-ellipsis whitespace-nowrap text-xs font-medium text-tab-muted align-baseline [corner-shape:squircle]">
            {displayLabel}
          </span>
        </TooltipAnchor>
        {isPR && (
          <span className="chip-pathgroup chip-pathgroup-pr -ml-0.5 inline-block rounded-lg bg-[rgba(115,115,115,0.18)] px-[5px] text-xs font-semibold text-tab-ink align-baseline [corner-shape:squircle]">
            PRs
          </span>
        )}
        <span className="pathgroup-header-count text-xs tabular-nums text-tab-muted opacity-70">{count}</span>
        {closableUrls && closableUrls.length > 0 && <PathgroupCloseButton count={closableUrls.length} isFirstContent={isFirstContent} onClick={onCloseCluster} />}
      </div>
      {visibleChips.map((chip) => (
        <PageChip key={chip.rawUrl} chip={chip} filter={filter} activeSuppressedTitle={activeSuppressedTitle} onHoverUrlChange={onHoverUrlChange} />
      ))}
      {hiddenCount > 0 && (
        <div className="page-chips-overflow">
          {hiddenChips.map((chip) => (
            <PageChip key={chip.rawUrl} chip={chip} filter={filter} activeSuppressedTitle={activeSuppressedTitle} onHoverUrlChange={onHoverUrlChange} />
          ))}
        </div>
      )}
      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          className="page-chip page-chip-overflow clickable relative flex cursor-pointer items-start gap-2 rounded-[10px] border-0 bg-transparent py-[5px] pr-1 pl-3 text-left text-[13px] leading-tight tabular-nums text-tab-muted [font-family:inherit] [corner-shape:squircle] transition-colors duration-150 before:pointer-events-none before:absolute before:top-[7px] before:bottom-[7px] before:left-1 before:w-0.5 before:rounded-[1px] before:bg-[var(--group-color,transparent)] before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:top-0 after:right-0 after:bottom-0 after:z-1 after:w-[72px] after:rounded-r-[inherit] after:bg-[linear-gradient(to_right,transparent,color-mix(in_srgb,var(--card-bg)_96%,rgb(82_82_82))_50%)] after:opacity-0 after:transition-opacity after:duration-200 after:ease-[ease] after:[corner-shape:squircle] after:content-[''] hover:bg-[rgba(82,82,82,0.04)] [&:has(.chip-actions):hover::after]:opacity-100"
          onClick={onExpand}
        >
          <span className="chip-text block min-w-0 flex-1 overflow-hidden hyphens-auto break-normal text-[13px] max-h-[calc(2lh)] [hyphenate-character:'']">+{hiddenCount} more</span>
        </button>
      )}
    </div>
  )
}
