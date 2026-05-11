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

interface SubdomainCloseButtonProps {
  count: number
  onClick: () => void | Promise<void>
}

interface SubdomainSectionProps {
  subdomainKey: string
  isFirst?: boolean
  isPort?: boolean
  sectionCount: number
  sectionClosableUrls: string[]
  showHeader: boolean
  hasFlat: boolean
  flatVisibleChips: DashboardChipData[]
  flatHiddenChips: DashboardChipData[]
  flatHiddenCount: number
  suppressedTitleParts?: DashboardTitleSuppression[]
  clusters: Array<DashboardClusterVM & {
    titleSuppressionToneScope?: TitleSuppressionToneScope
    suppressedTitleToneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
  }>
  filter?: string
  useSuppressionTokenTones?: boolean
  suppressedTitleToneIndexByText?: ReadonlyMap<string, number>
  suppressedTitleToneByText?: ReadonlyMap<string, TitleSuppressionTone | ''>
}

function SubdomainCloseButton({ count, onClick }: SubdomainCloseButtonProps) {
  const title = `Close ${count} tab${count !== 1 ? 's' : ''}`
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        className="subdomain-close-btn grid h-[18px] w-[18px] flex-[0_0_18px] cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 leading-[0] text-tab-muted opacity-0 transition-[opacity,background] duration-150 group-hover/subdomain-section:opacity-100 hover:bg-[#ededed]"
        aria-label={title}
        onClick={onClick}
      >
        <svg className="block h-3 w-3 flex-none" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </TooltipAnchor>
  )
}

export function SubdomainSection({
  subdomainKey,
  isFirst = false,
  isPort,
  sectionCount,
  sectionClosableUrls,
  showHeader,
  hasFlat,
  flatVisibleChips,
  flatHiddenChips,
  flatHiddenCount,
  suppressedTitleParts = [],
  clusters,
  filter = '',
  useSuppressionTokenTones = false,
  suppressedTitleToneIndexByText = new Map<string, number>(),
  suppressedTitleToneByText
}: SubdomainSectionProps) {
  const { activeSuppressedTitle, setActiveSuppressedTitle } = useDomainCardContext()
  const hasClose = showHeader && sectionClosableUrls && sectionClosableUrls.length > 0
  const headerLabel = subdomainKey

  async function onCloseSubdomain() {
    if (!sectionClosableUrls || sectionClosableUrls.length === 0) return
    await closeExactTabSection({ urls: sectionClosableUrls })
  }

  return (
    <div
      className={cn(
        'subdomain-section group/subdomain-section flex flex-col',
        !isFirst && 'mt-1.5 border-t border-[rgba(115,115,115,0.12)]'
      )}
      data-kind={isPort ? 'port' : undefined}
    >
      {showHeader && (
        <div
          className={cn(
            'subdomain-header flex items-center gap-1.5 pb-0.5 text-xs font-semibold tracking-[0.2px] text-tab-muted',
            isFirst ? 'pt-0.5' : 'pt-1.5'
          )}
        >
          <span
            className={cn(
              'subdomain-header-name',
              isPort
                ? "before:font-normal before:opacity-45 before:content-[':']"
                : "after:ml-px after:font-normal after:opacity-45 after:content-['.']"
            )}
          >
            {headerLabel}
          </span>
          <span className="subdomain-header-count font-medium tabular-nums opacity-[0.55]">{sectionCount}</span>
          {hasClose && <SubdomainCloseButton count={sectionClosableUrls.length} onClick={onCloseSubdomain} />}
        </div>
      )}
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
          afterSeparator={!isFirst && !showHeader}
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
            isFirstContent={isFirst && !showHeader && !hasFlat && index === 0}
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
