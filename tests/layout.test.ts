import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { chooseMasonryLayout, shouldAnimateMasonryResize } from '../src/extension/layout.js'

test('chooseMasonryLayout delays a new column until the width is near the comfort target', () => {
  const beforeThreshold = chooseMasonryLayout(1340)
  const afterThreshold = chooseMasonryLayout(1390)

  assert.equal(beforeThreshold.colCount, 4)
  assert.equal(afterThreshold.colCount, 5)
  assert.equal(beforeThreshold.colWidth, 327.5)
  assert.equal(afterThreshold.colWidth, 270)
})

test('chooseMasonryLayout supports wider desktop comfort targets', () => {
  const beforeThreshold = chooseMasonryLayout(1390, {
    minColWidth: 280,
    idealColWidth: 340
  })
  const afterThreshold = chooseMasonryLayout(1550, {
    minColWidth: 280,
    idealColWidth: 340
  })

  assert.equal(beforeThreshold.colCount, 4)
  assert.equal(afterThreshold.colCount, 5)
  assert.equal(beforeThreshold.colWidth, 340)
  assert.equal(afterThreshold.colWidth, 302)
})

test('chooseMasonryLayout never chooses a column count narrower than the minimum width', () => {
  const layout = chooseMasonryLayout(1060)

  assert.equal(layout.colCount, 3)
  assert.ok(layout.colWidth >= 260)
})

test('chooseMasonryLayout keeps a single narrow column when the container is too small', () => {
  const layout = chooseMasonryLayout(220)

  assert.deepEqual(layout, {
    colCount: 1,
    colWidth: 220
  })
})

test('shouldAnimateMasonryResize only changes when the column count changes', () => {
  assert.equal(shouldAnimateMasonryResize(1360, 4), false)
  assert.equal(shouldAnimateMasonryResize(1390, 4), true)
  assert.equal(shouldAnimateMasonryResize(1390, undefined), false)
})

test('masonry card motion uses transform instead of layout-property transitions', () => {
  const css = readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8')
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')

  assert.match(domainCardSource, /\[\.missions\.is-packed_&\.layout-moving\.layout-moving-active\]:\[transition:transform_0\.28s_cubic-bezier\(0\.2,0,0,1\)\]/)
  assert.doesNotMatch(domainCardSource, /\b(?:top|left|width)_0\.\d+s/)
  assert.doesNotMatch(css, /\.missions\.is-packed \.domain-block\s*\{[^}]*transition:[^}]*\b(top|left|width)\b/s)
})

