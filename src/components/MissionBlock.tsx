import { useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef, type Ref } from 'react'
import { cn } from '@/lib/utils'
import { domainGroupCardId } from '../extension/domain-card-id.js'
import { Missions } from './Missions'
import type { DashboardCardEntry, DashboardSource } from './types'

const PROGRESSIVE_CARD_THRESHOLD = 80
const PROGRESSIVE_CARD_INITIAL_COUNT = 24
const PROGRESSIVE_CARD_CHUNK_SIZE = 24

type MissionBlockProps = {
  cards: DashboardCardEntry[]
  filter: string
  gridEmpty?: boolean
  gridId: string
  gridRef?: Ref<HTMLDivElement>
  showEmptyState: boolean
  source: DashboardSource
}

function MissionsGrid({ className, empty = false, ref, ...props }: ComponentPropsWithoutRef<'div'> & { empty?: boolean; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className={cn(
        'missions relative mt-0 mb-0 [--masonry-gap:10px] [--masonry-ideal-col-width:304px] [--masonry-min-col-width:260px] max-[560px]:[--masonry-ideal-col-width:280px] max-[560px]:[--masonry-min-col-width:240px] min-[1200px]:[--masonry-ideal-col-width:340px] min-[1200px]:[--masonry-min-col-width:280px]',
        empty && 'missions-empty',
        className
      )}
      {...props}
    />
  )
}

function ProgressiveCardSentinel({ observationKey, onIntersect }: { observationKey: number; onIntersect: () => void }) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const root = sentinel.closest<HTMLElement>('[data-tabout-part="scroll-region"]')
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      observer.disconnect()
      onIntersect()
    }, {
      root,
      rootMargin: '0px 0px 480px 0px'
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [observationKey, onIntersect])

  return (
    <div
      ref={sentinelRef}
      data-tabout-part="progressive-card-sentinel"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
      aria-hidden="true"
    />
  )
}

function useProgressiveCards(
  cards: DashboardCardEntry[],
  enabled: boolean,
  resetKey: string
) {
  const progressive = enabled && cards.length > PROGRESSIVE_CARD_THRESHOLD
  const initialVisibleCount = progressive ? Math.min(PROGRESSIVE_CARD_INITIAL_COUNT, cards.length) : cards.length
  const [state, setState] = useState({ resetKey, count: initialVisibleCount })
  const visibleCount = state.resetKey === resetKey ? Math.min(state.count, cards.length) : initialVisibleCount

  const appendNextChunk = useCallback(() => {
    setState((current) => {
      const currentCount = current.resetKey === resetKey ? current.count : initialVisibleCount
      const nextCount = Math.min(cards.length, currentCount + PROGRESSIVE_CARD_CHUNK_SIZE)
      if (current.resetKey === resetKey && current.count === nextCount) return current
      return {
        resetKey,
        count: nextCount
      }
    })
  }, [cards.length, initialVisibleCount, resetKey])

  return {
    appendNextChunk,
    cards: progressive ? cards.slice(0, visibleCount) : cards,
    hasMore: progressive && visibleCount < cards.length,
    visibleCount
  }
}

function progressiveCardListKey(cards: DashboardCardEntry[]) {
  const first = cards[0]?.group
  const last = cards[cards.length - 1]?.group
  return `${cards.length}:${first ? domainGroupCardId(first) : ''}:${last ? domainGroupCardId(last) : ''}`
}

export function MissionBlock({
  cards,
  filter,
  gridEmpty = false,
  gridId,
  gridRef,
  showEmptyState,
  source
}: MissionBlockProps) {
  const progressiveEnabled = source !== 'tabs'
  const progressiveCards = useProgressiveCards(
    cards,
    progressiveEnabled,
    `${source}:${filter}:${progressiveCardListKey(cards)}`
  )

  return (
    <MissionsGrid empty={gridEmpty} id={gridId} ref={gridRef}>
      <Missions
        cards={progressiveCards.cards}
        filter={filter}
        source={source}
        showEmptyState={showEmptyState}
      />
      {progressiveCards.hasMore && (
        <ProgressiveCardSentinel
          observationKey={progressiveCards.visibleCount}
          onIntersect={progressiveCards.appendNextChunk}
        />
      )}
    </MissionsGrid>
  )
}
