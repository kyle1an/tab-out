import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { fetchTabHistorySnapshot, focusHistoryEntry } from '../tab-history.js'

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
  if (entry.previousTarget) badges.push('Prev')
  if (entry.nextTarget) badges.push('Next')
  if (entry.active && !entry.current) badges.push('Active')
  if (entry.cursor && !entry.current) badges.push('Cursor')
  if (snapshot.activeWasInserted && entry.current) badges.push('Pending')
  if (entry.pinned) badges.push('Pinned')
  return badges
}

function HistoryEntry({ entry, snapshot, onSnapshotChange, onHoverUrlChange }) {
  async function onFocusEntry() {
    const focused = await focusHistoryEntry(entry)
    if (!focused) return
    onSnapshotChange?.(await fetchTabHistorySnapshot())
  }

  function onMouseEnter() {
    onHoverUrlChange?.(entry.url || '')
  }

  function onMouseLeave() {
    onHoverUrlChange?.('')
  }

  const badges = entryBadges(entry, snapshot)

  return html`
    <button
      type="button"
      class=${entryClass(entry)}
      disabled=${!entry.exists}
      title=${entry.url || entry.displayUrl}
      onClick=${onFocusEntry}
      onMouseEnter=${onMouseEnter}
      onMouseLeave=${onMouseLeave}
      onFocus=${onMouseEnter}
      onBlur=${onMouseLeave}
    >
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
  `
}

export function TabHistoryPanel({ snapshot, onSnapshotChange, onHoverUrlChange }) {
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
                  />`
              )
            : html`<div class="history-empty">No activation history yet.</div>`}
        </div>
      </div>
    </section>
  `
}
