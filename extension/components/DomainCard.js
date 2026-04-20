/* ================================================================
   <DomainCard> — top-level card component for a domain group.

   Renders the card chrome (close button, mission-top with title /
   subdomain pill / count badge / dedup action) declaratively via
   HTM, and delegates the inner subdomain/cluster/chip tree to
   <SubdomainSection>.

   Event handlers for close-domain-tabs and dedup-keep-one live
   here (moved from the app.js delegation switch in Phase 2).
   data-action attributes are kept on the buttons so external
   lookups still find them:
     • filter.js updates dedup's data-dupe-urls on filter change
     • dedup-global-keep-one in app.js aggregates per-card dedup URLs
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { closeTabsByUrls, closeTabsExact, closeDuplicateTabs } from '../tabs.js'
import { markClosure } from '../undo.js'
import { shootConfetti } from '../confetti.js'
import { computeDomainCardViewModel, renderStaticDashboard } from '../render.js'
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

function TabBadge({ isAppCard, tabCount }) {
  if (isAppCard) {
    const title = `Running as a standalone app${tabCount > 1 ? ` · ${tabCount} tabs` : ''}`
    const text = `App${tabCount > 1 ? ` · ${tabCount}` : ''}`
    return html` <span class="app-badge tab-count-badge" title=${title}>${text}</span> `
  }
  const title = `${tabCount} open tab${tabCount !== 1 ? 's' : ''}`
  // `data-original-count` preserves the view-model tab count so
  // filter.js can restore it after the filter is cleared. Preact
  // updates the attribute on every live-sync re-render, so it always
  // matches the current true count (unlike a DOM-text snapshot, which
  // would capture whatever a prior mutation left behind).
  return html` <span class="open-tabs-badge tab-count-badge" title=${title} data-original-count=${tabCount}>${tabCount}</span> `
}

function DedupButton({ count, dupeUrlsEncoded, onClick }) {
  // Short label ("Dedupe 2") keeps the inline mission-top row from
  // wrapping when the card also carries a subdomain pill. Full
  // "Close N duplicates" was ~150px wide at typical counts and
  // pushed the button below the tab badge on narrower cards. The
  // title attribute spells out the full action on hover for anyone
  // uncertain what "Dedupe" means here.
  const label = `Dedupe ${count}`
  const title = `Close ${count} duplicate${count !== 1 ? 's' : ''}`
  return html`
    <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls=${dupeUrlsEncoded} title=${title} onClick=${onClick}>${label}</button>
  `
}

export function DomainCard({ group }) {
  const vm = computeDomainCardViewModel(group)

  // Close-domain handler: scopes to filter-matching tabs when the
  // filter is active, preserves Chrome tab groups, animates the card
  // out (confetti + `.closing` CSS class) when the whole group is
  // closed, then re-renders from scratch.
  //
  // `card` is captured BEFORE the first await — `e.currentTarget`
  // is only valid during event dispatch, so accessing it after the
  // await would return null.
  async function onCloseDomain(e) {
    const card = e.currentTarget.closest('.mission-card')

    const filterInput = document.getElementById('tabFilter')
    const fq = (filterInput?.value || '').trim().toLowerCase()
    const scopedTabs = fq ? group.tabs.filter((t) => (t.title || '').toLowerCase().includes(fq) || (t.url || '').toLowerCase().includes(fq)) : group.tabs
    const urls = scopedTabs.map((t) => t.url)
    const useExact = !!fq || group.domain === '__landing-pages__' || !!group.label

    const snapshot = useExact ? await closeTabsExact(urls, { preserveGroups: true }) : await closeTabsByUrls(urls, { preserveGroups: true })

    if (card && !fq) {
      const rect = card.getBoundingClientRect()
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2)
      card.classList.add('closing')
      await new Promise((r) => setTimeout(r, 250))
    }

    markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''} from ${vm.displayName}`)
    await renderStaticDashboard()
  }

  // Dedup handler: fade the clicked button + every (Nx) badge via the
  // shared `.closing` CSS class, then renderStaticDashboard() rebuilds
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

    const dupeSnapshot = await closeDuplicateTabs(urls, true)

    btn.classList.add('closing')
    const card = btn.closest('.mission-card')
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach((b) => b.classList.add('closing'))
    }
    await new Promise((r) => setTimeout(r, 200))

    markClosure(dupeSnapshot, `Closed ${dupeSnapshot.length} duplicate${dupeSnapshot.length !== 1 ? 's' : ''}`)
    await renderStaticDashboard()
  }

  const classList = `mission-card domain-card${vm.isAppCard ? ' is-app' : ''}`

  return html`
    <div class=${classList} data-domain-id=${vm.stableId}>
      ${vm.closableCount > 0 && html` <${CardCloseButton} label=${vm.closableCountLabel} onClick=${onCloseDomain} /> `}
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${vm.displayName}</span>
          ${vm.singleSubdomainKey && html` <span class="mission-subdomain">${vm.singleSubdomainKey}</span> `}
          <${TabBadge} isAppCard=${vm.isAppCard} tabCount=${vm.tabCount} />
          ${vm.closableExtras > 0 && html` <${DedupButton} count=${vm.closableExtras} dupeUrlsEncoded=${vm.dupeUrlsEncoded} onClick=${onDedup} /> `}
        </div>
        <div class="mission-pages">
          ${vm.sections.map(
            (s) => html`
              <${SubdomainSection}
                key=${s.key || '__root__'}
                subdomainKey=${s.key}
                isShared=${s.isShared}
                sectionCount=${s.sectionCount}
                sectionClosableUrls=${s.sectionClosableUrls}
                showHeader=${s.showHeader}
                hasFlat=${s.hasFlat}
                flatVisibleChips=${s.flatVisibleChips}
                flatHiddenChips=${s.flatHiddenChips}
                flatHiddenCount=${s.flatHiddenCount}
                clusters=${s.clusters}
              />
            `
          )}
        </div>
      </div>
    </div>
  `
}
