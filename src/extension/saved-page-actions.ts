import { requestDashboardRefresh } from './dashboard-intake.js'
import {
  addSavedPageToStore,
  mutateSavedPagesStore,
  removeSavedPageFromStore,
  restoreSavedPageToStore,
  type SavedPageRecord
} from './saved-pages.js'
import { showToast } from './toast.js'
import type { DashboardTab } from './types'

type SavedPageActionTarget = Pick<DashboardTab, 'url' | 'rawUrl' | 'title' | 'favIconUrl' | 'isTabOut' | 'isApp'>

type SavedPageActionDependencies = {
  mutate: typeof mutateSavedPagesStore
  refresh: typeof requestDashboardRefresh
  notify: typeof showToast
}

/**
 * Own the failure boundary for user-triggered Saved Page actions. Context-menu
 * callbacks and toast actions are fire-and-forget, so expected storage and
 * refresh failures must be converted to feedback before they reach the UI.
 */
export function createSavedPageActions({ mutate, refresh, notify }: SavedPageActionDependencies) {
  async function savePageTarget(target: SavedPageActionTarget): Promise<void> {
    try {
      await mutate((store) => ({
        store: addSavedPageToStore(store, target),
        value: undefined
      }))
    } catch {
      notify("Couldn't save the page")
      return
    }

    try {
      await refresh({ animateCards: true })
    } catch {
      notify("Page saved, but couldn't refresh the dashboard")
      return
    }

    notify('Page saved')
  }

  async function removeSavedPageTarget(keyOrUrl: string): Promise<void> {
    let removed: SavedPageRecord | null
    try {
      removed = await mutate((store) => {
        const result = removeSavedPageFromStore(store, keyOrUrl)
        return { store: result.store, value: result.removed }
      })
    } catch {
      notify("Couldn't remove the saved page")
      return
    }

    const undoAction = removed
      ? {
          label: 'Undo',
          description: 'Restore this saved page.',
          onClick: async () => {
            try {
              await mutate((store) => ({
                store: restoreSavedPageToStore(store, removed),
                value: undefined
              }))
            } catch {
              notify("Couldn't restore the saved page")
              return
            }

            try {
              await refresh({ animateCards: true })
            } catch {
              notify("Saved page restored, but couldn't refresh the dashboard")
            }
          }
        }
      : null

    try {
      await refresh({ animateCards: true })
    } catch {
      if (undoAction) {
        notify("Saved page removed, but couldn't refresh the dashboard", undoAction)
      } else {
        notify("Couldn't refresh the dashboard")
      }
      return
    }

    if (undoAction) notify('Saved page removed', undoAction)
  }

  return { savePageTarget, removeSavedPageTarget }
}

const savedPageActions = createSavedPageActions({
  mutate: mutateSavedPagesStore,
  refresh: requestDashboardRefresh,
  notify: showToast
})

export const { savePageTarget, removeSavedPageTarget } = savedPageActions
