import { DomainCard } from './DomainCard'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { dashboardSourceEmptyNoun } from '../extension/dashboard-source.js'
import { cn } from '@/lib/utils'
import type { DashboardCardEntry, DashboardSource, HoverUrlChangeHandler, HoverUrlSource, LayoutChangeHandler, TogglePinnedDomainHandler, TogglePinnedSectionHandler } from './types'

interface MissionsProps {
  cards: DashboardCardEntry[]
  filter?: string
  source?: DashboardSource
  showEmptyState?: boolean
  onHoverUrlChange?: HoverUrlChangeHandler | null
  activeHoverUrl?: string
  activeHoverUrls?: readonly string[]
  activeHoverSource?: HoverUrlSource | null
  onLayoutChange?: LayoutChangeHandler | null
  onTogglePinnedDomain?: TogglePinnedDomainHandler | null
  onTogglePinnedSection?: TogglePinnedSectionHandler | null
}

const EMPTY_HOVER_URLS: readonly string[] = []

function EmptyState({ source = 'tabs' }: { source?: DashboardSource }) {
  const noun = dashboardSourceEmptyNoun(source)
  return (
    <div className="[column-span:all] flex flex-col items-center justify-center gap-1.5 px-4 pt-10 pb-15 text-center">
      <div className="text-base font-normal text-tab-ink">No {noun}.</div>
    </div>
  )
}

function NoResultsState({ query = '' }: { query?: string }) {
  return (
    <div className="[column-span:all] flex flex-col items-center justify-center gap-1.5 px-4 pt-10 pb-15 text-center">
      <div className={cn('text-base font-normal text-tab-ink', 'text-[15px]')}>{query ? `No matches for “${query}”.` : 'No matches.'}</div>
    </div>
  )
}

export function Missions({ cards, filter = '', source = 'tabs', showEmptyState = true, onHoverUrlChange = null, activeHoverUrl = '', activeHoverUrls = EMPTY_HOVER_URLS, activeHoverSource = null, onLayoutChange = null, onTogglePinnedDomain = null, onTogglePinnedSection = null }: MissionsProps) {
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
          onHoverUrlChange={onHoverUrlChange}
          activeHoverUrl={activeHoverUrl}
          activeHoverUrls={activeHoverUrls}
          activeHoverSource={activeHoverSource}
          onLayoutChange={onLayoutChange}
          onTogglePinnedDomain={onTogglePinnedDomain}
          onTogglePinnedSection={onTogglePinnedSection}
        />
      ))}
    </>
  )
}
