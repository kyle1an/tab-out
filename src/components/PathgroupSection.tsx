import { useState } from 'react'
import { closeTabsExact } from '../extension/tabs.js'
import { requestDashboardRefresh } from '../extension/dashboard-controller.js'
import { markClosure } from '../extension/undo.js'
import { PageChip } from './PageChip'
import { Button } from './ui/Button'
import type { DashboardChipData, HoverUrlChangeHandler, LayoutChangeHandler } from './types'

interface PathgroupCloseButtonProps {
  count: number
  onClick: () => void | Promise<void>
}

interface PathgroupSectionProps {
  label: string
  isPR: boolean
  count: number
  closableUrls: string[]
  visibleChips: DashboardChipData[]
  hiddenChips: DashboardChipData[]
  hiddenCount: number
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
}

function PathgroupCloseButton({ count, onClick }: PathgroupCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <Button className="pathgroup-close-btn" title={title} onClick={onClick}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </Button>
  )
}

export function PathgroupSection({ label, isPR, count, closableUrls, visibleChips, hiddenChips, hiddenCount, onHoverUrlChange = null, onLayoutChange = null }: PathgroupSectionProps) {
  const [expanded, setExpanded] = useState(false)

  function onExpand() {
    setExpanded(true)
    if (onLayoutChange) onLayoutChange()
  }

  async function onCloseCluster() {
    if (!closableUrls || closableUrls.length === 0) return
    const snapshot = await closeTabsExact(closableUrls, { preserveGroups: true })
    if (snapshot.length > 0) {
      markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''}`)
    }
    await requestDashboardRefresh({ animateCards: true })
  }

  return (
    <div className="pathgroup-section" data-expanded={expanded ? 'true' : undefined}>
      <div className="pathgroup-header">
        <span className="chip-pathgroup" title={label}>
          {label}
        </span>
        {isPR && <span className="chip-pathgroup chip-pathgroup-pr">PRs</span>}
        <span className="pathgroup-header-count">{count}</span>
        {closableUrls && closableUrls.length > 0 && <PathgroupCloseButton count={closableUrls.length} onClick={onCloseCluster} />}
      </div>
      {visibleChips.map((chip) => (
        <PageChip key={chip.rawUrl} chip={chip} onHoverUrlChange={onHoverUrlChange} />
      ))}
      {hiddenCount > 0 && (
        <div className="page-chips-overflow">
          {hiddenChips.map((chip) => (
            <PageChip key={chip.rawUrl} chip={chip} onHoverUrlChange={onHoverUrlChange} />
          ))}
        </div>
      )}
      {!expanded && hiddenCount > 0 && (
        <Button className="page-chip page-chip-overflow clickable" onClick={onExpand}>
          <span className="chip-text">+{hiddenCount} more</span>
        </Button>
      )}
    </div>
  )
}
