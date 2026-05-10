import { cn } from '@/lib/utils'
import type { DashboardChipData } from './types'

export const TITLE_SUPPRESSION_TONE_NAMES = ['amber', 'teal', 'sky', 'rose'] as const
export type TitleSuppressionTone = typeof TITLE_SUPPRESSION_TONE_NAMES[number]

export interface TitleSuppressionToneScope {
  useSuppressionTokenTones: boolean
  suppressedTitleToneIndexByText: ReadonlyMap<string, number>
  suppressedTitleToneByText: ReadonlyMap<string, TitleSuppressionTone | ''>
}

export function titleSuppressionKey(text: string): string {
  return text.trim().toLowerCase()
}

const TITLE_SUPPRESSION_TOKEN_TONES: Record<TitleSuppressionTone, { base: string; marker: string; active: string }> = {
  amber: {
    base: 'title-suppression-token-tone-amber border-[#fdba74] bg-[#fff7ed] text-tab-ink hover:border-[#fb923c] hover:bg-[#ffedd5] focus-visible:outline-[rgba(249,115,22,0.72)]',
    marker: 'title-suppression-token-tone-amber border-[#fdba74] bg-[#fff7ed] text-tab-ink',
    active: 'border-[#f97316] bg-[#ffedd5] shadow-[inset_0_0_0_1px_rgba(249,115,22,0.22)]'
  },
  teal: {
    base: 'title-suppression-token-tone-teal border-[#5eead4] bg-[#f0fdfa] text-tab-ink hover:border-[#2dd4bf] hover:bg-[#ccfbf1] focus-visible:outline-[rgba(20,184,166,0.72)]',
    marker: 'title-suppression-token-tone-teal border-[#5eead4] bg-[#f0fdfa] text-tab-ink',
    active: 'border-[#14b8a6] bg-[#ccfbf1] shadow-[inset_0_0_0_1px_rgba(20,184,166,0.22)]'
  },
  sky: {
    base: 'title-suppression-token-tone-sky border-[#7dd3fc] bg-[#f0f9ff] text-tab-ink hover:border-[#38bdf8] hover:bg-[#e0f2fe] focus-visible:outline-[rgba(14,165,233,0.72)]',
    marker: 'title-suppression-token-tone-sky border-[#7dd3fc] bg-[#f0f9ff] text-tab-ink',
    active: 'border-[#0ea5e9] bg-[#e0f2fe] shadow-[inset_0_0_0_1px_rgba(14,165,233,0.22)]'
  },
  rose: {
    base: 'title-suppression-token-tone-rose border-[#fda4af] bg-[#fff1f2] text-tab-ink hover:border-[#fb7185] hover:bg-[#ffe4e6] focus-visible:outline-[rgba(244,63,94,0.72)]',
    marker: 'title-suppression-token-tone-rose border-[#fda4af] bg-[#fff1f2] text-tab-ink',
    active: 'border-[#f43f5e] bg-[#ffe4e6] shadow-[inset_0_0_0_1px_rgba(244,63,94,0.22)]'
  }
}

const TITLE_SUPPRESSION_HIGHLIGHT_TONES: Record<TitleSuppressionTone, { chip: string; badge: string }> = {
  amber: {
    chip: 'bg-[#fff7ed] shadow-[inset_0_0_0_1px_#fdba74]',
    badge: 'border-[#fdba74] bg-[#ffedd5]'
  },
  teal: {
    chip: 'bg-[#f0fdfa] shadow-[inset_0_0_0_1px_#5eead4]',
    badge: 'border-[#5eead4] bg-[#ccfbf1]'
  },
  sky: {
    chip: 'bg-[#f0f9ff] shadow-[inset_0_0_0_1px_#7dd3fc]',
    badge: 'border-[#7dd3fc] bg-[#e0f2fe]'
  },
  rose: {
    chip: 'bg-[#fff1f2] shadow-[inset_0_0_0_1px_#fda4af]',
    badge: 'border-[#fda4af] bg-[#ffe4e6]'
  }
}

export function titleSuppressionToneForIndex(index: number): TitleSuppressionTone {
  return TITLE_SUPPRESSION_TONE_NAMES[index % TITLE_SUPPRESSION_TONE_NAMES.length]
}

export function createTitleSuppressionToneScope(
  parts: readonly { text: string }[],
  options: { usePaletteForSingle?: boolean } = {}
): TitleSuppressionToneScope {
  const useSuppressionTokenTones = options.usePaletteForSingle ? parts.length > 0 : parts.length > 1
  const suppressedTitleToneIndexByText = new Map<string, number>(
    parts.map((part, index) => [titleSuppressionKey(part.text), index])
  )
  const suppressedTitleToneByText = new Map<string, TitleSuppressionTone | ''>(
    parts.map((part, index) => [
      titleSuppressionKey(part.text),
      useSuppressionTokenTones ? titleSuppressionToneForIndex(index) : ''
    ])
  )

  return { useSuppressionTokenTones, suppressedTitleToneIndexByText, suppressedTitleToneByText }
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
