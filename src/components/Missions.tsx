import { DomainCard } from './DomainCard'

function stableKey(group) {
  return 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-')
}

function EmptyState({ source = 'tabs' }) {
  const noun = source === 'bookmarks' ? 'bookmarks' : source === 'history' ? 'history results' : 'tabs'
  return (
    <div className="missions-empty-state">
      <div className="empty-title">No {noun}.</div>
    </div>
  )
}

function NoResultsState({ query = '' }) {
  return (
    <div className="missions-empty-state missions-empty-state-filter">
      <div className="empty-title">{query ? `No matches for “${query}”.` : 'No matches.'}</div>
    </div>
  )
}

export function Missions({ cards, filter = '', source = 'tabs', showEmptyState = true, onHoverUrlChange = null, onLayoutChange = null, onTogglePinnedDomain = null }) {
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
