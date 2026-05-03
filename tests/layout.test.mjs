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
  const activeMoveRule = css.match(/\.missions\.is-packed \.domain-block\.layout-moving\.layout-moving-active\s*\{([^}]*)\}/)

  assert.ok(activeMoveRule)
  assert.match(activeMoveRule[1], /transform 0\.28s/)
  assert.doesNotMatch(activeMoveRule[1], /\b(top|left|width)\s+0\.\d+s/)
  assert.doesNotMatch(css, /\.missions\.is-packed \.domain-block\s*\{[^}]*transition:[^}]*\b(top|left|width)\b/s)
})

test('source switch keeps one primed card-move refresh', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const previousRects = prepareDomainCardMoveAnimation\(missionContainers\(\)\)/)
  assert.match(source, /layoutMoveRectsRef\.current = previousRects/)
  assert.doesNotMatch(source, /\[source,\s*pinnedDomains,\s*pinsLoaded\]/)
})

test('dashboard edge gutters are owned by panes instead of the shell', () => {
  const css = [
    readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8'),
    readFileSync(new URL('../extension/style.css', import.meta.url), 'utf8')
  ].join('\n')
  const shellRule = css.match(/\.dashboard-shell\s*\{([^}]*)\}/)
  const mainRule = css.match(/\.dashboard-main\s*\{([^}]*)\}/)
  const historyShellRule = css.match(/\.dashboard-shell\.has-history\s*\{([^}]*)\}/)
  const historyMainRule = css.match(/\.dashboard-shell\.has-history \.dashboard-main\s*\{([^}]*)\}/)
  const historyPanelRule = css.match(/\.tab-history-panel\s*\{([^}]*)\}/)

  assert.ok(shellRule)
  assert.ok(mainRule)
  assert.ok(historyShellRule)
  assert.ok(historyMainRule)
  assert.ok(historyPanelRule)

  assert.match(css, /--dashboard-history-edge-gutter:\s*12px;/)
  assert.doesNotMatch(css, /\.tab-history-panel\s*\{[^}]*padding-left:\s*var\(--dashboard-page-gutter\)/s)
  assert.doesNotMatch(shellRule[1], /\bpadding(?:-(?:left|right))?\s*:/)
  assert.match(mainRule[1], /padding-left:\s*var\(--dashboard-page-gutter\)/)
  assert.match(mainRule[1], /padding-right:\s*var\(--dashboard-page-gutter\)/)
  assert.match(
    historyShellRule[1],
    /minmax\(\s*calc\(220px \+ var\(--dashboard-history-edge-gutter\)\),\s*calc\(260px \+ var\(--dashboard-history-edge-gutter\)\)\s*\)\s*minmax\(0, 1fr\)/
  )
  assert.match(historyMainRule[1], /padding-left:\s*0/)
  assert.match(historyMainRule[1], /padding-right:\s*var\(--dashboard-page-gutter\)/)
  assert.match(historyPanelRule[1], /padding-left:\s*var\(--dashboard-history-edge-gutter\)/)
})
