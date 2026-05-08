import { closeTabsExact, closeDuplicateTabs } from '../extension/tabs.js'
import { markClosure } from '../extension/undo.js'
import { requestDashboardRefresh } from '../extension/dashboard-controller.js'
import { tabMatchesFilter } from '../extension/render.js'
import { isPinnableDomain } from '../extension/domain-pins.js'
import { SubdomainSection } from './SubdomainSection'
import { Button } from './ui/Button'
import { cn } from '../lib/cn'
import type { MouseEvent } from 'react'
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
    <Button
      className="card-close-btn group/card-close pointer-events-none absolute top-0 right-0 z-2 box-border flex h-[22px] min-w-[22px] cursor-pointer items-center justify-end gap-0 whitespace-nowrap rounded-lg border border-transparent bg-transparent px-2.5 py-0 text-[12px] font-medium text-tab-muted opacity-0 transition-[opacity,background,border-color,color] duration-200 ease-out [corner-shape:squircle] group-hover/domain-block:pointer-events-auto group-hover/domain-block:opacity-100 hover:border-[var(--status-abandoned)] hover:bg-tab-card hover:text-[var(--status-abandoned)]"
      onClick={onClick}
    >
      <span className="card-close-btn-text inline-block max-w-0 overflow-hidden text-right tabular-nums opacity-0 transition-[max-width,opacity] duration-200 ease-out group-hover/card-close:max-w-[200px] group-hover/card-close:opacity-100">
        {label}
      </span>
      <svg className="absolute top-1/2 right-[5px] h-[13px] w-[13px] -translate-y-1/2 opacity-100 transition-opacity duration-200 ease-out group-hover/card-close:opacity-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </Button>
  )
}

function TabBadge({ label, title }: { label?: string | number; title?: string }) {
  const labelText = String(label ?? '')
  const slashIndex = labelText.indexOf('/')
  if (slashIndex > 0) {
    return (
      <span
        className="open-tabs-badge tab-count-badge tab-count-badge-filtered inline-flex items-center gap-0 rounded-[6px] bg-[rgba(82,82,82,0.08)] px-2 py-0.5 text-[12px] font-medium text-[var(--accent-amber)] [corner-shape:squircle]"
        title={title}
      >
        <span className="tab-count-badge-current font-bold text-[var(--accent-amber)]">{labelText.slice(0, slashIndex)}</span>
        <span className="tab-count-badge-total font-medium text-tab-muted opacity-80">{labelText.slice(slashIndex)}</span>
      </span>
    )
  }

  return (
    <span
      className="open-tabs-badge tab-count-badge inline-flex items-center gap-1 rounded-[6px] bg-[rgba(82,82,82,0.08)] px-2 py-0.5 text-[12px] font-medium text-[var(--accent-amber)] [corner-shape:squircle]"
      title={title}
    >
      {labelText}
    </span>
  )
}

function DedupButton({ count, onClick }: { count: number; onClick: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void> }) {
  const label = `Dedupe ${count}`
  const title = `Close ${count} duplicate${count !== 1 ? 's' : ''}`
  return (
    <Button
      className="action-btn inline-flex h-[22px] box-border cursor-pointer items-center gap-[5px] rounded-[10px] border border-[var(--warm-gray)] bg-tab-card px-3 py-0 font-sans text-[12px] font-medium tabular-nums text-tab-muted transition-all duration-200 [corner-shape:squircle] hover:border-tab-ink hover:text-tab-ink"
      title={title}
      onClick={onClick}
    >
      {label}
    </Button>
  )
}

function PinButton({ displayName, pinned, onClick }: { displayName?: string; pinned: boolean; onClick: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void> }) {
  const action = pinned ? 'Unpin' : 'Pin'
  const title = `${action} ${displayName}`
  return (
    <Button
      className={cn(
        'domain-pin-btn inline-flex h-[22px] w-[22px] min-w-[22px] cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent p-0 text-tab-muted opacity-[0.35] transition-[opacity,color,background,border-color] duration-200 ease-out [corner-shape:squircle] group-hover/domain-block:opacity-100 hover:border-[var(--warm-gray)] hover:bg-[rgba(82,82,82,0.06)] hover:text-tab-ink focus-visible:opacity-100',
        pinned && 'is-pinned border-[var(--warm-gray)] bg-[rgba(82,82,82,0.08)] text-tab-ink opacity-100'
      )}
      title={title}
      aria-label={title}
      aria-pressed={pinned ? 'true' : 'false'}
      onClick={onClick}
    >
      <svg className="h-[13px] w-[13px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
    </Button>
  )
}

