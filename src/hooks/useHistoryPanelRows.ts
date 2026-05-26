import { useMemo } from 'react'
import type { TabHistoryEntry, TabHistorySnapshot, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import type { ClosedTabEntry } from '../extension/closed-tabs.js'
import { tabMatchesFilter } from '../extension/filter-match.js'
import { pageIdentityForWorkingSet } from '../extension/working-set.js'

export type HistoryPanelRow =
  | { kind: 'stack'; entry: TabHistoryEntry; lastTouchedAt: number }
  | { kind: 'open-ghost'; item: WorkingSetItem; lastTouchedAt: number }
  | { kind: 'closed-ghost'; closed: ClosedTabEntry; lastTouchedAt: number }

export interface UseHistoryPanelRowsArgs {
  snapshot: TabHistorySnapshot | null
  workingSet: WorkingSetSnapshot | null
  closedTabs: readonly ClosedTabEntry[]
  filter: string
}

export function buildHistoryPanelRows({ snapshot, workingSet, closedTabs, filter }: UseHistoryPanelRowsArgs): HistoryPanelRow[] {
  const filterActive = filter.trim() !== ''

  const stackEntries = snapshot?.entries ?? []
  const stackBaseTimestamp = stackEntries.reduce(
    (max, entry) => Math.max(max, entry.lastActivatedAt ?? 0),
    0
  )
  const stackCursorIndex = snapshot?.currentIndex ?? stackEntries.length - 1
  const stackCandidates: HistoryPanelRow[] = []
  for (const entry of stackEntries) {
    if (filterActive && !tabMatchesFilter({ title: entry.title, url: entry.url, isTabOut: false }, filter)) continue
    const cursorDistance = Math.abs(entry.index - stackCursorIndex)
    const synthesizedTouchedAt = stackBaseTimestamp > 0
      ? stackBaseTimestamp - cursorDistance
      : -cursorDistance
    const lastTouchedAt = entry.lastActivatedAt ?? synthesizedTouchedAt
    stackCandidates.push({ kind: 'stack', entry, lastTouchedAt })
  }

  const openGhostCandidates: HistoryPanelRow[] = []
  for (const item of workingSet?.items ?? []) {
    if (filterActive && !tabMatchesFilter({ title: item.title, url: item.tabUrl, isTabOut: false }, filter)) continue
    openGhostCandidates.push({ kind: 'open-ghost', item, lastTouchedAt: item.lastActivatedAt })
  }

  const closedGhostCandidates: HistoryPanelRow[] = []
  for (const closed of closedTabs) {
    if (filterActive && !tabMatchesFilter({ title: closed.title, url: closed.url, isTabOut: false }, filter)) continue
    closedGhostCandidates.push({ kind: 'closed-ghost', closed, lastTouchedAt: closed.lastClosedAt })
  }

  const seen = new Set<string>()
  const rows: HistoryPanelRow[] = []

  function consume(candidate: HistoryPanelRow, identity: string | undefined) {
    if (!identity) {
      rows.push(candidate)
      return
    }
    if (seen.has(identity)) return
    seen.add(identity)
    rows.push(candidate)
  }

  for (const row of stackCandidates) {
    if (row.kind !== 'stack') continue
    consume(row, pageIdentityForWorkingSet(row.entry.url))
  }
  for (const row of openGhostCandidates) {
    if (row.kind !== 'open-ghost') continue
    consume(row, row.item.key)
  }
  for (const row of closedGhostCandidates) {
    if (row.kind !== 'closed-ghost') continue
    consume(row, pageIdentityForWorkingSet(row.closed.url))
  }

  rows.sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
  return rows
}

export function useHistoryPanelRows({ snapshot, workingSet, closedTabs, filter }: UseHistoryPanelRowsArgs): HistoryPanelRow[] {
  return useMemo(
    () => buildHistoryPanelRows({ snapshot, workingSet, closedTabs, filter }),
    [snapshot, workingSet, closedTabs, filter]
  )
}
