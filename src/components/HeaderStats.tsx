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
    return <div className="header-stats" aria-hidden="true" />
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
    <div className="header-stats">
      <span className="stat-primary">{tabsLabel}</span>
      {source === 'tabs' && dedupCount > 0 && (
        <button className="action-btn" title={dedupTitle} onClick={onDedupAll}>
          Dedupe {dedupCount}
        </button>
      )}
      {source === 'tabs' && (
        <>
          <span className="stat-sep">·</span>
          <span>{windowsLabel}</span>
        </>
      )}
      {hasCards && (
        <span className="stat-extras">
          <span className="stat-sep">·</span>
          <span className="section-count">{domainsLabel}</span>
        </span>
      )}
      {source === 'tabs' && filteredCloseCount > 0 && (
        <button className="action-btn close-tabs" title={closeFilteredTitle} onClick={onCloseFiltered}>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
          </svg>
          Close {filteredCloseCount}
        </button>
      )}
    </div>
  )
}