test('card move animation preserves previous rect starts while allowing temporary history-pane bleed', () => {
  const animationSource = readFileSync(new URL('../src/extension/card-move-animation.ts', import.meta.url), 'utf8')
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')

  assert.match(animationSource, /const dx = previous\.left - next\.left/)
  assert.match(animationSource, /const dy = previous\.top - next\.top/)
  assert.doesNotMatch(animationSource, /constrainCardMoveStart/)
  assert.match(animationSource, /CARD_MOVE_BLEED_CLASS = 'card-motion-bleed'/)
  assert.match(animationSource, /scrollRegion\.classList\.add\(CARD_MOVE_BLEED_CLASS\)/)
  assert.match(animationSource, /scrollRegion\.classList\.remove\(CARD_MOVE_BLEED_CLASS\)/)
  assert.match(animationSource, /export type CardMoveAnimationOptions = \{[\s\S]*allowBleed\?: boolean[\s\S]*\}/)
  assert.match(animationSource, /if \(allowBleed\) enableCardMoveBleed\(containers\)/)
  assert.match(baseCss, /\.dashboard-shell\.has-history \.dashboard-main > \.scroll-region\.card-motion-bleed\s*\{/)
  assert.match(baseCss, /--dashboard-card-motion-left-bleed:\s*calc\(260px \+ var\(--dashboard-history-edge-gutter\) \+ 16px\)/)
  assert.match(baseCss, /margin-left:\s*calc\(0px - var\(--dashboard-card-motion-left-bleed\) - var\(--dashboard-card-shadow-bleed\)\)/)
  assert.match(baseCss, /padding-left:\s*calc\(var\(--dashboard-card-motion-left-bleed\) \+ var\(--dashboard-card-shadow-bleed\)\)/)
})

test('domain card mission names use the heaviest title weight', () => {
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  const missionNameMatch = domainCardSource.match(/mission-name[^"]*/)

  assert.ok(missionNameMatch, 'mission-name class should exist')
  assert.match(missionNameMatch[0], /\bfont-black\b/)
  assert.doesNotMatch(missionNameMatch[0], /\bfont-semibold\b/)
})

test('source switch keeps one primed card-move refresh', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const previousRects = prepareDomainCardMoveAnimation\(currentMissionContainers\(\)\)/)
  assert.match(source, /layoutMoveRectsRef\.current = previousRects/)
  assert.doesNotMatch(source, /\[source,\s*pinnedDomains,\s*pinsLoaded\]/)
})

test('working set is merged into the history panel instead of rendering a top strip', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const historyWorkingSet = source === 'tabs' \? workingSet : null/)
  assert.match(source, /workingSet=\{historyWorkingSet\}/)
  assert.doesNotMatch(source, /<WorkingSetPanel\b/)
  assert.doesNotMatch(source, /workingSetLayoutRectsRef|primeWorkingSetLayoutChange|animateWorkingSetLayoutChange/)
})

