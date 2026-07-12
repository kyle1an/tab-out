import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { chipTrim, CHIP_TRIM_TOKENS, type ChipTrimFacts } from '../src/components/chip-trim/index.js'

/* The Chip Trim decision table, tested as a table: facts in, paint out.
   These tests cross the module's interface — never the source text. */

function facts(overrides: Partial<ChipTrimFacts> = {}): ChipTrimFacts {
  return {
    activeChipFrame: false,
    activeInOtherWindow: false,
    isCurrentTabOut: false,
    closedSavedPage: false,
    folded: false,
    titleVariantGroup: false,
    iconOnly: false,
    isApp: false,
    expanded: null,
    ...overrides
  }
}

const OUTLINE_TRIO = /hover:outline-1.*-outline-offset-1.*outline-\(--chip-group-hover-border\)/
const OPAQUE_CLICKABLE = 'color-mix(in srgb, var(--card-bg) 90%, var(--color-neutral-600) 10%)'
const TRANSLUCENT_CLICKABLE = 'color-mix(in srgb, var(--color-neutral-600) 10%, transparent)'
const GROUP_BG = 'color-mix(in srgb, var(--card-bg) 96.5%, var(--color-neutral-600) 3.5%)'
const ACTIVE_OTHER_BG = 'color-mix(in srgb, var(--card-bg) 88%, var(--color-neutral-600) 12%)'
const ACTIVE_OTHER_REST = 'color-mix(in srgb, var(--card-bg) 92.5%, var(--color-neutral-600) 7.5%)'

test('chip-trim: plain chips get the translucent fill and no trim', () => {
  const trim = chipTrim(facts())
  assert.match(trim.chipClasses, /hover:bg-\(--chip-interaction-bg\)/)
  assert.match(trim.chipClasses, /\[&\.page-chip-context-menu-open\]:bg-\(--chip-interaction-bg\)/)
  assert.match(trim.chipClasses, /\[&\.page-chip-tooltip-open\]:bg-\(--chip-interaction-bg\)/)
  assert.doesNotMatch(trim.chipClasses, /outline/)
  assert.doesNotMatch(trim.chipClasses, /ring-/)
  assert.equal(trim.frame, null)
  assert.equal(trim.expandedFill, null)
  assert.equal(trim.iconChipClasses, '')
  assert.equal(trim.slotClasses, CHIP_TRIM_TOKENS.slotRow)
  assert.equal(trim.styleVars.interactionBg, TRANSLUCENT_CLICKABLE)
  assert.equal(trim.styleVars.fadeBg, OPAQUE_CLICKABLE)
  assert.equal(trim.styleVars.restBg, 'transparent')
})

test('chip-trim: saved-closed chips carry the marker and the interaction outline', () => {
  const trim = chipTrim(facts({ closedSavedPage: true }))
  assert.match(trim.chipClasses, new RegExp(`\\b${CHIP_TRIM_TOKENS.savedClosed}\\b`))
  assert.match(trim.chipClasses, /text-tab-muted/)
  assert.match(trim.chipClasses, OUTLINE_TRIO)
  assert.equal(trim.frame, null)
  assert.equal(trim.styleVars.interactionBg, GROUP_BG)
  assert.equal(trim.styleVars.fadeBg, GROUP_BG)
})

test('chip-trim: variant-group and folded chips get the group outline', () => {
  for (const kind of [{ titleVariantGroup: true }, { folded: true }]) {
    const trim = chipTrim(facts(kind))
    assert.match(trim.chipClasses, OUTLINE_TRIO)
    assert.doesNotMatch(trim.chipClasses, new RegExp(`\\b${CHIP_TRIM_TOKENS.savedClosed}\\b`))
    assert.equal(trim.frame, null)
    assert.equal(trim.styleVars.interactionBg, GROUP_BG)
  }
})

test('chip-trim: an active frame suppresses the group outline', () => {
  const trim = chipTrim(facts({ titleVariantGroup: true, activeChipFrame: true, activeInOtherWindow: true }))
  assert.doesNotMatch(trim.chipClasses, /outline/)
  assert.ok(trim.frame, 'active variant groups draw the frame instead')
  assert.match(trim.frame.classes, /rgba\(115,115,115,0\.2\)/)
  assert.equal(trim.styleVars.interactionBg, ACTIVE_OTHER_BG)
})

