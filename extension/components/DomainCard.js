/* ================================================================
   <DomainCard> — top-level component for a domain group.

   Structure:
     .domain-block            — masonry unit; carries is-app / .closing /
                                .card-unmatched so the header dims with
                                the card
       .domain-header         — title + subdomain pill + tab badge +
                                Dedupe-N + close× (inline, right-aligned)
       .mission-card          — rounded container; just holds chips now
         .mission-pages       — the subdomain/cluster/chip tree
           <SubdomainSection> — one per subdomain in the group

   The title used to live inside the card as .mission-top; moved out so
   it reads as the section header for its chip list rather than "one
   more element in the top row of a card."

   Event handlers for close-domain-tabs and dedup-keep-one live here.
   The buttons keep their data-action attributes as stable selectors
   for styling / inspector familiarity, but no longer feed a global
   document-level click router.
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { closeTabsExact, closeDuplicateTabs } from '../tabs.js'
import { markClosure } from '../undo.js'
import { requestDashboardRefresh } from '../dashboard-controller.js'
import { tabMatchesFilter } from '../render.js'
import { isPinnableDomain } from '../domain-pins.js'
import { SubdomainSection } from './SubdomainSection.js'

const html = htm.bind(h)

function CardCloseButton({ label, onClick }) {
  return html`
    <button class="card-close-btn" data-action="close-domain-tabs" onClick=${onClick}>
      <span class="card-close-btn-text">${label}</span>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
      </svg>
    </button>
  `
}

function TabBadge({ tabCount }) {
  const title = `${tabCount} open tab${tabCount !== 1 ? 's' : ''}`
  return html` <span class="open-tabs-badge tab-count-badge" title=${title}>${tabCount}</span> `
}

function DedupButton({ count, dupeUrlsEncoded, onClick }) {
  // Short label ("Dedupe 2") keeps the inline header row from wrapping
  // when the card also carries a subdomain pill. Full "Close N
  // duplicates" was ~150px wide at typical counts and pushed the
  // button below the tab badge on narrower cards. The title attribute
  // spells out the full action on hover for anyone uncertain what
  // "Dedupe" means here.
  const label = `Dedupe ${count}`
  const title = `Close ${count} duplicate${count !== 1 ? 's' : ''}`
  return html`
    <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls=${dupeUrlsEncoded} title=${title} onClick=${onClick}>${label}</button>
  `
}

function PinButton({ domain, displayName, pinned, onClick }) {
  const action = pinned ? 'Unpin' : 'Pin'
  const title = `${action} ${displayName}`
  return html`
    <button
      type="button"
      class=${'domain-pin-btn' + (pinned ? ' is-pinned' : '')}
      title=${title}
      aria-label=${title}
      aria-pressed=${pinned ? 'true' : 'false'}
      data-domain=${domain}
      onClick=${onClick}
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
    </button>
  `
}

function FixedIndicator({ displayName }) {
  return html`
    <span class="domain-fixed-indicator" role="img" aria-label=${`${displayName} is fixed at the top`} title=${`${displayName} is fixed at the top`}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 17v5M9 10.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16h14v-.8a2 2 0 0 0-1.1-1.7l-1.8-.9a2 2 0 0 1-1.1-1.8V7h1a2 2 0 0 0 2-2V4H6v1a2 2 0 0 0 2 2h1v3.8Z" />
      </svg>
    </span>
  `
}

export function DomainCard({ group, vm, filter = '', onHoverUrlChange = null, onLayoutChange = null, onTogglePinnedDomain = null }) {
  if (vm.isHidden) return null
  const hideCardClose = group.domain === '__standalone-apps__'
  const isAppsCard = group.domain === '__standalone-apps__'
  const isFixedCard = group.domain === '__tab-out__' || group.domain === '__standalone-apps__'
  const canPin = isPinnableDomain(group.domain) && typeof onTogglePinnedDomain === 'function'

  // Close-domain handler: scopes to filter-matching tabs when the
  // filter is active, preserves Chrome tab groups, animates the whole
  // block out with the shared `.closing` CSS class when the full group
  // is closed, then re-renders from scratch. Animating .domain-block
  // instead of .mission-card means the header fades with the card as
  // one visual unit.
  //
  // `block` is captured BEFORE the first await — `e.currentTarget` is
  // only valid during event dispatch, so accessing it after the await
  // would return null.
  async function onCloseDomain(e) {
    const block = e.currentTarget.closest('.domain-block')

    // `filter` prop already carries the normalized query, so we don't
    // have to reach into the DOM for it.
    const scopedTabs = filter ? group.tabs.filter((t) => tabMatchesFilter(t, filter)) : group.tabs
    const urls = scopedTabs.map((t) => t.url)
    const snapshot = await closeTabsExact(urls, { preserveGroups: true })

    if (block && !filter) {
      block.classList.add('closing')
      await new Promise((r) => setTimeout(r, 250))
    }

    markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''} from ${vm.displayName}`)
    await requestDashboardRefresh()
  }

  // Dedup handler: fade the clicked button + every (Nx) badge via the
  // shared `.closing` CSS class, then a dashboard refresh rebuilds
  // the VM — Preact removes the button + badges from the DOM, counts
  // refresh from the fresh VM, masonry re-packs. The previous code
  // imperatively decremented tabsBadge + called updateCloseTabsButton
  // to avoid the 250 ms live-sync lag; explicit re-render subsumes
  // both.
  async function onDedup(e) {
    const btn = e.currentTarget
    const urls = (btn.dataset.dupeUrls || '')
      .split(',')
      .map((u) => decodeURIComponent(u))
      .filter(Boolean)
    if (urls.length === 0) return

    const dupeSnapshot = await closeDuplicateTabs(urls, true, {
      preservePinned: group.domain === '__tab-out__'
    })

    btn.classList.add('closing')
    const block = btn.closest('.domain-block')
    if (block) {
      block.querySelectorAll('.chip-dupe-badge').forEach((b) => b.classList.add('closing'))
    }
    await new Promise((r) => setTimeout(r, 200))

    markClosure(dupeSnapshot, `Closed ${dupeSnapshot.length} duplicate${dupeSnapshot.length !== 1 ? 's' : ''}`)
    await requestDashboardRefresh()
  }

  async function onTogglePin(e) {
    e.preventDefault()
    await onTogglePinnedDomain?.(group.domain)
  }

  const classList = `domain-block${vm.displayMode === 'unmatched' ? ' card-unmatched' : ''}${isAppsCard ? ' domain-block-apps' : ''}${isFixedCard ? ' domain-block-fixed' : ''}${group.pinned ? ' domain-block-pinned' : ''}`

  return html`
    <div class=${classList} data-domain-id=${vm.stableId}>
      <header class="domain-header">
        <span class="mission-name">${vm.displayName}</span>
        ${isFixedCard && html` <${FixedIndicator} displayName=${vm.displayName} /> `}
        ${canPin && html` <${PinButton} domain=${group.domain} displayName=${vm.displayName} pinned=${!!group.pinned} onClick=${onTogglePin} /> `}
        ${vm.singleSubdomainKey && html`
          <span class=${'mission-subdomain' + (vm.singleSubdomainIsPort ? ' is-port' : '')}>${vm.singleSubdomainKey}</span>
        `}
        <${TabBadge} tabCount=${vm.tabCount} />
        ${vm.closableExtras > 0 && html` <${DedupButton} count=${vm.closableExtras} dupeUrlsEncoded=${vm.dupeUrlsEncoded} onClick=${onDedup} /> `}
        ${!hideCardClose && vm.closableCount > 0 && html` <${CardCloseButton} label=${vm.closableCountLabel} onClick=${onCloseDomain} /> `}
      </header>
      <div class="mission-card">
        <div class="mission-pages">
          ${vm.sections.map(
            (s) => html`
              <${SubdomainSection}
                key=${s.key || '__root__'}
                subdomainKey=${s.key}
                isShared=${s.isShared}
                isPort=${s.isPort}
                sectionCount=${s.sectionCount}
                sectionClosableUrls=${s.sectionClosableUrls}
                showHeader=${s.showHeader}
                hasFlat=${s.hasFlat}
                flatVisibleChips=${s.flatVisibleChips}
                flatHiddenChips=${s.flatHiddenChips}
                flatHiddenCount=${s.flatHiddenCount}
                clusters=${s.clusters}
                onHoverUrlChange=${onHoverUrlChange}
                onLayoutChange=${onLayoutChange}
              />
            `
          )}
        </div>
      </div>
    </div>
  `
}
