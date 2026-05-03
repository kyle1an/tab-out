/* ================================================================
   Chrome tab-group helpers

   isGroupedTab     — boolean check
   groupDotColor    — color hex for a groupId (real color when the
                       "tabGroups" permission is granted, else a
                       deterministic palette fallback)
   fetchTabGroupColors — populates the cache from chrome.tabGroups
   scoreForKeep     — priority score used by dedup to choose the
                       canonical copy of a duplicated URL
   ================================================================ */

import { unwrapSuspenderUrl } from './suspender.js'

/**
 * isGroupedTab(tab) — true if the tab belongs to a Chrome tab group.
 * chrome.tabs exposes groupId in MV3 without needing the "tabGroups"
 * permission (that permission is only required to read group title/color).
 */
export function isGroupedTab(tab) {
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

let groupColorCache = {} // { groupId: '#hex' } from chrome.tabGroups.query

/**
 * fetchTabGroupColors() — populates the cache from the tabGroups API.
 * No-ops if the permission isn't granted (cache stays empty; dots fall
 * back to the deterministic palette).
 */
export async function fetchTabGroupColors() {
  if (!chrome.tabGroups) {
    groupColorCache = {}
    return
  }
  try {
    const groups = await chrome.tabGroups.query({})
    const next = {}
    for (const g of groups) {
      next[g.id] = CHROME_GROUP_COLOR_HEX[g.color] || '#999'
    }
    groupColorCache = next
  } catch {
    // Permission missing or API unavailable — keep last cache as best-effort
  }
}

/**
 * groupColorChanged(group) — returns true iff the incoming group's color
 * differs from what we last rendered. Updates the cache as a side effect
 * so subsequent calls reflect the new state. Used to gate tabGroups.onUpdated
 * so collapse/expand/title edits don't trigger a full dashboard re-render.
 */
export function groupColorChanged(group) {
  if (!group || group.id == null) return false
  const next = CHROME_GROUP_COLOR_HEX[group.color] || '#999'
  const prev = groupColorCache[group.id]
  if (prev === next) return false
  groupColorCache[group.id] = next
  return true
}

/**
 * groupDotColor(groupId) — Chrome's actual group color when available;
 * otherwise a deterministic palette color from the id.
 */
export function groupDotColor(groupId) {
  if (groupId == null || groupId === -1) return 'transparent'
  if (groupColorCache[groupId]) return groupColorCache[groupId]
  return GROUP_DOT_COLORS[Math.abs(groupId) % GROUP_DOT_COLORS.length]
}

/**
 * scoreForKeep(tab, currentWindowId) — priority score for which duplicate
 * to keep. Higher score wins.
 *
 * Priority order:
 *   active in current window > active in any window > grouped > pinned >
 *   non-suspended > in current window > lowest tab index
 */
export function scoreForKeep(tab, currentWindowId) {
  const rawUrl = tab.url || ''
  const isSuspended = unwrapSuspenderUrl(rawUrl) !== rawUrl
  const grouped = isGroupedTab(tab)
  let s = 0
  if (tab.active && tab.windowId === currentWindowId) s += 10000
  else if (tab.active) s += 5000
  if (grouped) s += 1000
  if (tab.pinned) s += 500
  if (!isSuspended) s += 200
  if (tab.windowId === currentWindowId) s += 50
  s -= (tab.index || 0) * 0.001 // stable tiebreaker: prefer leftmost
  return s
}
