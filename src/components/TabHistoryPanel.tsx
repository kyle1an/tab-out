import { useEffect, useLayoutEffect, useRef } from 'react'
import { closeHistoryEntry, fetchTabHistorySnapshot, focusHistoryEntry } from '../../extension/tab-history.js'
import { markClosure } from '../../extension/undo.js'
import { showToast } from '../../extension/toast.js'

let historyTitleResizeObserver = null

function isHistoryTitleTruncated(titleEl) {
  if (!titleEl) return false
  return titleEl.scrollWidth - titleEl.clientWidth > 1
}

function syncHistoryTitleFade(titleEl) {
  if (!titleEl) return
  titleEl.classList.toggle('history-entry-title-truncated', isHistoryTitleTruncated(titleEl))
}

function getHistoryTitleResizeObserver() {
  if (typeof ResizeObserver !== 'function') return null
  if (!historyTitleResizeObserver) {
    historyTitleResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) syncHistoryTitleFade(entry.target)
    })
  }
  return historyTitleResizeObserver
}

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

function historyEntryIndexLabel(entry, snapshot, fallback) {
  if (Number.isInteger(entry.index) && Number.isInteger(snapshot?.currentIndex) && snapshot.currentIndex >= 0) {
    const relativeIndex = entry.index - snapshot.currentIndex
    if (relativeIndex < 0) {
      return (
        <>
          <span>-</span>
          <span>{Math.abs(relativeIndex)}</span>
        </>
      )
    }
    return String(relativeIndex)
  }
  return String(fallback)
}

function HistoryEntry({ entry, indexLabel, snapshot, onSnapshotChange, onHoverUrlChange, onTabsChange }) {
  const titleRef = useRef<HTMLSpanElement | null>(null)

  useLayoutEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    const frameId = requestAnimationFrame(() => syncHistoryTitleFade(titleEl))
    return () => cancelAnimationFrame(frameId)
  })

  useEffect(() => {
    const titleEl = titleRef.current
    if (!titleEl) return

    const observer = getHistoryTitleResizeObserver()
    observer?.observe(titleEl)

    const fontSet = document.fonts
    const onFontsDone = () => syncHistoryTitleFade(titleEl)
    fontSet?.addEventListener?.('loadingdone', onFontsDone)
    fontSet?.ready?.then?.(() => syncHistoryTitleFade(titleEl))

    return () => {
      observer?.unobserve(titleEl)
      fontSet?.removeEventListener?.('loadingdone', onFontsDone)
    }
  }, [])

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
    const row = e.currentTarget.closest('.history-entry-row')
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

  return (
    <div
      className="history-entry-row"
      title={entry.title || entry.displayUrl || entry.url}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onMouseEnter}
      onBlur={onMouseLeave}
    >
      <span className="history-entry-index">{indexLabel}</span>
      <div className={entryClass(entry)}>
        <button type="button" className="history-entry-main" disabled={!entry.exists} onClick={onFocusEntry}>
          <span className={'history-favicon-frame' + (!entry.favIconUrl ? ' is-empty' : '')}>
            {entry.favIconUrl && <img className="history-favicon" src={entry.favIconUrl} alt="" />}
          </span>
          <span className="history-entry-copy">
            <span className="history-entry-title" ref={titleRef}>
              {entry.title}
            </span>
            {badges.length > 0 && (
              <span className="history-entry-badges">
                {badges.map((badge) => (
                  <span key={badge} className="history-badge">
                    {badge}
                  </span>
                ))}
              </span>
            )}
          </span>
        </button>
        <div className="history-entry-actions">
          <button className="history-entry-close" type="button" disabled={!entry.exists} title="Close this tab" aria-label={`Close ${entry.title}`} onClick={onCloseEntry}>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

export function TabHistoryPanel({ snapshot, onSnapshotChange, onHoverUrlChange, onTabsChange }) {
  const entries = snapshot?.entries || []
  const displayEntries = entries.slice().reverse()

  return (
    <section className="tab-history-panel" aria-label="Activation history">
      <div className="history-entry-list">
        {displayEntries.length > 0 ? (
          displayEntries.map((entry, index) => (
            <HistoryEntry
              key={`${entry.windowId}:${entry.tabId}:${entry.index}`}
              entry={entry}
              indexLabel={historyEntryIndexLabel(entry, snapshot, index + 1)}
              snapshot={snapshot}
              onSnapshotChange={onSnapshotChange}
              onHoverUrlChange={onHoverUrlChange}
              onTabsChange={onTabsChange}
            />
          ))
        ) : (
          <div className="history-empty">No activation history yet.</div>
        )}
      </div>
    </section>
  )
}