test('chip-trim: the three frame flavours resolve by precedence', () => {
  const activeOther = chipTrim(facts({ activeChipFrame: true, activeInOtherWindow: true }))
  assert.match(activeOther.chipClasses, /bg-\(--chip-rest-bg\)/)
  assert.doesNotMatch(activeOther.chipClasses, /current-active-chip|current-tab-out-chip/)
  assert.ok(activeOther.frame)
  assert.match(activeOther.frame.classes, /rgba\(115,115,115,0\.2\)/)
  assert.equal(activeOther.styleVars.restBg, ACTIVE_OTHER_REST)

  const currentActive = chipTrim(facts({ activeChipFrame: true }))
  assert.match(currentActive.chipClasses, /current-active-chip .*ring-1 ring-inset ring-neutral-400/)
  assert.ok(currentActive.frame)
  assert.match(currentActive.frame.classes, /current-active-chip-frame/)
  assert.equal(currentActive.styleVars.interactionBg, 'var(--color-neutral-50)')

  const currentTabOut = chipTrim(facts({ activeChipFrame: true, isCurrentTabOut: true }))
  assert.match(currentTabOut.chipClasses, /current-tab-out-chip /)
  assert.ok(currentTabOut.frame)
  assert.match(currentTabOut.frame.classes, /current-tab-out-chip-frame/)
  assert.equal(currentTabOut.styleVars.interactionBg, 'var(--color-neutral-100)')
  assert.equal(currentTabOut.styleVars.restBg, 'transparent')

  // activeInOtherWindow outranks isCurrentTabOut — the tab is not current here.
  const otherWindowTabOut = chipTrim(facts({ activeChipFrame: true, activeInOtherWindow: true, isCurrentTabOut: true }))
  assert.doesNotMatch(otherWindowTabOut.chipClasses, /current-tab-out-chip /)
})

test('chip-trim: a kind with no trim at rest gains none in any state', () => {
  // The owner's rule, executable: plain chips never gain a border or outline
  // from expansion (hover/menu feedback is fill-only by construction — their
  // classes carry no outline/ring/border utilities to reveal).
  const expansions: ChipTrimFacts['expanded'][] = [
    null,
    { grewTaller: false, y: 'down' },
    { grewTaller: true, y: 'down' },
    { grewTaller: false, y: 'up' },
    { grewTaller: true, y: 'up' }
  ]
  for (const expanded of expansions) {
    const trim = chipTrim(facts({ expanded }))
    assert.doesNotMatch(trim.chipClasses, /outline|ring-|border(?!-0)/)
    assert.equal(trim.frame, null)
  }
})

test('chip-trim: the expanded fill spares flush edges and extends grown edges', () => {
  const inPlaceDown = chipTrim(facts({ expanded: { grewTaller: false, y: 'down' } })).expandedFill
  assert.ok(inPlaceDown)
  assert.equal(inPlaceDown.top, '1px')
  assert.equal(inPlaceDown.bottom, '1px')
  assert.equal(inPlaceDown.background, OPAQUE_CLICKABLE)

  const grownDown = chipTrim(facts({ expanded: { grewTaller: true, y: 'down' } })).expandedFill
  assert.ok(grownDown)
  assert.equal(grownDown.top, '1px')
  assert.equal(grownDown.bottom, '0px')

  const grownUp = chipTrim(facts({ expanded: { grewTaller: true, y: 'up' } })).expandedFill
  assert.ok(grownUp)
  assert.equal(grownUp.top, '0px')
  assert.equal(grownUp.bottom, '1px')

  const inPlaceUp = chipTrim(facts({ expanded: { grewTaller: false, y: 'up' } })).expandedFill
  assert.ok(inPlaceUp)
  assert.equal(inPlaceUp.top, '1px')
  assert.equal(inPlaceUp.bottom, '1px')
})

test('chip-trim: only expanded plain full-width chips get the fill layer', () => {
  const expanded: ChipTrimFacts['expanded'] = { grewTaller: false, y: 'down' }
  assert.equal(chipTrim(facts({ expanded, closedSavedPage: true })).expandedFill, null)
  assert.equal(chipTrim(facts({ expanded, titleVariantGroup: true })).expandedFill, null)
  assert.equal(chipTrim(facts({ expanded, activeChipFrame: true })).expandedFill, null)
  assert.equal(chipTrim(facts({ expanded, iconOnly: true })).expandedFill, null)
})

