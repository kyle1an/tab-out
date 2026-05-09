import { cn } from '@/lib/utils'
import type { DashboardChipData } from './types'

export const TITLE_SUPPRESSION_TONE_NAMES = ['amber', 'teal', 'sky', 'rose'] as const
export type TitleSuppressionTone = typeof TITLE_SUPPRESSION_TONE_NAMES[number]

const TITLE_SUPPRESSION_TOKEN_TONES: Record<TitleSuppressionTone, { base: string; marker: string; active: string }> = {
  amber: {
    base: 'title-suppression-token-tone-amber border-[rgba(217,119,6,0.22)] bg-[rgba(217,119,6,0.08)] text-tab-ink hover:border-[rgba(217,119,6,0.36)] hover:bg-[rgba(217,119,6,0.13)] focus-visible:outline-[rgba(217,119,6,0.72)]',
    marker: 'title-suppression-token-tone-amber border-[rgba(217,119,6,0.22)] bg-[rgba(217,119,6,0.08)] text-tab-ink',
    active: 'border-[rgba(217,119,6,0.42)] bg-[rgba(217,119,6,0.16)] shadow-[inset_0_0_0_1px_rgba(217,119,6,0.22)]'
  },
  teal: {
    base: 'title-suppression-token-tone-teal border-[rgba(20,184,166,0.22)] bg-[rgba(20,184,166,0.08)] text-tab-ink hover:border-[rgba(20,184,166,0.38)] hover:bg-[rgba(20,184,166,0.13)] focus-visible:outline-[rgba(20,184,166,0.72)]',
    marker: 'title-suppression-token-tone-teal border-[rgba(20,184,166,0.22)] bg-[rgba(20,184,166,0.08)] text-tab-ink',
    active: 'border-[rgba(20,184,166,0.42)] bg-[rgba(20,184,166,0.16)] shadow-[inset_0_0_0_1px_rgba(20,184,166,0.22)]'
  },
  sky: {
    base: 'title-suppression-token-tone-sky border-[rgba(14,165,233,0.22)] bg-[rgba(14,165,233,0.08)] text-tab-ink hover:border-[rgba(14,165,233,0.38)] hover:bg-[rgba(14,165,233,0.13)] focus-visible:outline-[rgba(14,165,233,0.72)]',
    marker: 'title-suppression-token-tone-sky border-[rgba(14,165,233,0.22)] bg-[rgba(14,165,233,0.08)] text-tab-ink',
    active: 'border-[rgba(14,165,233,0.42)] bg-[rgba(14,165,233,0.16)] shadow-[inset_0_0_0_1px_rgba(14,165,233,0.22)]'
  },
  rose: {
    base: 'title-suppression-token-tone-rose border-[rgba(244,63,94,0.22)] bg-[rgba(244,63,94,0.08)] text-tab-ink hover:border-[rgba(244,63,94,0.38)] hover:bg-[rgba(244,63,94,0.13)] focus-visible:outline-[rgba(244,63,94,0.72)]',
    marker: 'title-suppression-token-tone-rose border-[rgba(244,63,94,0.22)] bg-[rgba(244,63,94,0.08)] text-tab-ink',
    active: 'border-[rgba(244,63,94,0.42)] bg-[rgba(244,63,94,0.16)] shadow-[inset_0_0_0_1px_rgba(244,63,94,0.22)]'
  }
}

const TITLE_SUPPRESSION_HIGHLIGHT_TONES: Record<TitleSuppressionTone, { chip: string; badge: string }> = {
  amber: {
    chip: 'bg-[rgba(217,119,6,0.12)] shadow-[inset_0_0_0_1px_rgba(217,119,6,0.32)]',
    badge: 'border-[rgba(217,119,6,0.22)] bg-[rgba(217,119,6,0.16)]'
  },
  teal: {
    chip: 'bg-[rgba(20,184,166,0.12)] shadow-[inset_0_0_0_1px_rgba(20,184,166,0.32)]',
    badge: 'border-[rgba(20,184,166,0.22)] bg-[rgba(20,184,166,0.16)]'
  },
  sky: {
    chip: 'bg-[rgba(14,165,233,0.12)] shadow-[inset_0_0_0_1px_rgba(14,165,233,0.32)]',
    badge: 'border-[rgba(14,165,233,0.22)] bg-[rgba(14,165,233,0.16)]'
  },
  rose: {
    chip: 'bg-[rgba(244,63,94,0.12)] shadow-[inset_0_0_0_1px_rgba(244,63,94,0.32)]',
    badge: 'border-[rgba(244,63,94,0.22)] bg-[rgba(244,63,94,0.16)]'
  }
}

export function titleSuppressionToneForIndex(index: number): TitleSuppressionTone {
  return TITLE_SUPPRESSION_TONE_NAMES[index % TITLE_SUPPRESSION_TONE_NAMES.length]
}

export function titleSuppressionTokenToneClass(index: number, enabled: boolean, active: boolean) {
  if (!enabled) {
    return active ? 'border-[rgba(234,179,8,0.4)] bg-[rgba(234,179,8,0.14)] text-tab-ink shadow-[inset_0_0_0_1px_rgba(234,179,8,0.18)]' : ''
  }
  const tone = TITLE_SUPPRESSION_TOKEN_TONES[titleSuppressionToneForIndex(index)]
  return cn(tone.base, active && tone.active)
}

export function titleSuppressionChipHighlightClass(tone: TitleSuppressionTone | '') {
  return tone ? TITLE_SUPPRESSION_HIGHLIGHT_TONES[tone].chip : 'bg-[rgba(234,179,8,0.12)] shadow-[inset_0_0_0_1px_rgba(234,179,8,0.32)]'
}

export function titleSuppressionOverflowHighlightClass(tone: TitleSuppressionTone | '') {
  return cn(titleSuppressionChipHighlightClass(tone), 'text-tab-ink')
}

export function titleSuppressionBadgeClass(tone: TitleSuppressionTone | '') {
  return tone ? TITLE_SUPPRESSION_HIGHLIGHT_TONES[tone].badge : 'border-[rgba(234,179,8,0.4)] bg-[rgba(234,179,8,0.16)]'
}

export function titleSuppressionMarkerClass(tone: TitleSuppressionTone | '', active = false) {
  if (tone) return cn(TITLE_SUPPRESSION_TOKEN_TONES[tone].marker, active && TITLE_SUPPRESSION_TOKEN_TONES[tone].active)
  return active ? 'border-[rgba(234,179,8,0.4)] bg-[rgba(234,179,8,0.14)] text-tab-ink shadow-[inset_0_0_0_1px_rgba(234,179,8,0.18)]' : ''
}

export function countHiddenSuppressedTitleMatches(hiddenChips: DashboardChipData[], activeSuppressedTitle: string): number {
  const activeKey = activeSuppressedTitle.trim().toLowerCase()
  if (!activeKey) return 0

  return hiddenChips.filter((chip) => {
    const suppressedTitleParts = chip.suppressedTitleParts || []
    return suppressedTitleParts.some((part) => part.toLowerCase() === activeKey)
  }).length
}
