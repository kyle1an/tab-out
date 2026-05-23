import { requestDashboardRefresh } from './dashboard-controller.js'
import {
  addSavedPageToStore,
  loadSavedPagesStore,
  removeSavedPageFromStore,
  restoreSavedPageToStore,
  saveSavedPagesStore
} from './saved-pages.js'
import { showToast } from './toast.js'
import type { DashboardTab } from './types'

type SavedPageActionTarget = Pick<DashboardTab, 'url' | 'rawUrl' | 'title' | 'favIconUrl' | 'isTabOut' | 'isApp'>

export async function savePageTarget(target: SavedPageActionTarget): Promise<void> {
  const store = await loadSavedPagesStore()
  const nextStore = addSavedPageToStore(store, target)
  await saveSavedPagesStore(nextStore)
  await requestDashboardRefresh({ animateCards: true })
  showToast('Page saved')
}

export async function removeSavedPageTarget(keyOrUrl: string): Promise<void> {
  const store = await loadSavedPagesStore()
  const { store: nextStore, removed } = removeSavedPageFromStore(store, keyOrUrl)
  await saveSavedPagesStore(nextStore)
  await requestDashboardRefresh({ animateCards: true })
  if (!removed) return

  showToast('Saved page removed', {
    label: 'Undo',
    description: 'Restore this saved page.',
    onClick: async () => {
      const latestStore = await loadSavedPagesStore()
      await saveSavedPagesStore(restoreSavedPageToStore(latestStore, removed))
      await requestDashboardRefresh({ animateCards: true })
    }
  })
}
