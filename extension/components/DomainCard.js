/* ================================================================
   <DomainCard> — top-level card component for a domain group.

   Renders the card chrome (status bar, close button, mission-top
   with title / subdomain pill / count badge, dedup action,
   mission-meta) declaratively via HTM, and delegates the inner
   subdomain/cluster/chip tree to <SubdomainSection>.

   Event handlers for close-domain-tabs and dedup-keep-one live
   here (moved from the app.js delegation switch in Phase 2).
   data-action attributes are kept on the buttons so external
   lookups still find them:
     • filter.js updates dedup's data-dupe-urls on filter change
     • ui.js updateCloseTabsButton decrements the close-domain
       button's count after dedup closes extras
     • dedup-global-keep-one in app.js aggregates per-card dedup URLs
   ================================================================ */

import { h } from '../vendor/preact.mjs'
import htm from '../vendor/htm.mjs'
import { closeTabsByUrls, closeTabsExact, closeDuplicateTabs } from '../tabs.js'
import { markClosure } from '../undo.js'
import { animateCardOut, updateCloseTabsButton } from '../ui.js'
import { packMissionsMasonry } from '../layout.js'
import { computeDomainCardViewModel, domainGroups, updateTabCountDisplays } from '../render.js'
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
  return html`
    <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls=${dupeUrlsEncoded} onClick=${onClick}>Close ${count} duplicate${count !== 1 ? 's' : ''}</button>
  `
}

export function DomainCard({ group }) {
  const vm = computeDomainCardViewModel(group)

  // Close-domain handler: mirrors the previous app.js delegation
  // logic. Scopes to filter-matching tabs when the filter is
  // active, preserves Chrome tab groups, animates the card out if
  // the whole group is closed.
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

    if (card && !fq) animateCardOut(card)

    if (!fq) {
      const idx = domainGroups.indexOf(group)
      if (idx !== -1) domainGroups.splice(idx, 1)
    }

    const groupLabel = vm.displayName
    markClosure(snapshot, `Closed ${snapshot.length} tab${snapshot.length !== 1 ? 's' : ''} from ${groupLabel}`)
    updateTabCountDisplays()
  }

  // Dedup handler: same behavior as the old app.js case — fade the
  // clicked button, close duplicates keeping one, fade the (Nx)
  // chip badges, decrement the card's visible counts, update the
  // sibling close-domain button via ui.js, re-pack masonry after
  // the animation, mark closure for undo.
  async function onDedup(e) {
    const btn = e.currentTarget
    const urlsEncoded = btn.dataset.dupeUrls || ''
    const urls = urlsEncoded
      .split(',')
      .map((u) => decodeURIComponent(u))
      .filter(Boolean)
    if (urls.length === 0) return

    const extrasClosed = parseInt((btn.textContent.match(/\d+/) || ['0'])[0], 10)
    const dupeSnapshot = await closeDuplicateTabs(urls, true)

    btn.style.transition = 'opacity 0.2s'
    btn.style.opacity = '0'
    setTimeout(() => btn.remove(), 200)

    const card = btn.closest('.mission-card')
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach((b) => {
        b.style.transition = 'opacity 0.2s'
        b.style.opacity = '0'
        setTimeout(() => b.remove(), 200)
      })
      const tabsBadge = card.querySelector('.tab-count-badge')
      if (tabsBadge) {
        const current = parseInt((tabsBadge.textContent.match(/\d+/) || ['0'])[0], 10)
        const next = Math.max(0, current - extrasClosed)
        tabsBadge.textContent = String(next)
        tabsBadge.title = `${next} open tab${next !== 1 ? 's' : ''}`
      }
      const meta = card.querySelector('.mission-page-count')
      if (meta) {
        const current = parseInt(meta.textContent, 10) || 0
        meta.textContent = String(Math.max(0, current - extrasClosed))
      }
      updateCloseTabsButton(card.querySelector('[data-action="close-domain-tabs"]'), extrasClosed)
    }

    updateTabCountDisplays()
    setTimeout(() => packMissionsMasonry(), 250)
    markClosure(dupeSnapshot, `Closed ${dupeSnapshot.length} duplicate${dupeSnapshot.length !== 1 ? 's' : ''}`)
  }

  const classList = `mission-card domain-card${vm.isAppCard ? ' is-app' : ''}`

  return html`
    <div class=${classList} data-domain-id=${vm.stableId}>
      <div class="status-bar"></div>
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
      <div class="mission-meta">
        <div class="mission-page-count">${vm.tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>
  `
}
