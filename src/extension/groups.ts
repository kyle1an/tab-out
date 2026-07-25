/* ================================================================
   Chrome tab-group helpers

   isGroupedTab     — boolean check
   groupDotColor    — color hex for a groupId (real color when the
                       "tabGroups" permission is granted, else a
                       deterministic palette fallback)
   fetchTabGroupColors — populates the cache from chrome.tabGroups
   compareForKeep   — priority comparator used by dedup to choose the
                       canonical copy of a duplicated URL
   ================================================================ */

import { queryTabGroupsResult } from './browser-tabs-gateway.js'
import { unwrapSuspenderUrl } from './suspension.js'

type GroupedTabLike = {
  groupId?: number | undefined
}
type ScoredTabLike = GroupedTabLike & {
  id?: number | string | undefined
  url?: string | undefined
  active?: boolean | undefined
  pinned?: boolean | undefined
  windowId: number
  index?: number | undefined
  lastAccessed?: number | undefined
}

/**
 * isGroupedTab(tab) — true if the tab belongs to a Chrome tab group.
 * chrome.tabs exposes groupId in MV3 without needing the "tabGroups"
 * permission (that permission is only required to read group title/color).
 */
export function isGroupedTab(tab?: GroupedTabLike | null): boolean {
  return !!tab && tab.groupId != null && tab.groupId !== -1
}

/**
 * Chrome tab-group color names → hex (Material palette Chrome uses).
 * Source: https://developer.chrome.com/docs/extensions/reference/api/tabGroups#type-Color
 */
const CHROME_GROUP_COLOR_HEX = {
  grey: '#5F6368',
  blue: '#1A73E8',
  red: '#D93025',
  yellow: '#F9AB00',
  green: '#1E8E3E',
  pink: '#FF8BCB',
  purple: '#A142F4',
  cyan: '#007B83',
  orange: '#FA903E'
}

/**
 * Fallback palette used only if the "tabGroups" permission isn't granted —
 * deterministic per groupId so the dot color is at least stable across renders.
 */
const GROUP_DOT_COLORS = ['#5a9cff', '#ff9f43', '#2ecc71', '#d35400', '#9b59b6', '#16a085', '#e74c3c', '#34495e', '#f39c12']

let groupColorCache: Record<number, string> = {} // { groupId: '#hex' } from chrome.tabGroups.query

/**
 * fetchTabGroupColors() — populates the cache from the tabGroups API via
 * the Browser Tabs Gateway. A confirmed unavailable/empty API clears the
 * cache so dots use the deterministic palette. A transient rejection keeps
 * the last known colors instead of turning every group into a fallback color.
 */
export async function fetchTabGroupColors(): Promise<boolean> {
  const result = await queryTabGroupsResult()
  if (!result.ok) return false
  const next: Record<number, string> = {}
  for (const g of result.value) {
    next[g.id] = CHROME_GROUP_COLOR_HEX[g.color as keyof typeof CHROME_GROUP_COLOR_HEX] || '#999'
  }
  groupColorCache = next
  return true
}

/**
 * groupColorChanged(group) — returns true iff the incoming group's color
 * differs from what we last rendered. Updates the cache as a side effect
 * so subsequent calls reflect the new state. Used to gate tabGroups.onUpdated
 * so collapse/expand/title edits don't trigger a full dashboard re-render.
 */
export function groupColorChanged(group?: chrome.tabGroups.TabGroup | null): boolean {
  if (!group || group.id == null) return false
  const next = CHROME_GROUP_COLOR_HEX[group.color as keyof typeof CHROME_GROUP_COLOR_HEX] || '#999'
  const prev = groupColorCache[group.id]
  if (prev === next) return false
  groupColorCache[group.id] = next
  return true
}

/**
 * groupDotColor(groupId) — Chrome's actual group color when available;
 * otherwise a deterministic palette color from the id.
 */
export function groupDotColor(groupId?: number): string {
  if (groupId == null || groupId === -1) return 'transparent'
  if (groupColorCache[groupId]) return groupColorCache[groupId]
  return GROUP_DOT_COLORS[Math.abs(groupId) % GROUP_DOT_COLORS.length] ?? '#5a9cff'
}

/**
 * keepKeys(tab, currentWindowId) — priority keys for a tab, highest-first.
 * Every entry is "higher is better" so two key arrays compare lexically.
 *
 * Priority order (higher wins):
 *   active in current window > grouped > pinned >
 *   last touched (lastAccessed — Chrome stamps this at tab creation and
 *   refreshes it on activation, so it means "opened-or-viewed, most recent
 *   wins"; tab id breaks ties so a newer-opened copy wins when timestamps
 *   are equal or missing) >
 *   active in another window > non-suspended > in current window >
 *   lowest tab index
 */
function keepKeys(tab: ScoredTabLike, currentWindowId: number): number[] {
  const rawUrl = tab.url || ''
  const isSuspended = unwrapSuspenderUrl(rawUrl) !== rawUrl
  const numericId = typeof tab.id === 'number' ? tab.id : 0
  return [
    tab.active && tab.windowId === currentWindowId ? 1 : 0,
    isGroupedTab(tab) ? 1 : 0,
    tab.pinned ? 1 : 0,
    tab.lastAccessed ?? 0,
    numericId,
    tab.active ? 1 : 0,
    isSuspended ? 0 : 1,
    tab.windowId === currentWindowId ? 1 : 0,
    -(tab.index ?? 0)
  ]
}

/**
 * compareForKeep(a, b, currentWindowId) — ordering for which duplicate to
 * keep. Returns < 0 when `a` should be kept over `b` (sorts the keeper
 * first). Consumed only by the dedup policy's sort, so the ordering — not
 * any absolute score — is what matters.
 */
export function compareForKeep(a: ScoredTabLike, b: ScoredTabLike, currentWindowId: number): number {
  const aKeys = keepKeys(a, currentWindowId)
  const bKeys = keepKeys(b, currentWindowId)
  for (let i = 0; i < aKeys.length; i++) {
    const aKey = aKeys[i]
    const bKey = bKeys[i]
    if (aKey === undefined || bKey === undefined) continue
    if (aKey !== bKey) return bKey - aKey
  }
  return 0
}
