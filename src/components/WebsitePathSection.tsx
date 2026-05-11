import { closeExactTabSection } from '../extension/tab-actions'
import { useDomainCardContext } from './DomainCardContext'
import { FlatSection } from './FlatSection'
import { PathgroupSection } from './PathgroupSection'
import { TitleSuppressionSummary } from './TitleSuppressionSummary'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import { createTitleSuppressionToneScope, mergeTitleSuppressionToneMaps } from './title-suppression'
import type { TitleSuppressionTone, TitleSuppressionToneScope } from './title-suppression'
import type { DashboardChipData, DashboardClusterVM, DashboardTitleSuppression } from './types'

interface WebsitePathSectionCloseButtonProps {
  count: number
  isFirstContent?: boolean
  onClick: () => void | Promise<void>
}

interface WebsitePathSectionProps {
  label: string
  sectionCount: number
  sectionClosableUrls: string[]
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  suppressedTitleParts?: DashboardTitleSuppression[]
  clusters: Array<DashboardClusterVM & {
    titleSuppressionToneScope?: TitleSuppressionToneScope
    suppressedTitleToneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
  }>
  className?: string
  isFirstContent?: boolean
  filter?: string
  useSuppressionTokenTones?: boolean
  suppressedTitleToneIndexByText?: ReadonlyMap<string, number>
  suppressedTitleToneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
}

function WebsitePathSectionCloseButton({ count, isFirstContent = false, onClick }: WebsitePathSectionCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        className={cn(
          'website-path-section-close-btn absolute top-1/2 right-0 grid h-5 w-5 -translate-y-1/2 cursor-pointer place-items-center rounded-full border-0 bg-tab-card p-0 text-tab-muted opacity-0 transition-[opacity,background] duration-150 group-hover/website-path-section:opacity-100 hover:bg-[#ededed]',
          isFirstContent && 'top-[calc(50%_-_1px)]'
        )}
        aria-label={title}
        onClick={onClick}
      >
        <svg className="block h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </TooltipAnchor>
  )
}

export function WebsitePathSection({
  label,
  sectionCount,
  sectionClosableUrls,
  hasFlat,
  flatVisibleChips,
  flatHiddenChips,
  flatHiddenCount,
  suppressedTitleParts = [],
  clusters,
  className,
  isFirstContent = false,
  filter = '',
  useSuppressionTokenTones = false,
  suppressedTitleToneIndexByText = new Map<string, number>(),
  suppressedTitleToneByText
}: WebsitePathSectionProps) {
  const { activeSuppressedTitle, setActiveSuppressedTitle } = useDomainCardContext()
  const hasClose = sectionClosableUrls && sectionClosableUrls.length > 0

  async function onCloseWebsitePathSection() {
    if (!sectionClosableUrls || sectionClosableUrls.length === 0) return
    await closeExactTabSection({ urls: sectionClosableUrls })
  }

  return (
    <div className={cn('website-path-section group/website-path-section flex flex-col', className)}>
      <div
        className={cn(
          'website-path-section-header relative flex items-center gap-1.5 pr-6 pb-0.5 pl-0',
          isFirstContent ? 'pt-0' : 'pt-[3px]'
        )}
      >
        <span className="website-path-section-label inline-block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-semibold tracking-wide text-tab-muted align-baseline">
          {label}
        </span>
        <span className="website-path-section-header-count text-xs tabular-nums text-tab-muted opacity-70">{sectionCount}</span>
        {hasClose && <WebsitePathSectionCloseButton count={sectionClosableUrls.length} isFirstContent={isFirstContent} onClick={onCloseWebsitePathSection} />}
      </div>
      <TitleSuppressionSummary
        suppressedTitleParts={suppressedTitleParts}
        activeSuppressedTitle={activeSuppressedTitle}
        setActiveSuppressedTitle={setActiveSuppressedTitle}
        useSuppressionTokenTones={useSuppressionTokenTones}
        suppressedTitleToneIndexByText={suppressedTitleToneIndexByText}
        className="pb-1"
      />
      {hasFlat && (
        <FlatSection
          visibleChips={flatVisibleChips}
          hiddenChips={flatHiddenChips}
          hiddenCount={flatHiddenCount}
          filter={filter}
          suppressedTitleToneByText={suppressedTitleToneByText}
        />
      )}
      {clusters.map((cluster, index) => {
        const clusterSuppressedTitleParts = cluster.suppressedTitleParts ?? []
        const clusterSuppressionToneScope = cluster.titleSuppressionToneScope ?? createTitleSuppressionToneScope(clusterSuppressedTitleParts)
        const clusterSuppressedTitleToneByText = cluster.suppressedTitleToneByText ?? mergeTitleSuppressionToneMaps(
          suppressedTitleToneByText,
          clusterSuppressionToneScope.suppressedTitleToneByText
        )
        return (
          <PathgroupSection
            key={cluster.key}
            label={cluster.label}
            isPR={cluster.isPR}
            count={cluster.count}
            closableUrls={cluster.closableUrls}
            visibleChips={cluster.visibleChips}
            hiddenChips={cluster.hiddenChips}
            hiddenCount={cluster.hiddenCount}
            className={hasFlat || index > 0 ? 'mt-0.5' : undefined}
            isFirstContent={isFirstContent && !hasFlat && index === 0}
            filter={filter}
            suppressedTitleParts={clusterSuppressedTitleParts}
            useSuppressionTokenTones={clusterSuppressionToneScope.useSuppressionTokenTones}
            suppressedTitleToneIndexByText={clusterSuppressionToneScope.suppressedTitleToneIndexByText}
            suppressedTitleToneByText={clusterSuppressedTitleToneByText}
          />
        )
      })}
    </div>
  )
}
