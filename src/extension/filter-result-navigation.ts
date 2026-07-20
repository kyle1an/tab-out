import { savedPageKeyForUrl } from './saved-pages.js'
import { unwrapSuspenderUrl } from './suspension.js'
import type { DashboardCardEntry, DashboardChipData, DashboardChipEnv, DashboardTab } from './types.js'

export type FilterResultCandidate = {
  key: string
  identity: string
  domId: string
}

export type FilterResultSelection = {
  query: string
  candidateKey: string | null
  identity: string | null
}

export type FilterResultRect = {
  left: number
  right: number
  top: number
  bottom: number
}

export type PositionedFilterResultCandidate = {
  candidate: FilterResultCandidate
  rect: FilterResultRect
}

export type HorizontalFilterResultDirection = 'left' | 'right'
export type FilterResultMoveDirection = 'next' | 'previous' | HorizontalFilterResultDirection
export type FilterResultKeyboardIntent = FilterResultMoveDirection | 'activate'

export type FilterResultKeyboardEvent = {
  key: string
  altKey?: boolean
  isComposing?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
}

export const EMPTY_FILTER_RESULT_SELECTION: FilterResultSelection = {
  query: '',
  candidateKey: null,
  identity: null
}

type FilterResultTarget = Pick<DashboardChipData | DashboardChipEnv, 'tabId' | 'tabUrl' | 'rawUrl' | 'sourceType'>

function filterResultIdentity(target: FilterResultTarget): string {
  const effectiveUrl = unwrapSuspenderUrl(target.tabUrl || target.rawUrl)
  return savedPageKeyForUrl(effectiveUrl) || effectiveUrl
}

export function filterResultCandidateForTarget(
  target: FilterResultTarget,
  fallbackSourceType: DashboardTab['sourceType'] = 'tab'
): FilterResultCandidate {
  const identity = filterResultIdentity(target)
  const sourceType = target.sourceType || fallbackSourceType
  const discriminator = target.tabId ?? target.rawUrl ?? target.tabUrl
  const key = JSON.stringify([sourceType, identity, discriminator])
  return {
    key,
    identity,
    domId: `tab-out-filter-result-${encodeURIComponent(key)}`
  }
}

function filterResultCandidatesForChip(chip: DashboardChipData): FilterResultCandidate[] {
  if (chip.envs?.length) {
    return chip.envs.map((env) => filterResultCandidateForTarget(env, chip.sourceType))
  }
  if ((chip.titleVariantChips?.length ?? 0) > 1) {
    return (chip.titleVariantChips ?? []).map((variant) => filterResultCandidateForTarget(variant, chip.sourceType))
  }
  return [filterResultCandidateForTarget(chip)]
}

function visibleChipsForCard({ vm }: DashboardCardEntry): DashboardChipData[] {
  return (vm.sections ?? []).flatMap((section) => [
    ...section.flatVisibleChips,
    ...section.websitePathSections.flatMap((websitePathSection) => [
      ...websitePathSection.flatVisibleChips,
      ...websitePathSection.clusters.flatMap((cluster) => cluster.visibleChips)
    ]),
    ...section.clusters.flatMap((cluster) => cluster.visibleChips)
  ])
}

function filterResultCandidatesForCards(cards: readonly DashboardCardEntry[]): FilterResultCandidate[] {
  return cards.flatMap((card) => visibleChipsForCard(card).flatMap(filterResultCandidatesForChip))
}

export function buildFilterResultCandidates({
  primaryMatches,
  historyMatches = [],
  bookmarkMatches = []
}: {
  primaryMatches: readonly DashboardCardEntry[]
  historyMatches?: readonly DashboardCardEntry[]
  bookmarkMatches?: readonly DashboardCardEntry[]
}): FilterResultCandidate[] {
  return [
    ...filterResultCandidatesForCards(primaryMatches),
    ...filterResultCandidatesForCards(historyMatches),
    ...filterResultCandidatesForCards(bookmarkMatches)
  ]
}

export function filterResultKeyboardIntent(
  event: FilterResultKeyboardEvent
): FilterResultKeyboardIntent | null {
  if (event.isComposing || event.altKey) return null
  if (event.key === 'ArrowDown') return 'next'
  if (event.key === 'ArrowUp') return 'previous'
  if (event.key === 'ArrowLeft') return 'left'
  if (event.key === 'ArrowRight') return 'right'
  if (event.key === 'Enter') return 'activate'
  return null
}

