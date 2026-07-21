import type { HistorySearchSummary } from '../extension/types'

export type HistorySearchStatusCopy = {
  detail: string
  title: string
}

function pluralMatches(count: number) {
  return count === 1 ? 'match' : 'matches'
}

export function historySearchStatusCopy(summary: HistorySearchSummary): HistorySearchStatusCopy {
  if (summary.phase === 'searching') {
    return {
      title: 'Searching History…',
      detail: 'Checking the selected range.'
    }
  }

  if (summary.phase === 'error') {
    return {
      title: 'History update failed',
      detail: summary.visibleMatches > 0
        ? 'Previous results remain below.'
        : 'Try the search again.'
    }
  }

  const settled = (() => {
    if (summary.totalMatches === 0) {
      return {
        title: 'No History matches',
        detail: 'Try a wider range.'
      }
    }
    if (summary.dedupedMatches === 0) {
      return {
        title: `${summary.totalMatches} History ${pluralMatches(summary.totalMatches)}`,
        detail: 'All appear below.'
      }
    }
    if (summary.visibleMatches === 0) {
      return {
        title: `${summary.dedupedMatches} shown in Tabs`,
        detail: 'Not repeated below.'
      }
    }
    return {
      title: `${summary.dedupedMatches} of ${summary.totalMatches} shown in Tabs`,
      detail: `${summary.visibleMatches} more appear below.`
    }
  })()

  return summary.phase === 'updating'
    ? { title: settled.title, detail: 'Updating…' }
    : settled
}
