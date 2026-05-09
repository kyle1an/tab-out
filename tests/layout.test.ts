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

test('source switch keeps one primed card-move refresh', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const previousRects = prepareDomainCardMoveAnimation\(currentMissionContainers\(\)\)/)
  assert.match(source, /layoutMoveRectsRef\.current = previousRects/)
  assert.doesNotMatch(source, /\[source,\s*pinnedDomains,\s*pinsLoaded\]/)
})

test('source switch indicator keeps transform-based transition', () => {
  const source = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')

  assert.match(source, /\[transform:translateX\(var\(--active-tab-left\)\)_translateY\(-50%\)\]/)
  assert.match(source, /\[transition:width_0\.2s_ease-in-out,transform_0\.2s_ease-in-out\]/)
  assert.doesNotMatch(source, /source-switch-indicator[^"]*-translate-y-1\/2/)
})

test('header controls share one height and corner radius contract', () => {
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const headerBarSource = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')
  const headerStatsSource = readFileSync(new URL('../src/components/HeaderStats.tsx', import.meta.url), 'utf8')
  const selectSource = readFileSync(new URL('../src/components/ui/select.tsx', import.meta.url), 'utf8')

  assert.match(baseCss, /--header-control-height: 34px/)
  assert.match(baseCss, /--header-control-radius: 16px/)
  assert.match(headerBarSource, /source-switch-root[^"]*h-\[var\(--header-control-height\)\][^"]*rounded-\[var\(--header-control-radius\)\]/)
  assert.match(headerBarSource, /source-switch-option[^"]*before:rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\]/)
  assert.match(headerBarSource, /source-switch-indicator[^"]*rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\]/)
  assert.match(headerBarSource, /<SelectTrigger\s+className="[^"]*h-\[var\(--header-control-height\)\][^"]*rounded-\[var\(--header-control-radius\)\]/)
  assert.match(headerBarSource, /<SelectContent[\s\S]*align="start"[\s\S]*alignItemWithTrigger=\{false\}[\s\S]*className="[^"]*rounded-\[var\(--header-control-radius\)\]/)
  assert.match(headerBarSource, /tab-filter[^"]*h-\[var\(--header-control-height\)\][^"]*rounded-\[var\(--header-control-radius\)\]/)
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
  const css = [
    readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8'),
    readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8')
  ].join('\n')
  const tabHistoryPanelSource = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')
  const shellRule = css.match(/\.dashboard-shell\s*\{([^}]*)\}/)
  const mainRule = css.match(/\.dashboard-main\s*\{([^}]*)\}/)
  const historyShellRule = css.match(/\.dashboard-shell\.has-history\s*\{([^}]*)\}/)
  const historyMainRule = css.match(/\.dashboard-shell\.has-history \.dashboard-main\s*\{([^}]*)\}/)

  assert.ok(shellRule)
  assert.ok(mainRule)
  assert.ok(historyShellRule)
  assert.ok(historyMainRule)

  assert.match(css, /--dashboard-history-edge-gutter:\s*12px;/)
  assert.doesNotMatch(css, /\.tab-history-panel\s*\{[^}]*padding-left:\s*var\(--dashboard-page-gutter\)/s)
  assert.doesNotMatch(tabHistoryPanelSource, /pl-\[var\(--dashboard-page-gutter\)\]/)
  assert.doesNotMatch(shellRule[1], /\bpadding(?:-(?:left|right))?\s*:/)
  assert.match(mainRule[1], /padding-left:\s*var\(--dashboard-page-gutter\)/)
  assert.match(mainRule[1], /padding-right:\s*var\(--dashboard-page-gutter\)/)
  assert.match(
    historyShellRule[1],
    /minmax\(\s*calc\(220px \+ var\(--dashboard-history-edge-gutter\)\),\s*calc\(260px \+ var\(--dashboard-history-edge-gutter\)\)\s*\)\s*minmax\(0, 1fr\)/
  )
  assert.match(historyMainRule[1], /padding-left:\s*0/)
  assert.match(historyMainRule[1], /padding-right:\s*var\(--dashboard-page-gutter\)/)
  assert.match(tabHistoryPanelSource, /className="[^"]*tab-history-panel[^"]*pl-\[var\(--dashboard-history-edge-gutter\)\]/)
})
