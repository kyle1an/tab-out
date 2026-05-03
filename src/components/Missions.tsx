import { DomainCard } from './DomainCard'
import type { DashboardCardEntry, DashboardSource, DomainGroup, HoverUrlChangeHandler, LayoutChangeHandler, TogglePinnedDomainHandler } from './types'

interface MissionsProps {
  cards: DashboardCardEntry[]
  filter?: string
  source?: DashboardSource
  showEmptyState?: boolean
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
  onTogglePinnedDomain?: TogglePinnedDomainHandler | null
}

function stableKey(group: DomainGroup) {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')
}

function EmptyState({ source = 'tabs' }: { source?: DashboardSource }) {
  const noun = source === 'bookmarks' ? 'bookmarks' : source === 'history' ? 'history results' : 'tabs'
  return (
    <div className="missions-empty-state">
      <div className="empty-title">No {noun}.</div>
    </div>
  )
}

function NoResultsState({ query = '' }: { query?: string }) {
  return (
    <div className="missions-empty-state missions-empty-state-filter">
      <div className="empty-title">{query ? `No matches for “${query}”.` : 'No matches.'}</div>
    </div>
  )
}

export function Missions({ cards, filter = '', source = 'tabs', showEmptyState = true, onHoverUrlChange = null, onLayoutChange = null, onTogglePinnedDomain = null }: MissionsProps) {
  if (!cards || cards.length === 0) {
    if (!showEmptyState) return null
    return filter ? <NoResultsState query={filter} /> : <EmptyState source={source} />
  }

  return (
    <>
      {cards.map(({ group, vm }) => (
        <DomainCard
          key={stableKey(group)}
          group={group}
          vm={vm}
          filter={filter}
          onHoverUrlChange={onHoverUrlChange}
          onLayoutChange={onLayoutChange}
          onTogglePinnedDomain={onTogglePinnedDomain}
        />
      ))}
    </>
  )
}
