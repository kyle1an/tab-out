import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { closeHistoryEntry, fetchTabHistorySnapshot, focusHistoryEntry } from '../tab-history.js'
import { markClosure } from '../undo.js'
import { showToast } from './Toast.js'

const html = htm.bind(h)

function entryClass(entry) {
  return [
    'history-entry',
    entry.current ? 'is-current' : '',
    entry.active ? 'is-active' : '',
    entry.previousTarget ? 'is-previous-target' : '',
    entry.nextTarget ? 'is-next-target' : ''
  ]
    .filter(Boolean)
    .join(' ')
}

function entryBadges(entry, snapshot) {
  const badges = []
  if (entry.active && !entry.current) badges.push('Active')
  if (entry.cursor && !entry.current) badges.push('Cursor')
  if (snapshot.activeWasInserted && entry.current) badges.push('Pending')
  if (entry.pinned) badges.push('Pinned')
  return badges
}

function HistoryEntry({ entry, snapshot, onSnapshotChange, onHoverUrlChange, onTabsChange }) {
  async function refreshAfterMutation() {
    if (onTabsChange) {
      await onTabsChange()
      return
    }
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  async function onFocusEntry() {
    const focused = await focusHistoryEntry(entry)
    if (!focused) return
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  async function onCloseEntry(e) {
    e.stopPropagation()
    const row = e.currentTarget.closest('.history-entry')
    const result = await closeHistoryEntry(entry)
    if (!result.closed) {
      showToast('Nothing to close')
      return
    }

    row?.classList.add('closing')
    await new Promise((resolve) => setTimeout(resolve, 160))
    onHoverUrlChange?.('')
    await refreshAfterMutation()

    if (result.snapshot.length > 0) {
      markClosure(result.snapshot, 'Tab closed')
    } else {
      showToast('Tab closed')
    }
  }

  function onMouseEnter() {
    onHoverUrlChange?.(entry.url || '')
  }

  function onMouseLeave() {
    onHoverUrlChange?.('')
  }

  const badges = entryBadges(entry, snapshot)

  return html`
    <div
      class=${entryClass(entry)}
      title=${entry.url || entry.displayUrl}
      onMouseEnter=${onMouseEnter}
      onMouseLeave=${onMouseLeave}
      onFocus=${onMouseEnter}
      onBlur=${onMouseLeave}
    >
      <button type="button" class="history-entry-main" disabled=${!entry.exists} onClick=${onFocusEntry}>
        <span class="history-entry-index">${entry.index + 1}</span>
        ${entry.favIconUrl &&
        html`
          <span class="history-favicon-frame">
            <img class="history-favicon" src=${entry.favIconUrl} alt="" />
          </span>
        `}
        <span class="history-entry-copy">
          <span class="history-entry-title">${entry.title}</span>
          <span class="history-entry-url">${entry.displayUrl}</span>
        </span>
        <span class="history-entry-badges">
          ${badges.map((badge) => html`<span class="history-badge">${badge}</span>`)}
        </span>
      </button>
      <button class="history-entry-close" type="button" disabled=${!entry.exists} title="Close this tab" aria-label=${`Close ${entry.title}`} onClick=${onCloseEntry}>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  `
}

export function TabHistoryPanel({ snapshot, onSnapshotChange, onHoverUrlChange, onTabsChange }) {
  const entries = snapshot?.entries || []
  const displayEntries = entries.slice().reverse()
  const countLabel = snapshot?.maxSize ? `${snapshot.stackSize}/${snapshot.maxSize}` : '0'

  return html`
    <section class="tab-history-panel" aria-label="Activation history">
      <div class="tab-history-header">
        <div class="tab-history-title">Activation history</div>
        <div class="tab-history-meta">${countLabel}</div>
      </div>
      <div class="tab-history-strip">
        <div class="history-entry-list">
          ${displayEntries.length > 0
            ? displayEntries.map(
                (entry) =>
                  html`<${HistoryEntry}
                    key=${`${entry.windowId}:${entry.tabId}:${entry.index}`}
                    entry=${entry}
                    snapshot=${snapshot}
                    onSnapshotChange=${onSnapshotChange}
                    onHoverUrlChange=${onHoverUrlChange}
                    onTabsChange=${onTabsChange}
                  />`
              )
            : html`<div class="history-empty">No activation history yet.</div>`}
        </div>
      </div>
    </section>
  `
}
