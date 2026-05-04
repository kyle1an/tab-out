import { Button } from './ui/Button'
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
        <Button
          className="action-btn h-(--header-control-height) box-border px-3 [font-family:inherit] [font-size:var(--header-control-font-size)] [line-height:var(--header-control-line-height)]"
          title={dedupTitle}
          onClick={onDedupAll}
        >
          Dedupe {dedupCount}
        </Button>
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
        <Button
          className="action-btn close-tabs h-(--header-control-height) box-border px-3 [font-family:inherit] [font-size:var(--header-control-font-size)] [line-height:var(--header-control-line-height)]"
          title={closeFilteredTitle}
          onClick={onCloseFiltered}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          Close {filteredCloseCount}
        </Button>
      )}
    </div>
  )
}
