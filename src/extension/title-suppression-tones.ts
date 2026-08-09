/* ================================================================
   Title Suppression tone allocation — the palette rules from
   CONTEXT.md live here, on the view-model side of the seam, so
   suppression tokens cross into rendering already carrying their
   tone. Components keep only tone → class tables
   (src/components/title-suppression.ts).

   Rules encoded (CONTEXT.md):
   • tones are allocated by token coverage (count) before summary
     position; ties keep reading order;
   • a neutral single-token scope (no cross-group spanning) consumes
     no palette color;
   • palette colors are reused only after the four tones are
     exhausted within one Domain Card (index wraps);
   • one running tone index walks card scope → each subdomain
     section → its website-path sections → their path groups, so two
     visible suppression meanings in one card never share a color
     until the palette runs out.
   ================================================================ */

import { compareNumericText } from './numeric-sort.js'
import type { DashboardSectionVM, DashboardTitleSuppression, DashboardWebsitePathSectionVM } from './types'
import type { TitleSuppressionTone, TitleSuppressionToneScope } from './title-suppression-types.js'

export type { TitleSuppressionTone, TitleSuppressionToneScope } from './title-suppression-types.js'

const TITLE_SUPPRESSION_TONE_NAMES = ['amber', 'teal', 'sky', 'rose'] as const satisfies readonly TitleSuppressionTone[]

// Tone lookups are plain records, not Maps: tone scopes ride the view-model
// into the startup-snapshot cache, and chrome.storage silently serializes a
// Map to {} — a revived Map crashes the first `.get` after a page refresh.
const EMPTY_TITLE_SUPPRESSION_TONE_SCOPE: TitleSuppressionToneScope = {
  useSuppressionTokenTones: false,
  suppressedTitleToneIndexByText: {},
  suppressedTitleToneByText: {},
  usedToneCount: 0,
}