test('source switch indicator keeps transform-based transition', () => {
  const source = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')

  assert.match(source, /\[transform:translateX\(var\(--active-tab-left\)\)_translateY\(-50%\)\]/)
  assert.match(source, /\[transition:width_0\.2s_ease-in-out,transform_0\.2s_ease-in-out\]/)
  assert.doesNotMatch(source, /source-switch-indicator[^"]*-translate-y-1\/2/)
})

test('header controls share one size and corner radius contract', () => {
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const headerBarSource = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')
  const headerStatsSource = readFileSync(new URL('../src/components/HeaderStats.tsx', import.meta.url), 'utf8')
  const selectSource = readFileSync(new URL('../src/components/ui/select.tsx', import.meta.url), 'utf8')

  assert.match(baseCss, /--header-control-height: 34px/)
  assert.match(baseCss, /--header-control-radius: 16px/)
  assert.match(baseCss, /--header-control-font-size: 13px/)
  assert.match(baseCss, /--header-control-line-height: 16px/)
  assert.match(headerBarSource, /source-switch-root[^"]*h-\[var\(--header-control-height\)\][^"]*rounded-\[var\(--header-control-radius\)\]/)
  assert.match(headerBarSource, /source-switch-option[^"]*text-\[length:var\(--header-control-font-size\)\][^"]*leading-\[var\(--header-control-line-height\)\]/)
  assert.match(headerBarSource, /source-switch-option[^"]*before:rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\]/)
  assert.match(headerBarSource, /source-switch-indicator[^"]*rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\]/)
  assert.match(headerBarSource, /<SelectTrigger\s+className="[^"]*h-\[var\(--header-control-height\)\][^"]*rounded-\[var\(--header-control-radius\)\][^"]*text-\[length:var\(--header-control-font-size\)\][^"]*leading-\[var\(--header-control-line-height\)\]/)
  assert.match(headerBarSource, /<SelectContent[\s\S]*align="start"[\s\S]*alignItemWithTrigger=\{false\}[\s\S]*className="[^"]*rounded-\[var\(--header-control-radius\)\]/)
  assert.match(headerBarSource, /<SelectItem[\s\S]*className="[^"]*rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\][^"]*text-\[length:var\(--header-control-font-size\)\][^"]*leading-\[var\(--header-control-line-height\)\]/)
  assert.match(headerBarSource, /tab-filter[^"]*h-\[var\(--header-control-height\)\][^"]*rounded-\[var\(--header-control-radius\)\][^"]*text-\[length:var\(--header-control-font-size\)\][^"]*leading-\[var\(--header-control-line-height\)\]/)
  assert.match(headerStatsSource, /action-btn[^"]*h-\(--header-control-height\)[^"]*rounded-\[var\(--header-control-radius\)\]/)
  assert.doesNotMatch(headerBarSource, /<SelectTrigger\s+size="header"|<SelectContent\s+size="header"/)
  assert.doesNotMatch(selectSource, /data-\[size=header\]|in-data-\[size=header\]|SelectPrimitive\.Popup[\s\S]*data-size=\{size\}|SelectPrimitive\.List[\s\S]*data-size=\{size\}/)
  assert.doesNotMatch(headerBarSource, /source-switch-root[^"]*rounded-\[16px\]|tab-filter[^"]*rounded-\[12px\]|source-switch-(?:option|indicator)[^"]*_-_[457]px/)
  assert.doesNotMatch(headerStatsSource, /action-btn[^"]*rounded-\[10px\]/)
})

test('masonry resize observer rebinds after conditional mission grids mount', () => {
  const source = readFileSync(new URL('../src/extension/layout.ts', import.meta.url), 'utf8')

  assert.match(source, /useLayoutEffect\(\(\) => \{/)
  assert.match(source, /observer\.observe\(container\)/)
  assert.doesNotMatch(source, /\},\s*containerRefs\.map\(\(ref\) => ref\.current\)\s*\)/)
})

test('dashboard edge gutters are owned by panes instead of the shell', () => {
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')

  // .dashboard-shell / .dashboard-main own-box layout lives as inline Tailwind
  // utilities in App.tsx; the class names survive in base.css only as selector
  // anchors. These assertions follow the layout to its new home.
  const shellClass = appSource.match(/'dashboard-shell([^']*)'/)
  const shellHistoryBranch = appSource.match(/\?\s*'has-history([^']*)'/)
  const shellPlainBranch = appSource.match(/:\s*'grid-cols-\[minmax\(0,1fr\)\]'/)
  const mainClass = appSource.match(/'dashboard-main([^']*)'/)
  const mainHistoryBranch = appSource.match(/\?\s*'\[grid-column:2\]([^']*)'/)
  const mainPlainBranch = appSource.match(/:\s*'\[grid-column:1\]([^']*)'/)

  assert.ok(shellClass)
  assert.ok(shellHistoryBranch)
  assert.ok(shellPlainBranch)
  assert.ok(mainClass)
  assert.ok(mainHistoryBranch)
  assert.ok(mainPlainBranch)

  assert.match(baseCss, /--dashboard-history-edge-gutter:\s*12px;/)

  // Edge gutters are NOT on the shell.
  assert.doesNotMatch(shellClass[1], /\bp[xlr]?-/)

  // The page gutter padding is owned by the main pane (default and has-history).
  assert.match(mainPlainBranch[1], /px-\[var\(--dashboard-page-gutter\)\]/)
  assert.match(mainHistoryBranch[1], /\bpl-0\b/)
  assert.match(mainHistoryBranch[1], /pr-\[var\(--dashboard-page-gutter\)\]/)

  // has-history shell is a two-column grid sized off the history edge gutter.
  assert.match(
    shellHistoryBranch[1],
    /grid-cols-\[minmax\(calc\(220px_\+_var\(--dashboard-history-edge-gutter\)\),calc\(260px_\+_var\(--dashboard-history-edge-gutter\)\)\)_minmax\(0,1fr\)\]/
  )

  // The history panel keeps its own edge gutter, never the page gutter.
  assert.doesNotMatch(tabHistoryPanelSource, /pl-\[var\(--dashboard-page-gutter\)\]/)
  assert.match(tabHistoryPanelSource, /className="[^"]*tab-history-panel[^"]*pl-\[var\(--dashboard-history-edge-gutter\)\]/)
})
