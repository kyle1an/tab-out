import { isPinnableDomain } from '../extension/domain-pins.js'
import { closeDomainTabs, dedupeTabs } from '../extension/tab-actions'
import { DomainCardProvider } from './DomainCardContext'
import { SubdomainSection } from './SubdomainSection'
import { TitleSuppressionSummary } from './TitleSuppressionSummary'
import { TooltipAnchor } from './ui/tooltip'
import { cn } from '@/lib/utils'
import { useMemo, useState } from 'react'
import type { MouseEvent } from 'react'
import { createTitleSuppressionToneScope, mergeTitleSuppressionToneMaps } from './title-suppression'
import type { DashboardCardVM, DomainGroup, HoverUrlChangeHandler, LayoutChangeHandler, TogglePinnedDomainHandler } from './types'

interface DomainCardProps {
  group: DomainGroup
  vm: DashboardCardVM
  filter?: string
  onHoverUrlChange?: HoverUrlChangeHandler | null
  onLayoutChange?: LayoutChangeHandler | null
  onTogglePinnedDomain?: TogglePinnedDomainHandler | null
}

function CardCloseButton({ label, onClick }: { label?: string; onClick: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void> }) {
  return (
    <button
      type="button"
      className="card-close-btn group/card-close pointer-events-none absolute top-0 right-0 z-2 box-border flex h-[22px] min-w-[22px] cursor-pointer items-center justify-end gap-0 whitespace-nowrap rounded-lg border border-transparent bg-transparent px-2.5 py-0 text-[12px] font-medium text-tab-muted opacity-0 transition-[opacity,background,border-color,color] duration-200 ease-out [corner-shape:squircle] group-hover/domain-block:pointer-events-auto group-hover/domain-block:opacity-100 hover:border-[var(--status-abandoned)] hover:bg-tab-card hover:text-[var(--status-abandoned)]"
      onClick={onClick}
    >
      <span className="card-close-btn-text inline-block max-w-0 overflow-hidden text-right tabular-nums opacity-0 transition-[max-width,opacity] duration-200 ease-out group-hover/card-close:max-w-[200px] group-hover/card-close:opacity-100">
        {label}
      </span>
      <svg className="absolute top-1/2 right-[5px] h-[13px] w-[13px] -translate-y-1/2 opacity-100 transition-opacity duration-200 ease-out group-hover/card-close:opacity-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  )
}

function TabBadge({ label }: { label?: string | number }) {
  const labelText = String(label ?? '')
  const slashIndex = labelText.indexOf('/')
  if (slashIndex > 0) {
    return (
      <span className="open-tabs-badge tab-count-badge tab-count-badge-filtered inline-flex h-[22px] box-border items-center gap-0 rounded-[6px] bg-[rgba(82,82,82,0.08)] px-2 py-0 text-[12px] font-medium tabular-nums text-[var(--accent-amber)] [corner-shape:squircle]">
        <span className="tab-count-badge-current font-bold text-[var(--accent-amber)]">{labelText.slice(0, slashIndex)}</span>
        <span className="tab-count-badge-total font-medium text-tab-muted opacity-80">{labelText.slice(slashIndex)}</span>
      </span>
    )
  }

  return (
    <span className="open-tabs-badge tab-count-badge inline-flex h-[22px] box-border items-center gap-1 rounded-[6px] bg-[rgba(82,82,82,0.08)] px-2 py-0 text-[12px] font-medium tabular-nums text-[var(--accent-amber)] [corner-shape:squircle]">
      {labelText}
    </span>
  )
}

function DedupButton({ count, closing = false, onClick }: { count: number; closing?: boolean; onClick: () => void | Promise<void> }) {
  const label = `Dedupe ${count}`
  return (
    <button
      type="button"
      className={cn(
        'action-btn inline-flex h-[22px] box-border cursor-pointer items-center gap-[5px] rounded-[10px] border border-[var(--warm-gray)] bg-tab-card px-3 py-0 font-sans text-[12px] font-medium tabular-nums text-tab-muted transition-all duration-200 [corner-shape:squircle] hover:border-tab-ink hover:text-tab-ink [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-opacity [&.closing]:duration-200 [&.closing]:ease-[ease]',
        closing && 'closing'
      )}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function PinButton({ displayName, pinned, onClick }: { displayName?: string; pinned: boolean; onClick: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void> }) {
  const action = pinned ? 'Unpin' : 'Pin'
  const title = `${action} ${displayName}`
  return (
    <TooltipAnchor content={title}>
      <button
        type="button"
        className={cn(
          'domain-pin-btn inline-flex h-[22px] w-[22px] min-w-[22px] cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent p-0 text-tab-muted opacity-[0.35] transition-[opacity,color,background,border-color] duration-200 ease-out [corner-shape:squircle] group-hover/domain-block:opacity-100 hover:border-[var(--warm-gray)] hover:bg-[rgba(82,82,82,0.06)] hover:text-tab-ink focus-visible:opacity-100',
          pinned && 'is-pinned border-[var(--warm-gray)] bg-[rgba(82,82,82,0.08)] text-tab-ink opacity-100'
        )}
        aria-label={title}
        aria-pressed={pinned ? 'true' : 'false'}
        onClick={onClick}
      >
        <svg className="h-[13px] w-[13px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
        </svg>
      </button>
    </TooltipAnchor>
  )
}

function FixedIndicator({ displayName }: { displayName?: string }) {
  const title = `${displayName} is fixed at the top`
  return (
    <TooltipAnchor content={title}>
      <span
        className="domain-fixed-indicator inline-flex h-[22px] w-[22px] min-w-[22px] items-center justify-center rounded-lg border border-[var(--warm-gray)] bg-[rgba(82,82,82,0.06)] p-0 text-tab-muted opacity-[0.78] [corner-shape:squircle]"
        role="img"
        aria-label={title}
      >
        <svg className="h-[13px] w-[13px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
        </svg>
      </span>
    </TooltipAnchor>
  )
}

export function DomainCard({ group, vm, filter = '', onHoverUrlChange = null, onLayoutChange = null, onTogglePinnedDomain = null }: DomainCardProps) {
  const [activeSuppressedTitle, setActiveSuppressedTitle] = useState('')
  const [dedupeBadgesClosing, setDedupeBadgesClosing] = useState(false)
  const cardContext = useMemo(() => ({
    activeSuppressedTitle,
    setActiveSuppressedTitle,
    dedupeBadgesClosing,
    onHoverUrlChange,
    onLayoutChange
  }), [activeSuppressedTitle, dedupeBadgesClosing, onHoverUrlChange, onLayoutChange])
  if (vm.isHidden) return null
  const hideCardClose = group.domain === '__standalone-apps__'
  const isAppsCard = group.domain === '__standalone-apps__'
  const isFixedCard = group.domain === '__tab-out__' || group.domain === '__standalone-apps__'
  const canPin = isPinnableDomain(group.domain) && typeof onTogglePinnedDomain === 'function'
  const displayName = vm.displayName || group.label || group.domain
  const closableExtras = vm.closableExtras ?? 0
  const closableCount = vm.closableCount ?? 0
  const sections = vm.sections ?? []
  const highlightFilter = vm.displayMode !== 'unmatched' ? filter : ''
  const suppressedTitleParts = vm.suppressedTitleParts ?? []
  const cardSuppressionToneScope = createTitleSuppressionToneScope(suppressedTitleParts)

  async function onCloseDomain(e: MouseEvent<HTMLButtonElement>) {
    const block = e.currentTarget.closest('.domain-block')

    await closeDomainTabs({
      group,
      filter,
      displayName,
      onAfterClose: async () => {
        if (block && !filter) {
          block.classList.add('closing')
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
    })
  }

  async function onDedup() {
    const urls = vm.closableDupeUrls || []

    await dedupeTabs({
      urls,
      preservePinnedTabOut: group.domain === '__tab-out__',
      onAfterClose: async () => {
        setDedupeBadgesClosing(true)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    })
  }

  async function onTogglePin(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    await onTogglePinnedDomain?.(group.domain)
  }

  return (
    <DomainCardProvider value={cardContext}>
      <div
        className={cn(
          'domain-block group/domain-block relative flex flex-col gap-1 [.missions.is-packed_&.layout-moving]:z-3 [.missions.is-packed_&.layout-moving]:transition-none [.missions.is-packed_&.layout-moving]:[will-change:transform] [.missions.is-packed_&.layout-moving.layout-moving-active]:[transition:transform_0.28s_cubic-bezier(0.2,0,0,1)] motion-reduce:[.missions.is-packed_&.layout-moving]:transform-none motion-reduce:[.missions.is-packed_&.layout-moving]:transition-none motion-reduce:[.missions.is-packed_&.layout-moving.layout-moving-active]:transform-none motion-reduce:[.missions.is-packed_&.layout-moving.layout-moving-active]:transition-none [&.closing]:pointer-events-none [&.closing]:opacity-0 [&.closing]:transition-[opacity,transform] [&.closing]:duration-[250ms] [&.closing]:ease-[ease] [&.closing]:[transform:scale(0.9)]',
          vm.displayMode === 'unmatched' && 'card-unmatched opacity-[0.45] transition-opacity duration-200 ease-[ease] hover:opacity-100',
          isAppsCard && 'domain-block-apps',
          isFixedCard && 'domain-block-fixed',
          group.pinned && 'domain-block-pinned'
        )}
        data-domain-id={vm.stableId}
      >
        <header className="domain-header flex min-w-0 flex-row flex-wrap items-center justify-start gap-x-2.5 gap-y-1 p-0">
          <span className="mission-name min-w-0 flex-[0_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[15px] leading-[22px] font-semibold tracking-[0.1px] text-tab-ink">
            {displayName}
          </span>
          {isFixedCard && <FixedIndicator displayName={displayName} />}
          {canPin && <PinButton displayName={displayName} pinned={!!group.pinned} onClick={onTogglePin} />}
          {vm.singleSubdomainKey && (
            <span
              className={cn(
                'mission-subdomain inline-flex h-[22px] box-border items-center rounded-[6px] bg-[rgba(82,82,82,0.04)] px-2 py-0 text-[12px] font-medium text-tab-muted [corner-shape:squircle]',
                vm.singleSubdomainIsPort
                  ? "before:font-normal before:opacity-45 before:content-[':']"
                  : "after:ml-px after:font-normal after:opacity-45 after:content-['.']"
              )}
            >
              {vm.singleSubdomainKey}
            </span>
          )}
          <TabBadge label={vm.tabCountLabel} />
          {closableExtras > 0 && <DedupButton count={closableExtras} closing={dedupeBadgesClosing} onClick={onDedup} />}
          {!hideCardClose && closableCount > 0 && <CardCloseButton label={vm.closableCountLabel} onClick={onCloseDomain} />}
        </header>
        <div
          className={cn(
            'mission-card relative flex flex-col gap-2 overflow-hidden rounded-[22px] border border-[var(--warm-gray)] bg-tab-card transition-[box-shadow,transform] duration-[250ms] ease-[ease] [corner-shape:squircle]',
            isAppsCard ? 'p-[7px]' : 'p-2 group-hover/domain-block:shadow-[0_2px_6px_var(--shadow)]',
            (isFixedCard || group.pinned) && 'border-[rgba(82,82,82,0.32)]'
          )}
        >
          <TitleSuppressionSummary
            suppressedTitleParts={suppressedTitleParts}
            activeSuppressedTitle={activeSuppressedTitle}
            setActiveSuppressedTitle={setActiveSuppressedTitle}
            useSuppressionTokenTones={cardSuppressionToneScope.useSuppressionTokenTones}
            suppressedTitleToneIndexByText={cardSuppressionToneScope.suppressedTitleToneIndexByText}
          />
          <div className="mission-pages flex flex-col gap-0">
            {sections.map((section, index) => {
              const sectionSuppressedTitleParts = section.suppressedTitleParts ?? []
              const sectionSuppressionToneScope = createTitleSuppressionToneScope(sectionSuppressedTitleParts)
              const sectionSuppressedTitleToneByText = mergeTitleSuppressionToneMaps(
                cardSuppressionToneScope.suppressedTitleToneByText,
                sectionSuppressionToneScope.suppressedTitleToneByText
              )
              return (
                <SubdomainSection
                  key={section.key || '__root__'}
                  subdomainKey={section.key}
                  isFirst={index === 0}
                  isPort={section.isPort}
                  sectionCount={section.sectionCount}
                  sectionClosableUrls={section.sectionClosableUrls}
                  showHeader={section.showHeader}
                  hasFlat={section.hasFlat}
                  flatVisibleChips={section.flatVisibleChips}
                  flatHiddenChips={section.flatHiddenChips}
                  flatHiddenCount={section.flatHiddenCount}
                  suppressedTitleParts={sectionSuppressedTitleParts}
                  clusters={section.clusters}
                  filter={highlightFilter}
                  useSuppressionTokenTones={sectionSuppressionToneScope.useSuppressionTokenTones}
                  suppressedTitleToneIndexByText={sectionSuppressionToneScope.suppressedTitleToneIndexByText}
                  suppressedTitleToneByText={sectionSuppressedTitleToneByText}
                />
              )
            })}
          </div>
        </div>
      </div>
    </DomainCardProvider>
  )
}
