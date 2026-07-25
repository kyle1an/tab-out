import { useMemo } from 'react'
import type { TabHistoryEntry, TabHistorySnapshot, WorkingSetItem, WorkingSetSnapshot } from '../extension/types'
import type { ClosedTabEntry } from '../extension/closed-tabs.js'
import { isClosedGhostDismissed, type ClosedGhostDismissals } from '../extension/closed-ghost-dismissals.js'
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
  dismissedClosedGhosts?: ClosedGhostDismissals | null
}

const DEFAULT_HISTORY_PANEL_ROW_LIMIT = 48

function historyPanelRowLimit(snapshot: TabHistorySnapshot | null): number {
  const maxSize = snapshot?.maxSize
  return typeof maxSize === 'number' && Number.isInteger(maxSize) && maxSize > 0 ? maxSize : DEFAULT_HISTORY_PANEL_ROW_LIMIT
}

export function buildHistoryPanelRows({ snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts }: UseHistoryPanelRowsArgs): HistoryPanelRow[] {
  const filterActive = filter.trim() !== ''
  const rowLimit = historyPanelRowLimit(snapshot)

  const stackEntries = snapshot?.entries ?? []
  const stackBaseTimestamp = stackEntries.reduce(
    (max, entry) => Math.max(max, entry.lastActivatedAt ?? entry.createdAt ?? 0),
    0
  )
  const stackCursorIndex = snapshot?.currentIndex ?? stackEntries.length - 1

  // Collect each stack entry with its cursor distance and a "base" timestamp:
  // the real activity-log value when present, else a synthesized fallback
  // derived from cursor distance.
  const rawStackCandidates: Array<{ entry: TabHistoryEntry; cursorDistance: number; base: number }> = []
  for (const entry of stackEntries) {
    if (filterActive && !tabMatchesFilter({ title: entry.title, url: entry.url, isTabOut: false }, filter)) continue
    const cursorDistance = Math.abs(entry.index - stackCursorIndex)
    const synthesizedTouchedAt = stackBaseTimestamp > 0
      ? stackBaseTimestamp - cursorDistance
      : -cursorDistance
    rawStackCandidates.push({
      entry,
      cursorDistance,
      base: entry.lastActivatedAt ?? entry.createdAt ?? synthesizedTouchedAt
    })
  }
  rawStackCandidates.sort((a, b) => a.cursorDistance - b.cursorDistance)

  // These indexed entries form the current tab's linear navigation chain:
  // activated back/forward history first, followed by pending background tabs.
  // A back entry whose URL was recently touched in ANOTHER tab carries a fresh
  // activity-log timestamp that would otherwise float it above closer entries
  // (the Image #11 bug). Walking outward from the cursor and clamping each
  // effective timestamp strictly below the previous one pins the indexed rows
  // into navigation order, while leaving gaps where ghost rows still interleave
  // by their own real timestamps.
  const stackCandidates: Array<{ row: HistoryPanelRow; cursorDistance: number }> = []
  let previousStackEffective = Number.POSITIVE_INFINITY
  for (const { entry, cursorDistance, base } of rawStackCandidates) {
    const lastTouchedAt = Math.min(base, previousStackEffective - 1)
    previousStackEffective = lastTouchedAt
    stackCandidates.push({ row: { kind: 'stack', entry, lastTouchedAt }, cursorDistance })
  }

  const openGhostCandidates: HistoryPanelRow[] = []
  for (const item of workingSet?.items ?? []) {
    if (filterActive && !tabMatchesFilter({ title: item.title, url: item.tabUrl, isTabOut: false }, filter)) continue
    openGhostCandidates.push({ kind: 'open-ghost', item, lastTouchedAt: item.lastActivatedAt })
  }

  const closedGhostCandidates: HistoryPanelRow[] = []
  for (const closed of closedTabs) {
    if (filterActive && !tabMatchesFilter({ title: closed.title, url: closed.url, isTabOut: false }, filter)) continue
    // `null` is an explicit unknown state used by the mounted panel while its
    // durable dismissal read is unresolved or failed. Showing Chrome's
    // recently-closed rows then could briefly revive pages the user forgot.
    // An omitted value remains the pure builder's backwards-compatible
    // "no dismissal filtering requested" behavior.
    if (dismissedClosedGhosts === null) continue
    if (isClosedGhostDismissed(dismissedClosedGhosts, closed)) continue
    closedGhostCandidates.push({ kind: 'closed-ghost', closed, lastTouchedAt: closed.lastClosedAt })
  }

  const seen = new Set<string>()
  const rows: HistoryPanelRow[] = []

  function consume(candidate: HistoryPanelRow, identity: string | undefined, allowDuplicate = false) {
    if (!allowDuplicate && identity && seen.has(identity)) return
    if (rows.length >= rowLimit) return
    if (identity) seen.add(identity)
    rows.push(candidate)
  }

  for (const { row } of stackCandidates) {
    if (row.kind !== 'stack') continue
    consume(
      row,
      pageIdentityForWorkingSet(row.entry.url) || row.entry.url,
      !!row.entry.pending
    )
  }
  for (const row of openGhostCandidates) {
    if (row.kind !== 'open-ghost') continue
    consume(row, row.item.key || row.item.tabUrl)
  }
  for (const row of closedGhostCandidates) {
    if (row.kind !== 'closed-ghost') continue
    consume(row, pageIdentityForWorkingSet(row.closed.url) || row.closed.url)
  }

  rows.sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
  return rows
}

export function useHistoryPanelRows({ snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts }: UseHistoryPanelRowsArgs): HistoryPanelRow[] {
  return useMemo(
    () => buildHistoryPanelRows({
      snapshot,
      workingSet,
      closedTabs,
      filter,
      ...(dismissedClosedGhosts === undefined ? {} : { dismissedClosedGhosts })
    }),
    [snapshot, workingSet, closedTabs, filter, dismissedClosedGhosts]
  )
}