function FixedIndicator({ displayName }: { displayName?: string }) {
  return (
    <span
      className="domain-fixed-indicator inline-flex h-[22px] w-[22px] min-w-[22px] items-center justify-center rounded-lg border border-[var(--warm-gray)] bg-[rgba(82,82,82,0.06)] p-0 text-tab-muted opacity-[0.78] [corner-shape:squircle]"
      role="img"
      aria-label={`${displayName} is fixed at the top`}
      title={`${displayName} is fixed at the top`}
    >
      <svg className="h-[13px] w-[13px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
    </span>
  )
}

export function DomainCard({ group, vm, filter = '', onHoverUrlChange = null, onLayoutChange = null, onTogglePinnedDomain = null }: DomainCardProps) {
  if (vm.isHidden) return null
  const hideCardClose = group.domain === '__standalone-apps__'
  const isAppsCard = group.domain === '__standalone-apps__'
  const isFixedCard = group.domain === '__tab-out__' || group.domain === '__standalone-apps__'
  const canPin = isPinnableDomain(group.domain) && typeof onTogglePinnedDomain === 'function'
  const displayName = vm.displayName || group.label || group.domain
  const closableExtras = vm.closableExtras ?? 0
  const closableCount = vm.closableCount ?? 0
  const sections = vm.sections ?? []

  async function onCloseDomain(e: MouseEvent<HTMLButtonElement>) {
    const block = e.currentTarget.closest('.domain-block')

    const scopedTabs = filter ? group.tabs.filter((tab) => tabMatchesFilter(tab, filter)) : group.tabs
    const urls = scopedTabs.map((tab) => tab.url)
    const snapshot = await closeTabsExact(urls, { preserveGroups: true })

    if (block && !filter) {
      block.classList.add('closing')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''} from ${displayName}`)
    await requestDashboardRefresh({ animateCards: true })
  }

  async function onDedup(e: MouseEvent<HTMLButtonElement>) {
    const btn = e.currentTarget
    const urls = vm.closableDupeUrls || []
    if (urls.length === 0) return

    const dupeSnapshot = await closeDuplicateTabs(urls, true, {
      preservePinnedTabOut: group.domain === '__tab-out__'
    })

    btn.classList.add('closing')
    const block = btn.closest('.domain-block')
    if (block) {
      block.querySelectorAll('.chip-dupe-badge').forEach((badge) => badge.classList.add('closing'))
    }
    await new Promise((resolve) => setTimeout(resolve, 200))

    markClosure(dupeSnapshot, `Closed ${dupeSnapshot.length} duplicate${dupeSnapshot.length !== 1 ? 's' : ''}`)
    await requestDashboardRefresh({ animateCards: true })
  }

  async function onTogglePin(e: MouseEvent<HTMLButtonElement>) {
    e.preventDefault()
    await onTogglePinnedDomain?.(group.domain)
  }

  return (
    <div
      className={cn(
        'domain-block group/domain-block relative flex flex-col gap-1',
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
              'mission-subdomain inline-flex items-center rounded-[6px] bg-[rgba(82,82,82,0.04)] px-2 py-0.5 text-[12px] font-medium text-tab-muted [corner-shape:squircle]',
              vm.singleSubdomainIsPort && 'is-port'
            )}
          >
            {vm.singleSubdomainKey}
          </span>
        )}
        <TabBadge label={vm.tabCountLabel} title={vm.tabCountTitle} />
        {closableExtras > 0 && <DedupButton count={closableExtras} onClick={onDedup} />}
        {!hideCardClose && closableCount > 0 && <CardCloseButton label={vm.closableCountLabel} onClick={onCloseDomain} />}
      </header>
      <div className="mission-card">
        <div className="mission-pages flex flex-col gap-0">
          {sections.map((section, index) => (
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
              clusters={section.clusters}
              onHoverUrlChange={onHoverUrlChange}
              onLayoutChange={onLayoutChange}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
