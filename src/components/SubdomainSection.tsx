import { closeTabsExact } from '../extension/tabs.js'
import { requestDashboardRefresh } from '../extension/dashboard-controller.js'
import { markClosure } from '../extension/undo.js'
import { FlatSection } from './FlatSection'
import { PathgroupSection } from './PathgroupSection'
import { Button } from './ui/Button'
import type { DashboardChipData, DashboardClusterVM, HoverUrlChangeHandler, LayoutChangeHandler } from './types'

interface SubdomainCloseButtonProps {
  count: number
  onClick: () => void | Promise<void>
}

interface SubdomainSectionProps {
  subdomainKey: string
  isPort?: boolean
  sectionCount: number
  sectionClosableUrls: string[]
  showHeader: boolean
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  clusters: DashboardClusterVM[]
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
}

function SubdomainCloseButton({ count, onClick }: SubdomainCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <Button className="subdomain-close-btn" title={title} onClick={onClick}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </Button>
  )
}

export function SubdomainSection({
  subdomainKey,
  isPort,
  sectionCount,
  sectionClosableUrls,
  showHeader,
  hasFlat,
  flatVisibleChips,
  flatHiddenChips,
  flatHiddenCount,
  clusters,
  onHoverUrlChange = null,
  onLayoutChange = null
}: SubdomainSectionProps) {
  const hasClose = showHeader && sectionClosableUrls && sectionClosableUrls.length > 0
  const headerLabel = subdomainKey

  async function onCloseSubdomain() {
    if (!sectionClosableUrls || sectionClosableUrls.length === 0) return
    const snapshot = await closeTabsExact(sectionClosableUrls, { preserveGroups: true })
    if (snapshot.length > 0) {
      markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''}`)
    }
    await requestDashboardRefresh({ animateCards: true })
  }

  return (
    <div className="subdomain-section" data-kind={isPort ? 'port' : undefined}>
      {showHeader && (
        <div className="subdomain-header">
          <span className="subdomain-header-name">{headerLabel}</span>
          <span className="subdomain-header-count">{sectionCount}</span>
          {hasClose && <SubdomainCloseButton count={sectionClosableUrls.length} onClick={onCloseSubdomain} />}
        </div>
      )}
      {hasFlat && (
        <FlatSection
          visibleChips={flatVisibleChips}
          hiddenChips={flatHiddenChips}
          hiddenCount={flatHiddenCount}
          onHoverUrlChange={onHoverUrlChange}
          onLayoutChange={onLayoutChange}
        />
      )}
      {clusters.map((cluster) => (
        <PathgroupSection
          key={cluster.key}
          label={cluster.label}
          isPR={cluster.isPR}
          count={cluster.count}
          closableUrls={cluster.closableUrls}
          visibleChips={cluster.visibleChips}
          hiddenChips={cluster.hiddenChips}
          hiddenCount={cluster.hiddenCount}
          onHoverUrlChange={onHoverUrlChange}
          onLayoutChange={onLayoutChange}
        />
      ))}
    </div>
  )
}
