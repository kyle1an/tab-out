import { TooltipAnchor } from './ui/tooltip'
import type { DashboardSource, DashboardStats } from './types'

interface HeaderStatsProps extends DashboardStats {
  ready?: boolean
  source?: DashboardSource
  onDedupAll: () => void
  onCloseFiltered: () => void
}

function pluralize(count: number, singular: string) {
  return `${singular}${count === 1 ? '' : 's'}`
}

export function HeaderStats({
  ready = true,
  source = 'tabs',
  totalTabs,
  visibleTabs,
  totalWindows,
  visibleWindows,
  totalDomains,
  visibleDomains,
  dedupCount,
  filteredCloseCount,
  hasCards,
  filtering,
  onDedupAll,
  onCloseFiltered
}: HeaderStatsProps) {
  if (!ready) {
    return <div className="inline-flex min-h-(--header-control-height) min-w-0 items-center gap-2 text-[13px] font-normal tabular-nums text-tab-muted" aria-hidden="true" />
  }

  const itemName = source === 'bookmarks' ? 'bookmark' : source === 'history' ? 'history result' : 'tab'
  const itemLabel = pluralize(totalTabs, itemName)
  const tabsLabel = filtering ? `${visibleTabs}/${totalTabs} ${itemLabel}` : `${totalTabs} ${itemLabel}`
  const windowsLabel =
    visibleWindows === totalWindows ? `${totalWindows} ${pluralize(totalWindows, 'window')}` : `${visibleWindows}/${totalWindows} ${pluralize(totalWindows, 'window')}`
  const domainsLabel =
    visibleDomains === totalDomains ? `${totalDomains} ${pluralize(totalDomains, 'domain')}` : `${visibleDomains}/${totalDomains} ${pluralize(totalDomains, 'domain')}`

  const dedupTitle = `Close ${dedupCount} duplicate${dedupCount !== 1 ? 's' : ''}`
  const closeFilteredTitle = `Close ${filteredCloseCount} filtered tab${filteredCloseCount !== 1 ? 's' : ''}`

  return (
    <div className="inline-flex min-h-(--header-control-height) min-w-0 items-center gap-2 text-[13px] font-normal tabular-nums text-tab-muted">
      <span className="font-medium text-tab-ink">{tabsLabel}</span>
      {source === 'tabs' && dedupCount > 0 && (
        <TooltipAnchor content={dedupTitle}>
          <button
            type="button"
            className="action-btn inline-flex h-(--header-control-height) box-border cursor-pointer items-center gap-[5px] rounded-[var(--header-control-radius)] border border-[var(--warm-gray)] bg-tab-card px-3 py-[5px] font-[inherit] [font-size:var(--header-control-font-size)] leading-(--header-control-line-height) font-medium text-tab-muted transition-all duration-200 [corner-shape:squircle] hover:border-tab-ink hover:text-tab-ink"
            onClick={onDedupAll}
          >
            Dedupe {dedupCount}
          </button>
        </TooltipAnchor>
      )}
      {source === 'tabs' && (
        <>
          <span className="text-tab-muted opacity-50">·</span>
          <span>{windowsLabel}</span>
        </>
      )}
      {hasCards && (
        <span className="inline-flex items-center gap-2">
          <span className="text-tab-muted opacity-50">·</span>
          <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-normal tabular-nums text-tab-muted">{domainsLabel}</span>
        </span>
      )}
      {source === 'tabs' && filteredCloseCount > 0 && (
        <TooltipAnchor content={closeFilteredTitle}>
          <button
            type="button"
            className="action-btn close-tabs inline-flex h-(--header-control-height) box-border cursor-pointer items-center gap-[5px] rounded-[var(--header-control-radius)] border border-[rgba(82,82,82,0.3)] bg-[rgba(82,82,82,0.04)] px-3 py-[5px] font-[inherit] [font-size:var(--header-control-font-size)] leading-(--header-control-line-height) font-medium text-[var(--accent-amber)] transition-all duration-200 [corner-shape:squircle] hover:border-[var(--accent-amber)] hover:bg-[rgba(82,82,82,0.1)]"
            onClick={onCloseFiltered}
          >
            <svg className="h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
            Close {filteredCloseCount}
          </button>
        </TooltipAnchor>
      )}
    </div>
  )
}
