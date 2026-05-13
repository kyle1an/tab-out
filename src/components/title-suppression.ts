import { cn } from '@/lib/utils'
import type { DashboardChipData } from './types'

export const TITLE_SUPPRESSION_TONE_NAMES = ['amber', 'teal', 'sky', 'rose'] as const
export type TitleSuppressionTone = typeof TITLE_SUPPRESSION_TONE_NAMES[number]
export const TITLE_SUPPRESSION_MARKER_SYMBOL = '˷'

export interface TitleSuppressionToneScope {
  useSuppressionTokenTones: boolean
  suppressedTitleToneIndexByText: ReadonlyMap<string, number>
  suppressedTitleToneByText: ReadonlyMap<string, TitleSuppressionTone | ''>
  usedToneCount: number
}

type TitleSuppressionTonePart = {
  text: string
  count?: number
  spansRenderedChildGroups?: boolean
}

interface TitleSuppressionToneScopeOptions {
  startToneIndex?: number
}

export function titleSuppressionKey(text: string): string {
  return text.trim().toLowerCase()
}

const TITLE_SUPPRESSION_TOKEN_TONES: Record<TitleSuppressionTone, { base: string; marker: string; active: string }> = {
  amber: {
    base: 'title-suppression-token-tone-amber border-yellow-200 bg-yellow-50 text-tab-muted hover:border-yellow-300 hover:bg-yellow-100 hover:text-tab-ink focus-visible:outline-yellow-400',
    marker: 'title-suppression-token-tone-amber border-yellow-200 bg-yellow-50 text-tab-muted',
    active: 'border-yellow-300 bg-yellow-100 text-tab-ink ring-1 ring-inset ring-yellow-200'
  },
  teal: {
    base: 'title-suppression-token-tone-teal border-teal-200 bg-teal-50 text-tab-muted hover:border-teal-300 hover:bg-teal-100 hover:text-tab-ink focus-visible:outline-teal-400',
    marker: 'title-suppression-token-tone-teal border-teal-200 bg-teal-50 text-tab-muted',
    active: 'border-teal-300 bg-teal-100 text-tab-ink ring-1 ring-inset ring-teal-200'
  },
  sky: {
    base: 'title-suppression-token-tone-sky border-sky-200 bg-sky-50 text-tab-muted hover:border-sky-300 hover:bg-sky-100 hover:text-tab-ink focus-visible:outline-sky-400',
    marker: 'title-suppression-token-tone-sky border-sky-200 bg-sky-50 text-tab-muted',
    active: 'border-sky-300 bg-sky-100 text-tab-ink ring-1 ring-inset ring-sky-200'
  },
  rose: {
    base: 'title-suppression-token-tone-rose border-rose-200 bg-rose-50 text-tab-muted hover:border-rose-300 hover:bg-rose-100 hover:text-tab-ink focus-visible:outline-rose-400',
    marker: 'title-suppression-token-tone-rose border-rose-200 bg-rose-50 text-tab-muted',
    active: 'border-rose-300 bg-rose-100 text-tab-ink ring-1 ring-inset ring-rose-200'
  }
}

const TITLE_SUPPRESSION_HIGHLIGHT_TONES: Record<TitleSuppressionTone, { chip: string; badge: string }> = {
  amber: {
    chip: 'bg-yellow-50 ring-1 ring-inset ring-yellow-200',
    badge: 'border-yellow-200 bg-yellow-100'
  },
  teal: {
    chip: 'bg-teal-50 ring-1 ring-inset ring-teal-200',
    badge: 'border-teal-200 bg-teal-100'
  },
  sky: {
    chip: 'bg-sky-50 ring-1 ring-inset ring-sky-200',
    badge: 'border-sky-200 bg-sky-100'
  },
  rose: {
    chip: 'bg-rose-50 ring-1 ring-inset ring-rose-200',
    badge: 'border-rose-200 bg-rose-100'
  }
}

export function titleSuppressionToneForIndex(index: number): TitleSuppressionTone {
  return TITLE_SUPPRESSION_TONE_NAMES[index % TITLE_SUPPRESSION_TONE_NAMES.length]
}

