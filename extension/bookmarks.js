/** @typedef {import('./types').DashboardTab} DashboardTab */

/**
 * Flatten a Chrome bookmarks tree into DashboardTab-shaped entries so the
 * existing grouping/render pipeline can treat bookmarks as a read-only
 * source.
 *
 * @param {Array<{ id?: string, title?: string, url?: string, children?: any[] }>} nodes
 * @returns {DashboardTab[]}
 */
export function flattenBookmarkNodes(nodes) {
  const flattened = []

  function visit(node) {
    if (!node) return
    if (node.url) {
      flattened.push({
        id: node.id,
        url: node.url,
        rawUrl: node.url,
        suspended: false,
        title: node.title || '',
        favIconUrl: '',
        windowId: 1,
        active: false,
        pinned: false,
        groupId: -1,
        isTabOut: false,
        isApp: false,
        sourceType: 'bookmark'
      })
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
export async function fetchBookmarksSourceItems() {
  if (!chrome.bookmarks?.getTree) return []
  try {
    const tree = await chrome.bookmarks.getTree()
    return flattenBookmarkNodes(tree)
  } catch {
    return []
  }
}