function selectionForCandidate(query: string, candidate: FilterResultCandidate | undefined): FilterResultSelection {
  return {
    query,
    candidateKey: candidate?.key ?? null,
    identity: candidate?.identity ?? null
  }
}

export function reconcileFilterResultSelection(
  current: FilterResultSelection,
  query: string,
  candidates: readonly FilterResultCandidate[]
): FilterResultSelection {
  if (!query.trim() || candidates.length === 0) return selectionForCandidate(query, undefined)
  if (current.query !== query) return selectionForCandidate(query, candidates[0])

  const exactCandidate = candidates.find((candidate) => candidate.key === current.candidateKey)
  if (exactCandidate) return selectionForCandidate(query, exactCandidate)

  const identityCandidate = candidates.find((candidate) => candidate.identity === current.identity)
  return selectionForCandidate(query, identityCandidate ?? candidates[0])
}

export function selectAdjacentFilterResult(
  current: FilterResultSelection,
  query: string,
  candidates: readonly FilterResultCandidate[],
  direction: 'next' | 'previous'
): FilterResultSelection {
  const reconciled = reconcileFilterResultSelection(current, query, candidates)
  const currentIndex = candidates.findIndex((candidate) => candidate.key === reconciled.candidateKey)
  if (currentIndex < 0) return reconciled

  const offset = direction === 'next' ? 1 : -1
  const nextIndex = Math.min(Math.max(currentIndex + offset, 0), candidates.length - 1)
  return selectionForCandidate(query, candidates[nextIndex])
}

const HORIZONTAL_EDGE_TOLERANCE_PX = 1
const HORIZONTAL_AXIS_DISTANCE_WEIGHT = 13

function verticalCenter(rect: FilterResultRect): number {
  return (rect.top + rect.bottom) / 2
}

function verticallyOverlaps(left: FilterResultRect, right: FilterResultRect): boolean {
  return left.bottom > right.top && right.bottom > left.top
}

export function selectHorizontalFilterResult(
  current: FilterResultSelection,
  query: string,
  positionedCandidates: readonly PositionedFilterResultCandidate[],
  direction: HorizontalFilterResultDirection
): FilterResultSelection {
  const candidates = positionedCandidates.map(({ candidate }) => candidate)
  const reconciled = reconcileFilterResultSelection(current, query, candidates)
  const currentPosition = positionedCandidates.find(
    ({ candidate }) => candidate.key === reconciled.candidateKey
  )
  if (!currentPosition) return reconciled

  const directionalCandidates = positionedCandidates.flatMap((position, index) => {
    if (position.candidate.key === currentPosition.candidate.key) return []

    const horizontalGap = direction === 'right'
      ? position.rect.left - currentPosition.rect.right
      : currentPosition.rect.left - position.rect.right
    if (horizontalGap < -HORIZONTAL_EDGE_TOLERANCE_PX) return []

    const majorAxisDistance = Math.max(horizontalGap, 0)
    const minorAxisDistance = Math.abs(
      verticalCenter(position.rect) - verticalCenter(currentPosition.rect)
    )
    const inVerticalBeam = verticallyOverlaps(position.rect, currentPosition.rect)

    return [{
      position,
      index,
      inVerticalBeam,
      majorAxisDistance,
      minorAxisDistance,
      weightedDistance:
        HORIZONTAL_AXIS_DISTANCE_WEIGHT * majorAxisDistance ** 2 +
        minorAxisDistance ** 2
    }]
  })

  directionalCandidates.sort((left, right) => {
    if (left.inVerticalBeam !== right.inVerticalBeam) return left.inVerticalBeam ? -1 : 1
    if (left.inVerticalBeam) {
      return left.majorAxisDistance - right.majorAxisDistance ||
        left.minorAxisDistance - right.minorAxisDistance ||
        left.index - right.index
    }
    return left.weightedDistance - right.weightedDistance ||
      left.majorAxisDistance - right.majorAxisDistance ||
      left.minorAxisDistance - right.minorAxisDistance ||
      left.index - right.index
  })

  const nextCandidate = directionalCandidates[0]?.position.candidate
  return nextCandidate ? selectionForCandidate(query, nextCandidate) : reconciled
}
