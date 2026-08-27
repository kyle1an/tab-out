import type {
  DesktopWindowMergeJournal,
  DesktopWindowMergeRequestFailureReason,
} from './desktop-window-merge-contract.js'

/**
 * User-facing Desktop Window Merge copy shared by the dashboard merge host
 * (dialog + toasts) and the toolbar Tab Actions Menu (disabled-item captions),
 * so both surfaces explain the same failure the same way.
 */
export function desktopWindowMergeFailureMessage(
  reason: DesktopWindowMergeRequestFailureReason,
): string {
  switch (reason) {
    case 'browser-read-failed':
      return 'Could not read the current Chrome windows'
    case 'controller-update-required':
      return 'Update or restart the Tab Out Hammerspoon integration'
    case 'coordination-unavailable':
      return 'Window merge coordination is unavailable in this Chrome session'
    case 'desktop-selection-unavailable':
      return 'Could not safely identify the windows on this desktop'
    case 'native-integration-required':
      return 'Set up the Tab Out macOS integration to merge windows'
    case 'session-storage-unavailable':
      return 'Window merge status storage is unavailable'
  }
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`
}

export function desktopWindowMergeSuccessMessage(journal: DesktopWindowMergeJournal): string {
  return `Merged ${countLabel(journal.movedTabCount, 'tab')} from ${countLabel(journal.sourceWindowCount, 'other window')}.`
}
