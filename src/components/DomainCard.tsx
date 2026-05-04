import { closeTabsExact, closeDuplicateTabs } from '../extension/tabs.js'
import { markClosure } from '../extension/undo.js'
import { requestDashboardRefresh } from '../extension/dashboard-controller.js'
import { tabMatchesFilter } from '../extension/render.js'
import { isPinnableDomain } from '../extension/domain-pins.js'
import { SubdomainSection } from './SubdomainSection'
import { Button } from './ui/Button'
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
    <Button className="card-close-btn" onClick={onClick}>
      <span className="card-close-btn-text">{label}</span>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
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
      <span className="open-tabs-badge tab-count-badge tab-count-badge-filtered" title={title}>
        <span className="tab-count-badge-current">{labelText.slice(0, slashIndex)}</span>
        <span className="tab-count-badge-total">{labelText.slice(slashIndex)}</span>
      </span>
    )
  }

  return (
    <span className="open-tabs-badge tab-count-badge" title={title}>
      {labelText}
    </span>
  )
}

function DedupButton({ count, onClick }: { count: number; onClick: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void> }) {
  const label = `Dedupe ${count}`
  const title = `Close ${count} duplicate${count !== 1 ? 's' : ''}`
  return (
    <Button className="action-btn" title={title} onClick={onClick}>
      {label}
    </Button>
  )
}

function PinButton({ displayName, pinned, onClick }: { displayName?: string; pinned: boolean; onClick: (e: MouseEvent<HTMLButtonElement>) => void | Promise<void> }) {
  const action = pinned ? 'Unpin' : 'Pin'
  const title = `${action} ${displayName}`
  return (
    <Button
      className={'domain-pin-btn' + (pinned ? ' is-pinned' : '')}
      title={title}
      aria-label={title}
      aria-pressed={pinned ? 'true' : 'false'}
      onClick={onClick}
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
    </Button>
  )
}

function FixedIndicator({ displayName }: { displayName?: string }) {
  return (
    <span className="domain-fixed-indicator" role="img" aria-label={`${displayName} is fixed at the top`} title={`${displayName} is fixed at the top`}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
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
      preservePinned: group.domain === '__tab-out__'
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

  const classList = `domain-block${vm.displayMode === 'unmatched' ? ' card-unmatched' : ''}${isAppsCard ? ' domain-block-apps' : ''}${isFixedCard ? ' domain-block-fixed' : ''}${group.pinned ? ' domain-block-pinned' : ''}`

  return (
    <div className={classList} data-domain-id={vm.stableId}>
      <header className="domain-header">
        <span className="mission-name">{displayName}</span>
        {isFixedCard && <FixedIndicator displayName={displayName} />}
        {canPin && <PinButton displayName={displayName} pinned={!!group.pinned} onClick={onTogglePin} />}
        {vm.singleSubdomainKey && <span className={'mission-subdomain' + (vm.singleSubdomainIsPort ? ' is-port' : '')}>{vm.singleSubdomainKey}</span>}
        <TabBadge label={vm.tabCountLabel} title={vm.tabCountTitle} />
        {closableExtras > 0 && <DedupButton count={closableExtras} onClick={onDedup} />}
        {!hideCardClose && closableCount > 0 && <CardCloseButton label={vm.closableCountLabel} onClick={onCloseDomain} />}
      </header>
      <div className="mission-card">
        <div className="mission-pages">
          {sections.map((section) => (
            <SubdomainSection
              key={section.key || '__root__'}
              subdomainKey={section.key}
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
