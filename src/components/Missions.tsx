import { DomainCard } from './DomainCard'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { dashboardSourceEmptyNoun } from '../extension/dashboard-source.js'
import { cn } from '@/lib/utils'
import { highlightTermsForFilter } from './filter-highlight-text'
import type { DashboardCardEntry, DashboardSource } from './types'

interface MissionsProps {
  cards: DashboardCardEntry[]
  emptyStateHint?: string | undefined
  emptyStateLabel?: string | undefined
  filter?: string
  source?: DashboardSource
  showEmptyState?: boolean
}

function EmptyState({ hint, label, source = 'tabs' }: { hint?: string | undefined, label?: string | undefined, source?: DashboardSource }) {
  const noun = dashboardSourceEmptyNoun(source)
  return (
    <output
      aria-live="polite"
      aria-atomic="true"
      className="[column-span:all] flex flex-col items-center justify-center gap-1.5 px-4 pt-10 pb-15 text-center"
    >
      <span className="text-base font-normal text-foreground">{label ?? `No ${noun}.`}</span>
      {hint && <span className="text-sm font-normal text-muted-foreground">{hint}</span>}
    </output>
  )
}

function NoResultsState({ hint, query = '' }: { hint?: string | undefined, query?: string }) {
  return (
    <output
      aria-live="polite"
      aria-atomic="true"
      className="[column-span:all] flex flex-col items-center justify-center gap-1.5 px-4 pt-10 pb-15 text-center"
    >
      <span className={cn('text-base font-normal text-foreground', 'text-[15px]')}>{query ? `No matches for “${query}”.` : 'No matches.'}</span>
      {hint && <span className="text-sm font-normal text-muted-foreground">{hint}</span>}
    </output>
  )
}

export function Missions({ cards, emptyStateHint, emptyStateLabel, filter = '', source = 'tabs', showEmptyState = true }: MissionsProps) {
  if (!cards || cards.length === 0) {
    if (!showEmptyState) return null
    return filter
      ? <NoResultsState hint={emptyStateHint} query={filter} />
      : <EmptyState hint={emptyStateHint} label={emptyStateLabel} source={source} />
  }

  const highlightTerms = highlightTermsForFilter(filter)

  return (
    <>
      {cards.map(({ group, vm }) => (
        <DomainCard
          key={domainGroupCardId(group)}
          group={group}
          vm={vm}
          filter={filter}
          highlightTerms={highlightTerms}
        />
      ))}
    </>
  )
}