test('chip-trim: the fade fill is never the translucent overlay', () => {
  // The fade exists to hide chip text under the action rail; a translucent
  // fade would let the text show through.
  const kinds: Partial<ChipTrimFacts>[] = [
    {},
    { closedSavedPage: true },
    { folded: true },
    { titleVariantGroup: true },
    { activeChipFrame: true },
    { activeChipFrame: true, activeInOtherWindow: true },
    { activeChipFrame: true, isCurrentTabOut: true },
    { iconOnly: true }
  ]
  for (const kind of kinds) {
    assert.notEqual(chipTrim(facts(kind)).styleVars.fadeBg, TRANSLUCENT_CLICKABLE)
  }
})

test('chip-trim: icon-only slots never join vertical seam runs', () => {
  const icon = chipTrim(facts({ iconOnly: true }))
  assert.equal(icon.slotClasses, '')
  assert.equal(icon.frame, null, 'icon chips draw their trim on the chip itself, not a frame span')
  assert.match(icon.iconChipClasses, /\[outline:1px_solid_rgba\(115,115,115,0\.18\)\]/)

  const app = chipTrim(facts({ iconOnly: true, isApp: true }))
  assert.match(app.iconChipClasses, /border-\[rgba\(115,115,115,0\.32\)\]/)
  assert.doesNotMatch(app.iconChipClasses, /\[outline:1px_solid_rgba\(115,115,115,0\.18\)\]/)

  const active = chipTrim(facts({ iconOnly: true, activeChipFrame: true }))
  assert.match(active.iconChipClasses, /\[outline:1px_solid_rgba\(82,82,82,0\.32\)\]/)
  assert.match(active.iconChipClasses, /bg-\(--chip-rest-bg\)/)
})

/* The CSS rump is part of the interface: exactly the rules that must stay
   CSS (the adjacent-sibling seam overlap; :hover-keyed rules that must swap
   inside one style recalculation), with selectors spelled from
   CHIP_TRIM_TOKENS. */
test('chip-trim: the CSS rump holds exactly the four seam rule groups', () => {
  const css = readFileSync(new URL('../src/components/chip-trim/chip-trim.css', import.meta.url), 'utf8')

  const overlapStart = css.indexOf(`.${CHIP_TRIM_TOKENS.slotRow} + .${CHIP_TRIM_TOKENS.slotRow}`)
  assert.notEqual(overlapStart, -1, 'the unconditional seam-overlap rule should exist')
  const overlapRule = css.slice(overlapStart, css.indexOf('}', overlapStart) + 1)
  assert.match(overlapRule, /margin-top: -1px/)
  assert.doesNotMatch(overlapRule, /:has\(/)
  assert.doesNotMatch(overlapRule, /:hover/)

  assert.match(css, new RegExp(`\\.chip-slot:has\\(\\.page-chip:is\\(:hover, \\.${CHIP_TRIM_TOKENS.contextMenuOpen}, \\.${CHIP_TRIM_TOKENS.tooltipOpen}\\)\\)\\s*\\{\\s*z-index: 4;`))
  assert.match(css, new RegExp(`\\.page-chip:is\\(:hover, \\.${CHIP_TRIM_TOKENS.contextMenuOpen}, \\.${CHIP_TRIM_TOKENS.tooltipOpen}\\) > \\.${CHIP_TRIM_TOKENS.frame}\\s*\\{\\s*box-shadow: inset 0 0 0 1px rgba\\(38, 38, 38, 0\\.55\\);`))
  assert.match(css, new RegExp(`\\.page-chip\\.${CHIP_TRIM_TOKENS.hoverMatch}\\s*\\{[^}]*outline: 1px solid var\\(--accent-amber\\);`))
  assert.match(css, new RegExp(`\\.chip-slot:has\\(\\.${CHIP_TRIM_TOKENS.hoverMatch}\\)\\s*\\{\\s*z-index: 3;`))

  const ruleCount = (css.match(/^\}/gm) || []).length
  assert.equal(ruleCount, 5, 'the rump holds exactly five rules (overlap, z-lift, strengthen, hover-match outline, hover-match z)')
})