/** Neutral scope for VMs that skipped the compute walk (hand-built test data). */
export function emptyTitleSuppressionToneScope(): TitleSuppressionToneScope {
  return EMPTY_TITLE_SUPPRESSION_TONE_SCOPE
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

export function titleSuppressionToneForIndex(index: number): TitleSuppressionTone {
  return TITLE_SUPPRESSION_TONE_NAMES[index % TITLE_SUPPRESSION_TONE_NAMES.length] ?? 'amber'
}

export function titleSuppressionToneForText(
  text: string,
  toneByText?: Readonly<Record<string, TitleSuppressionTone | ''>>,
): TitleSuppressionTone | '' {
  // typeof guards against inherited keys ('constructor') on storage-revived records.
  const tone = toneByText?.[titleSuppressionKey(text)]
  return typeof tone === 'string' ? tone : ''
}

export function createTitleSuppressionToneScope(
  parts: readonly TitleSuppressionTonePart[],
  { startToneIndex = 0 }: TitleSuppressionToneScopeOptions = {},
): TitleSuppressionToneScope {
  const useSuppressionTokenTones = parts.length > 1 || parts.some((part) => !!part.spansRenderedChildGroups)
  const toneOrderedParts = [...parts]
    .map((part, displayIndex) => ({ part, displayIndex }))
    .sort((a, b) => (b.part.count ?? 0) - (a.part.count ?? 0) || a.displayIndex - b.displayIndex || compareNumericText(a.part.text, b.part.text))
  const toneIndexByText = new Map<string, number>(
    toneOrderedParts.map(({ part }, toneOffset) => [titleSuppressionKey(part.text), startToneIndex + toneOffset]),
  )
  const suppressedTitleToneIndexByText = Object.fromEntries(
    parts.map((part, index) => [titleSuppressionKey(part.text), toneIndexByText.get(titleSuppressionKey(part.text)) ?? startToneIndex + index]),
  ) as Record<string, number>
  const suppressedTitleToneByText = Object.fromEntries(
    parts.map((part) => [
      titleSuppressionKey(part.text),
      useSuppressionTokenTones ? titleSuppressionToneForIndex(toneIndexByText.get(titleSuppressionKey(part.text)) ?? startToneIndex) : '',
    ]),
  ) as Record<string, TitleSuppressionTone | ''>

  return {
    useSuppressionTokenTones,
    suppressedTitleToneIndexByText,
    suppressedTitleToneByText,
    usedToneCount: useSuppressionTokenTones ? parts.length : 0,
  }
}

function mergeTitleSuppressionToneMaps(
  ...maps: Array<Readonly<Record<string, TitleSuppressionTone | ''>> | undefined>
): Readonly<Record<string, TitleSuppressionTone | ''>> {
  const merged: Record<string, TitleSuppressionTone | ''> = {}
  for (const map of maps) {
    if (!map) continue
    Object.assign(merged, map)
  }
  return merged
}

export type CardSuppressionTones = {
  cardSuppressionToneScope: TitleSuppressionToneScope
  sections: DashboardSectionVM[]
}

/**
 * allocateCardSuppressionTones — one running tone index across the whole
 * card tree (card scope, then each section, its website-path sections, and
 * their path groups), returning new section objects whose tone scope and
 * merged parent→child tone map ride the view-model across the seam.
 */
export function allocateCardSuppressionTones(
  suppressedTitleParts: readonly DashboardTitleSuppression[],
  sections: readonly DashboardSectionVM[],
): CardSuppressionTones {
  let nextTitleSuppressionToneIndex = 0

  function allocateTitleSuppressionToneScope(parts: readonly TitleSuppressionTonePart[]) {
    const scope = createTitleSuppressionToneScope(parts, { startToneIndex: nextTitleSuppressionToneIndex })
    nextTitleSuppressionToneIndex += scope.usedToneCount
    return scope
  }

  const cardSuppressionToneScope = allocateTitleSuppressionToneScope(suppressedTitleParts)
  const tonedSections: DashboardSectionVM[] = sections.map((section) => {
    const sectionSuppressionToneScope = allocateTitleSuppressionToneScope(section.suppressedTitleParts ?? [])
    const sectionSuppressedTitleToneByText = mergeTitleSuppressionToneMaps(
      cardSuppressionToneScope.suppressedTitleToneByText,
      sectionSuppressionToneScope.suppressedTitleToneByText,
    )
    const tonedWebsitePathSections: DashboardWebsitePathSectionVM[] = (section.websitePathSections ?? []).map((websitePathSection) => {
      const websitePathSectionSuppressionToneScope = allocateTitleSuppressionToneScope(websitePathSection.suppressedTitleParts ?? [])
      const websitePathSectionSuppressedTitleToneByText = mergeTitleSuppressionToneMaps(
        sectionSuppressedTitleToneByText,
        websitePathSectionSuppressionToneScope.suppressedTitleToneByText,
      )

      return {
        ...websitePathSection,
        titleSuppressionToneScope: websitePathSectionSuppressionToneScope,
        suppressedTitleToneByText: websitePathSectionSuppressedTitleToneByText,
        clusters: websitePathSection.clusters.map((cluster) => {
          const clusterSuppressionToneScope = allocateTitleSuppressionToneScope(cluster.suppressedTitleParts ?? [])
          return {
            ...cluster,
            titleSuppressionToneScope: clusterSuppressionToneScope,
            suppressedTitleToneByText: mergeTitleSuppressionToneMaps(
              websitePathSectionSuppressedTitleToneByText,
              clusterSuppressionToneScope.suppressedTitleToneByText,
            ),
          }
        }),
      }
    })

    return {
      ...section,
      titleSuppressionToneScope: sectionSuppressionToneScope,
      suppressedTitleToneByText: sectionSuppressedTitleToneByText,
      websitePathSections: tonedWebsitePathSections,
      clusters: section.clusters.map((cluster) => {
        const clusterSuppressionToneScope = allocateTitleSuppressionToneScope(cluster.suppressedTitleParts ?? [])
        return {
          ...cluster,
          titleSuppressionToneScope: clusterSuppressionToneScope,
          suppressedTitleToneByText: mergeTitleSuppressionToneMaps(
            sectionSuppressedTitleToneByText,
            clusterSuppressionToneScope.suppressedTitleToneByText,
          ),
        }
      }),
    }
  })

  return { cardSuppressionToneScope, sections: tonedSections }
}
