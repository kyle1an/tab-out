export type TitleSuppressionTone = 'amber' | 'teal' | 'sky' | 'rose'

export interface TitleSuppressionToneScope {
  useSuppressionTokenTones: boolean
  suppressedTitleToneIndexByText: Readonly<Record<string, number>>
  suppressedTitleToneByText: Readonly<Record<string, TitleSuppressionTone | ''>>
  usedToneCount: number
}
