import { DomainCard } from './DomainCard'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { dashboardSourceEmptyNoun } from '../extension/dashboard-source.js'
import { cn } from '@/lib/utils'
import type { DashboardCardEntry, DashboardSource } from './types'

interface MissionsProps {
  cards: DashboardCardEntry[]
  filter?: string
  source?: DashboardSource
  showEmptyState?: boolean
}

function EmptyState({ source = 'tabs' }: { source?: DashboardSource }) {
  const noun = dashboardSourceEmptyNoun(source)
  return (
    <div className="[column-span:all] flex flex-col items-center justify-center gap-1.5 px-4 pt-10 pb-15 text-center">
      <div className="text-base font-normal text-foreground">No {noun}.</div>
    </div>
  )
}

function NoResultsState({ query = '' }: { query?: string }) {
  return (
    <div className="[column-span:all] flex flex-col items-center justify-center gap-1.5 px-4 pt-10 pb-15 text-center">
      <div className={cn('text-base font-normal text-foreground', 'text-[15px]')}>{query ? `No matches for “${query}”.` : 'No matches.'}</div>
    </div>
  )
}

export function Missions({ cards, filter = '', source = 'tabs', showEmptyState = true }: MissionsProps) {
  if (!cards || cards.length === 0) {
    if (!showEmptyState) return null
    return filter ? <NoResultsState query={filter} /> : <EmptyState source={source} />
  }

  return (
    <>
      {cards.map(({ group, vm }) => (
        <DomainCard
          key={domainGroupCardId(group)}
          group={group}
          vm={vm}
          filter={filter}
        />
      ))}
    </>
  )
}
