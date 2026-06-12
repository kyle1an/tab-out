import { makeDashboardItem } from './dashboard-item.js'
import type { BookmarkTreeNode, DashboardTab } from './types'

/**
 * Flatten a Chrome bookmarks tree into DashboardTab-shaped entries so the
 * existing grouping/render pipeline can treat bookmarks as a read-only
 * source.
 *
 * @param {BookmarkTreeNode[]} nodes
 * @returns {DashboardTab[]}
 */
export function flattenBookmarkNodes(nodes: BookmarkTreeNode[]): DashboardTab[] {
  const flattened: DashboardTab[] = []

  function visit(node?: BookmarkTreeNode) {
    if (!node) return
    if (node.url) {
      flattened.push(makeDashboardItem({
        id: node.id,
        url: node.url,
        title: node.title || '',
        sourceType: 'bookmark'
      }))
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(visit)
    }
  }

  nodes.forEach(visit)
  return flattened
}

/**
 * Fetch the full bookmarks tree and flatten it into dashboard items.
 *
 * @returns {Promise<DashboardTab[]>}
 */
export async function fetchBookmarksSourceItems(): Promise<DashboardTab[]> {
  if (!chrome.bookmarks?.getTree) return []
  try {
    const tree = await chrome.bookmarks.getTree()
    return flattenBookmarkNodes(tree)
  } catch {
    return []
  }
}
