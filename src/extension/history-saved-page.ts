import { isSavedPageEligible, savedPageKeyForUrl, type SavedPageCandidate } from './saved-pages.js'
import type { TabHistoryEntry } from './types'

export type HistorySavePageTarget = SavedPageCandidate

export function historyEntrySaveTarget(entry: TabHistoryEntry): HistorySavePageTarget {
  return {
    url: entry.url,
    rawUrl: entry.rawUrl,
    title: entry.title,
    favIconUrl: entry.favIconUrl,
    isTabOut: false,
    isApp: !!entry.isApp
  }
}

export function isHistoryEntrySaveEligible(entry: TabHistoryEntry): boolean {
  return isSavedPageEligible(historyEntrySaveTarget(entry))
}

export function historyEntrySaved(entry: TabHistoryEntry, savedKeys: ReadonlySet<string> | null | undefined): boolean {
  const key = savedPageKeyForUrl(entry.url)
  return key !== '' && !!savedKeys?.has(key)
}