export function createTitleSuppressionToneScope(
  parts: readonly TitleSuppressionTonePart[],
  { startToneIndex = 0 }: TitleSuppressionToneScopeOptions = {}
): TitleSuppressionToneScope {
  const useSuppressionTokenTones = parts.length > 1 || parts.some((part) => !!part.spansRenderedChildGroups)
  const toneOrderedParts = [...parts]
    .map((part, displayIndex) => ({ part, displayIndex }))
    .sort((a, b) => (b.part.count ?? 0) - (a.part.count ?? 0) || a.displayIndex - b.displayIndex || a.part.text.localeCompare(b.part.text, undefined, { numeric: true }))
  const toneIndexByText = new Map<string, number>(
    toneOrderedParts.map(({ part }, toneOffset) => [titleSuppressionKey(part.text), startToneIndex + toneOffset])
  )
  const suppressedTitleToneIndexByText = new Map<string, number>(
    parts.map((part, index) => [titleSuppressionKey(part.text), toneIndexByText.get(titleSuppressionKey(part.text)) ?? startToneIndex + index])
  )
  const suppressedTitleToneByText = new Map<string, TitleSuppressionTone | ''>(
    parts.map((part) => [
      titleSuppressionKey(part.text),
      useSuppressionTokenTones ? titleSuppressionToneForIndex(toneIndexByText.get(titleSuppressionKey(part.text)) ?? startToneIndex) : ''
    ])
  )

  return {
    useSuppressionTokenTones,
    suppressedTitleToneIndexByText,
    suppressedTitleToneByText,
    usedToneCount: useSuppressionTokenTones ? parts.length : 0
  }
}

export function mergeTitleSuppressionToneMaps(
  ...maps: Array<ReadonlyMap<string, TitleSuppressionTone | ''> | undefined>
): ReadonlyMap<string, TitleSuppressionTone | ''> {
  const merged = new Map<string, TitleSuppressionTone | ''>()
  for (const map of maps) {
    if (!map) continue
    for (const [key, tone] of map) merged.set(key, tone)
  }
  return merged
}

export function titleSuppressionToneForText(
  text: string,
  toneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
): TitleSuppressionTone | '' {
  return toneByText?.get(titleSuppressionKey(text)) ?? ''
}

export function titleSuppressionTokenToneClass(index: number, enabled: boolean, active: boolean) {
  if (!enabled) {
    return active ? 'border-yellow-300 bg-yellow-100 text-tab-ink ring-1 ring-inset ring-yellow-200' : ''
  }
  const tone = TITLE_SUPPRESSION_TOKEN_TONES[titleSuppressionToneForIndex(index)]
  return cn(tone.base, active && tone.active)
}

export function titleSuppressionChipHighlightClass(tone: TitleSuppressionTone | '') {
  return tone ? TITLE_SUPPRESSION_HIGHLIGHT_TONES[tone].chip : 'bg-yellow-50 ring-1 ring-inset ring-yellow-200'
}

export function titleSuppressionOverflowHighlightClass(tone: TitleSuppressionTone | '') {
  return cn(titleSuppressionChipHighlightClass(tone), 'text-tab-ink')
}

export function titleSuppressionBadgeClass(tone: TitleSuppressionTone | '') {
  return tone ? TITLE_SUPPRESSION_HIGHLIGHT_TONES[tone].badge : 'border-yellow-200 bg-yellow-100'
}

export function titleSuppressionMarkerClass(tone: TitleSuppressionTone | '', active = false) {
  if (tone) return cn(TITLE_SUPPRESSION_TOKEN_TONES[tone].marker, active && TITLE_SUPPRESSION_TOKEN_TONES[tone].active)
  return active ? 'border-yellow-300 bg-yellow-100 text-tab-ink ring-1 ring-inset ring-yellow-200' : ''
}

export function countHiddenSuppressedTitleMatches(hiddenChips: DashboardChipData[], activeSuppressedTitle: string): number {
  const activeKey = activeSuppressedTitle.trim().toLowerCase()
  if (!activeKey) return 0

  return hiddenChips.filter((chip) => {
    const suppressedTitleParts = chip.suppressedTitleParts || []
    return suppressedTitleParts.some((part) => part.toLowerCase() === activeKey)
  }).length
}
