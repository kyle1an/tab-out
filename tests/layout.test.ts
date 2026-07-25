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
  const css = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')
  const moveAnimationSource = readFileSync(new URL('../src/extension/move-animation.ts', import.meta.url), 'utf8')

  assert.match(moveAnimationSource, /transform \$\{config\.duration\}ms var\(--ease-swift\)/)
  assert.doesNotMatch(domainCardSource, /layout-moving[^'"]*\[transition:/)
  assert.doesNotMatch(domainCardSource, /\b(?:top|left|width)_0\.\d+s/)
  assert.doesNotMatch(css, /\.missions\.is-packed \.domain-block\s*\{[^}]*transition:[^}]*\b(top|left|width)\b/s)
})

test('card move animation preserves previous rect starts while allowing temporary history-pane bleed', () => {
  const animationSource = readFileSync(new URL('../src/extension/card-move-animation.ts', import.meta.url), 'utf8')
  const moveAnimationSource = readFileSync(new URL('../src/extension/move-animation.ts', import.meta.url), 'utf8')
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')

  assert.match(moveAnimationSource, /const dx = previousPosition\.left - next\.left/)
  assert.match(moveAnimationSource, /const dy = previousPosition\.top - next\.top/)
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

test('user-driven pinned domain order changes prime card move animation', () => {
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const localStateHookSource = readFileSync(new URL('../src/hooks/useDashboardLocalState.ts', import.meta.url), 'utf8')

  assert.match(appSource, /onBeforeApplyPinnedDomains:\s*\(\{ animate \}\) => \{[\s\S]*resetMissionOrder\(\)[\s\S]*if \(animate\) primeCardMoveAnimation\(\)/)
  assert.match(localStateHookSource, /onBeforeApplyPinnedDomainsRef\.current\?\.\(\{ animate: false \}\)/)
  assert.match(localStateHookSource, /onBeforeApplyPinnedDomainsRef\.current\?\.\(\{ animate: true \}\)/)
})

test('pin-driven dashboard refresh cancels its pending animation frame', () => {
  const source = readFileSync(new URL('../src/hooks/useDashboardRefresh.ts', import.meta.url), 'utf8')
  const callbackIndex = source.indexOf('callbacksRef.current.onBeforePinnedRefresh?.()')
  const effectStart = source.lastIndexOf('useEffect(() => {', callbackIndex)
  const effectEnd = source.indexOf('}, [pinnedDomains, localStateLoaded])', callbackIndex)
  const effectSource = source.slice(effectStart, effectEnd)

  assert.ok(callbackIndex > -1 && effectStart > -1 && effectEnd > callbackIndex)
  assert.match(effectSource, /const frame = requestAnimationFrame/)
  assert.match(effectSource, /return \(\) => cancelAnimationFrame\(frame\)/)
})

test('no-op pinned domain drag targets use a muted placement state', () => {
  const domainCardSource = readFileSync(new URL('../src/components/DomainCard.tsx', import.meta.url), 'utf8')

  assert.match(domainCardSource, /data-tabout-reorder-noop/)
  assert.match(domainCardSource, /previousPinnedDomainBlock\(targetBlock\) === sourceBlock/)
  assert.match(domainCardSource, /nextPinnedDomainBlock\(targetBlock\) === sourceBlock/)
  assert.match(domainCardSource, /data-\[tabout-reorder-target=true\]:before:h-\[2px\]/)
  assert.doesNotMatch(domainCardSource, /data-\[tabout-reorder-target=true\]:before:h-px/)
  assert.doesNotMatch(domainCardSource, /data-\[tabout-reorder-target=true\]:before:h-\[3px\]/)
  // The muted placement indicator rides on the domain block; the cardless
  // content wrapper should not regain a frame for a no-op target.
  assert.match(domainCardSource, /data-\[tabout-reorder-noop=true\]:before:bg-\[color-mix\(in_srgb,var\(--accent-amber\)_36%,var\(--warm-gray\)\)\]/)
  assert.doesNotMatch(domainCardSource, /group-data-\[tabout-reorder-noop=true\]\/domain-block:border-/)
})

test('working set is merged into the history panel instead of rendering a top strip', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const historyWorkingSet = source === 'tabs' \? workingSet : null/)
  assert.match(source, /workingSet=\{historyWorkingSet\}/)
  assert.match(source, /workingSet=\{historyPanelWorkingSet\}/)
  assert.doesNotMatch(source, /<WorkingSetPanel\b/)
  assert.doesNotMatch(source, /workingSetLayoutRectsRef|primeWorkingSetLayoutChange|animateWorkingSetLayoutChange/)
})

test('activation history uses hydrated Working Set targets while startup ordering stays frozen', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const visibleWorkingSet = dashboardContentVisible \? effectiveStartupPriorityWorkingSet \?\? workingSet : null/)
  assert.match(source, /const historyPanelWorkingSet = dashboardContentVisible \? workingSet : null/)
  assert.match(source, /workingSet: visibleWorkingSet/)
  assert.match(source, /workingSet=\{historyPanelWorkingSet\}/)
})

test('tabs source reserves the history column before dashboard data is ready', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')

  assert.match(source, /const showTabHistory = source === 'tabs'/)
  assert.doesNotMatch(source, /const showTabHistory = isReady && source === 'tabs'/)
})

test('activation history panel stays visually empty when there are no rows', () => {
  const source = readFileSync(new URL('../src/components/TabHistoryPanel.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /No activation history yet/)
})

test('startup snapshot updates dashboard and history rows atomically', () => {
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const refreshSource = readFileSync(new URL('../src/hooks/useDashboardRefresh.ts', import.meta.url), 'utf8')

  assert.match(appSource, /type: 'startupSnapshot'/)
  assert.match(appSource, /function appDashboardSnapshotFields/)
  assert.match(appSource, /closedTabs: snapshot\?\.closedTabs \?\? \[\]/)
  assert.match(appSource, /dashboard: snapshot\?\.dashboard \?\? null/)
  assert.match(appSource, /tabHistory: snapshot\?\.tabHistory \?\? null/)
  assert.match(appSource, /workingSet: snapshot\?\.workingSet \?\? null/)
  assert.match(appSource, /case 'startupSnapshot': \{[\s\S]*const sourceSnapshotFields = appDashboardSnapshotFields\(action\.snapshot\)[\s\S]*state\.sourceRequestId !== state\.sourceAppliedRequestId[\s\S]*deferredStartupSourceFields: sourceSnapshotFields/)
  assert.match(refreshSource, /export async function fetchDashboardStartupSnapshot/)
  assert.match(refreshSource, /fetchClosedTabs/)
  assert.match(refreshSource, /buildWorkingSetSnapshot/)
  assert.match(refreshSource, /fetchDashboardServiceState/)
  assert.match(refreshSource, /startupSnapshotFlight/)
})

test('app bootstrap paints filter shell before cached startup content and live refresh', () => {
  const appEntrySource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')
  const appSource = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const localStateSource = readFileSync(new URL('../src/hooks/useDashboardLocalState.ts', import.meta.url), 'utf8')
  const refreshSource = readFileSync(new URL('../src/hooks/useDashboardRefresh.ts', import.meta.url), 'utf8')
  const startupSnapshotSource = readFileSync(new URL('../src/extension/startup-snapshot.ts', import.meta.url), 'utf8')
  const startupOrderDebugSource = readFileSync(new URL('../src/components/startup-order-debug.ts', import.meta.url), 'utf8')
  const startupOrderDebugHeavySource = readFileSync(new URL('../src/components/startup-order-debug-heavy.ts', import.meta.url), 'utf8')
  const viewModelSource = readFileSync(new URL('../src/hooks/useDashboardViewModels.ts', import.meta.url), 'utf8')

  assert.match(appEntrySource, /loadCachedDashboardStartup/)
  assert.match(appEntrySource, /loadDashboardLocalState/)
  assert.match(appEntrySource, /loadHistoryRangePreference/)
  assert.match(appEntrySource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'startup-cache-loaded'/)
  assert.match(appEntrySource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'local-state-ready'/)
  assert.match(appEntrySource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'attach-app'\)\nattachApp\(\)/)
  assert.ok(appEntrySource.indexOf('attachApp()') < appEntrySource.indexOf('async function initializeApp()'))
  assert.doesNotMatch(appEntrySource, /Promise\.all\(/)
  assert.match(appEntrySource, /const localState = cachedStartup\?\.localState \?\? await loadDashboardLocalState\(\)/)
  assert.match(appEntrySource, /addCurrentTabOutPageToStartupSnapshot/)
  assert.match(appEntrySource, /const currentTabOutPagePromise = cachedStartupSnapshot \? getCurrentTabOutPageForStartup\(\) : Promise\.resolve\(null\)/)
  assert.match(appEntrySource, /const startupSnapshot = fallbackStartupSnapshot/)
  assert.match(appEntrySource, /applyAppStartup\(\{ historyRange, localState, snapshot: startupSnapshot \}\)/)
  assert.doesNotMatch(appEntrySource, /mountApp\(/)
  assert.doesNotMatch(appEntrySource, /getLiveStartupSnapshotFromBackground/)
  assert.doesNotMatch(appEntrySource, /requestDashboardRefresh\(\{ startupSnapshot: true/)
  assert.doesNotMatch(appEntrySource, /startupSnapshot: true, animateCards/)
  assert.match(appSource, /startupRefreshRequestedRef/)
  assert.match(appSource, /firstDashboardLayoutRecordedRef/)
  assert.match(appSource, /const \[dashboardContentVisible, setDashboardContentVisible\] = useState\(false\)/)
  assert.match(appSource, /requestAnimationFrame\(\(\) => setDashboardContentVisible\(true\)\)/)
  assert.match(appSource, /const visibleDashboard = dashboardContentVisible \? dashboard : null/)
  assert.match(appSource, /startupPriorityWorkingSet/)
  assert.match(appSource, /dashboard: visibleDashboard/)
  assert.match(appSource, /workingSet: visibleWorkingSet/)
  assert.match(appSource, /freezeTabsChipOrder: dashboardContentVisible && !!effectiveStartupPriorityWorkingSet/)
  assert.match(appSource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'first-dashboard-layout'/)
  assert.match(appSource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'live-startup-refresh-requested'/)
  assert.match(appSource, /recordStartupTiming\(STARTUP_ORDER_DEBUG_CAPTURE, 'live-startup-snapshot-applied'/)
  assert.match(appSource, /refreshDashboard\(\{ startupSnapshot: true \}\)/)
  assert.match(appSource, /enabled: dashboardContentVisible/)
  assert.match(appSource, /startupRefreshRequestedRef\.current \|\| !dashboardContentVisible \|\| !localStateLoaded/)
  assert.match(appSource, /useMissionOrderMemory\(\{[\s\S]*useEffect\(\(\) => \{[\s\S]*refreshDashboard\(\{ startupSnapshot: true \}\)/)
  assert.match(appSource, /localState,\s*pinnedDomains/)
  assert.match(appSource, /localStateLoaded,\s*localState,/)
  assert.match(localStateSource, /initialState/)
  assert.doesNotMatch(localStateSource, /if \(state\.loaded\) return/)
  assert.match(localStateSource, /const localMutationVersionRef = useRef\(0\)/)
  assert.match(localStateSource, /const mutationVersion = localMutationVersionRef\.current/)
  assert.match(localStateSource, /if \(cancelled \|\| mutationVersion !== localMutationVersionRef\.current\) return/)
  assert.match(localStateSource, /if \(!ok && currentState\.loaded\) return/)
  assert.match(localStateSource, /if \(ok\) \{[\s\S]*domainPinWriter\.replacePersisted/)
  assert.match(refreshSource, /localState\?: DashboardLocalState \| null/)
  assert.match(refreshSource, /export function createLatestRefreshRunner/)
  assert.match(refreshSource, /if \(requestRevision !== revision\) continue/)
  assert.match(refreshSource, /useState\(\(\) => createLatestRefreshRunner/)
  assert.match(refreshSource, /startupRefreshPendingRef/)
  assert.match(refreshSource, /await refreshRunner\.request/)
  assert.match(refreshSource, /animatedRefreshPendingRef/)
  assert.match(refreshSource, /buildTabsDashboardStartupSnapshot\(/)
  assert.match(viewModelSource, /useLayoutEffect\(\(\) => \{[\s\S]*previousOrderRef\.current\[source\]/)
  // The cache layer + snapshot builder live in the non-React startup-snapshot module (shared with
  // the service worker): any valid session snapshot paints, with a durable chrome.storage.local fallback.
  assert.match(startupSnapshotSource, /export type CachedDashboardStartup =/)
  assert.match(startupSnapshotSource, /const liveLocalState = includeLocalStateKeys/)
  assert.match(startupSnapshotSource, /applyPinnedDomainsToCachedDashboard/)
  assert.match(startupSnapshotSource, /DASHBOARD_STARTUP_DURABLE_CACHE_TTL_MS/)
  assert.match(startupSnapshotSource, /export async function buildTabsDashboardStartupSnapshot/)
  assert.match(startupOrderDebugSource, /timings: StartupTiming\[\]/)
  assert.match(startupOrderDebugSource, /export function recordStartupTiming/)
  assert.match(startupOrderDebugSource, /durationMs/)
  assert.match(startupOrderDebugSource, /import\('\.\/startup-order-debug-heavy'\)/)
  assert.match(startupOrderDebugHeavySource, /STARTUP_ORDER_DEBUG_DURATION_MS = 3000/)
  assert.match(startupOrderDebugHeavySource, /debugWindow\.__tabOutSaveStartupOrderDebug\?\.\(\)/)
  assert.match(startupOrderDebugHeavySource, /function debugHistoryRows/)
  assert.match(startupOrderDebugHeavySource, /historyRows: debugHistoryRows\(\)/)
  assert.match(appSource, /freezeTabsChipOrder: dashboardContentVisible && !!effectiveStartupPriorityWorkingSet/)
  assert.match(viewModelSource, /freezeTabsChipOrder && source === 'tabs'/)
})

test('service worker maintains the startup snapshot on browser startup and tab events', () => {
  const backgroundSource = readFileSync(new URL('../src/extension/background.ts', import.meta.url), 'utf8')
  const serviceSource = readFileSync(new URL('../src/extension/background/startup-snapshot-service.ts', import.meta.url), 'utf8')
  const appEntrySource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8')

  assert.match(backgroundSource, /createStartupSnapshotService\(/)
  assert.match(backgroundSource, /onStartup\.addListener/)
  assert.match(backgroundSource, /startupSnapshotService\.refreshNow\(\)/)
  assert.match(backgroundSource, /startupSnapshotService\.scheduleRefresh\(\)/)
  assert.match(backgroundSource, /onMoved\.addListener\(scheduleStartupSnapshotRefresh\)/)
  assert.match(backgroundSource, /changeInfo\.favIconUrl !== undefined/)
  assert.match(backgroundSource, /changeInfo\.status !== undefined/)
  assert.match(backgroundSource, /chromeApi\.tabGroups\.onUpdated/)
  assert.match(serviceSource, /buildTabsDashboardStartupSnapshot/)
  assert.match(serviceSource, /saveCachedDashboardStartupSnapshot/)
  assert.match(serviceSource, /loadCachedDashboardStartupResult/)
  assert.match(serviceSource, /seedOpenTabsTitleHistory\(/)
  assert.match(appEntrySource, /seedOpenTabsTitleHistory\(cachedStartup\?\.snapshot\.dashboard\.realTabs \?\? \[\]\)/)
  assert.match(appEntrySource, /changeInfo\.status !== undefined/)
})

test('recently closed rows do not fetch independently before initial dashboard readiness', () => {
  const source = readFileSync(new URL('../src/components/App.tsx', import.meta.url), 'utf8')
  const closedTabsEffect = source.match(/useEffect\(\(\) => \{\n\s*return subscribeClosedTabChanges[\s\S]*?\n\s*\}, \[refreshClosedTabs\]\)/)

  assert.ok(closedTabsEffect)
  assert.doesNotMatch(source, /useEffect\(\(\) => \{\n\s*void refreshClosedTabs\(\)\n\s*return subscribeClosedTabChanges/)
})

test('source switch indicator keeps transform-based transition', () => {
  const source = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')

  assert.match(source, /\[transform:translateX\(var\(--active-tab-left\)\)_translateY\(-50%\)\]/)
  assert.match(source, /transition-\[width,transform\] duration-200 ease-swift/)
  assert.doesNotMatch(source, /source-switch-indicator[^"]*-translate-y-1\/2/)
})

test('header controls share one size and corner radius contract', () => {
  const baseCss = readFileSync(new URL('../extension/base.css', import.meta.url), 'utf8')
  const headerBarSource = readFileSync(new URL('../src/components/HeaderBar.tsx', import.meta.url), 'utf8')
  const historyRangeSelectSource = readFileSync(new URL('../src/components/HistoryRangeSelect.tsx', import.meta.url), 'utf8')
  const headerStatsSource = readFileSync(new URL('../src/components/HeaderStats.tsx', import.meta.url), 'utf8')
  const selectSource = readFileSync(new URL('../src/components/ui/select.tsx', import.meta.url), 'utf8')
  const tabFilterWrapClass = headerBarSource.match(/"tab-filter-wrap [^"]+"/)?.[0]
  const tabFilterClass = headerBarSource.match(/'tab-filter [^']+'/)?.[0]

  assert.ok(tabFilterWrapClass)
  assert.ok(tabFilterClass)
  assert.match(baseCss, /--header-control-height: 34px/)
  assert.match(baseCss, /--header-control-radius: 16px/)
  assert.match(baseCss, /--header-control-font-size: 13px/)
  assert.match(baseCss, /--header-control-line-height: 16px/)
  assert.match(headerBarSource, /source-switch-root[^"]*h-\(--header-control-height\)[^"]*rounded-\(--header-control-radius\)/)
  assert.match(headerBarSource, /source-switch-option[^"]*text-\(length:--header-control-font-size\)[^"]*leading-\(--header-control-line-height\)/)
  assert.match(headerBarSource, /source-switch-option[^"]*before:rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\]/)
  assert.match(headerBarSource, /source-switch-indicator[^"]*rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\]/)
  assert.match(historyRangeSelectSource, /<SelectTrigger[\s\S]*?className="[^"]*h-\(--header-control-height\)[^"]*rounded-\(--header-control-radius\)[^"]*bg-tab-card[^"]*text-\(length:--header-control-font-size\)[^"]*leading-\(--header-control-line-height\)/)
  assert.doesNotMatch(historyRangeSelectSource, /<SelectTrigger\s+className="[^"]*bg-\[rgba\(115,115,115,0\.06\)\]/)
  assert.match(historyRangeSelectSource, /<SelectContent[\s\S]*align="start"[\s\S]*className="[^"]*rounded-\(--header-control-radius\)/)
  assert.doesNotMatch(historyRangeSelectSource, /alignItemWithTrigger=\{false\}/)
  assert.match(historyRangeSelectSource, /<SelectItem[\s\S]*className="[^"]*rounded-\[calc\(var\(--header-control-radius\)_-_6px\)\][^"]*text-\(length:--header-control-font-size\)[^"]*leading-\(--header-control-line-height\)/)
  assert.doesNotMatch(historyRangeSelectSource, /aria-selected:bg-accent|aria-selected:text-accent-foreground/)
  for (const token of ['isolate', 'before:z-0', 'before:border-input', 'before:drop-shadow-xs', 'before:[corner-shape:squircle]', 'after:z-0', 'after:border-blue-500', 'after:opacity-0', 'after:drop-shadow-md', 'after:drop-shadow-blue-500/50', 'after:transition-opacity', 'after:duration-150', 'after:[corner-shape:squircle]', '[&:has(input:focus-visible)::after]:opacity-100']) {
    assert.ok(tabFilterWrapClass.includes(token), token)
  }
  assert.doesNotMatch(tabFilterWrapClass, /transition-\[filter|focus-visible\)::before/)
  assert.doesNotMatch(headerBarSource, /filterFocusHandoffPending|filterFocusRequest|autoFocus=/)
  assert.doesNotMatch(tabFilterWrapClass, /ring-/)
  assert.ok(!tabFilterWrapClass.includes(']:shadow-['))
  for (const token of ['relative', 'z-1', 'h-(--header-control-height)', 'rounded-(--header-control-radius)', 'text-(length:--header-control-font-size)', 'leading-(--header-control-line-height)', 'caret-blue-500', 'shadow-none', '[corner-shape:squircle]']) {
    assert.ok(tabFilterClass.includes(token), token)
  }
  assert.doesNotMatch(tabFilterClass, /drop-shadow/)
  assert.doesNotMatch(tabFilterClass, /focus-visible:(?:border|ring)/)
  assert.match(headerBarSource, /border border-transparent bg-transparent/)
  assert.match(headerBarSource, /data-tabout-part="clear-button"[\s\S]*?onPointerDown=\{\(event\) => event\.preventDefault\(\)\}[\s\S]*?onClick=\{onClear\}/)
  assert.doesNotMatch(tabFilterClass, /md:!text|md:!leading/)
  assert.doesNotMatch(tabFilterClass, /rounded-\[12px\]/)
  assert.match(headerStatsSource, /action-btn[^"]*h-\(--header-control-height\)[^"]*rounded-\(--header-control-radius\)/)
  assert.doesNotMatch(headerBarSource, /<SelectTrigger\s+size="header"|<SelectContent\s+size="header"/)
  assert.doesNotMatch(selectSource, /data-\[size=header\]|in-data-\[size=header\]|SelectPrimitive\.Popup[\s\S]*data-size=\{size\}|SelectPrimitive\.List[\s\S]*data-size=\{size\}/)
  assert.doesNotMatch(headerBarSource, /source-switch-root[^"]*rounded-\[16px\]|source-switch-(?:option|indicator)[^"]*_-_[457]px/)
  assert.doesNotMatch(headerStatsSource, /action-btn[^"]*rounded-\[10px\]/)
})

test('masonry resize observer rebinds after conditional mission grids mount', () => {
  const source = readFileSync(new URL('../src/extension/layout.ts', import.meta.url), 'utf8')

  assert.match(source, /useLayoutEffect\(\(\) => \{/)
  assert.match(source, /observer\.observe\(container\)/)
  assert.match(source, /if \(!targetsChanged\) return/)
  assert.doesNotMatch(source, /\},\s*containerRefs\.map\(\(ref\) => ref\.current\)\s*\)/)
})

test('masonry batches card height reads before position writes', () => {
  const source = readFileSync(new URL('../src/extension/layout.ts', import.meta.url), 'utf8')
  const heightRead = source.indexOf('const cardHeights = cards.map')
  const positionWrite = source.indexOf("card.style.left =")

  assert.ok(heightRead > 0)
  assert.ok(positionWrite > heightRead)
  assert.doesNotMatch(source.slice(positionWrite), /getBoundingClientRect\(\)\.height/)
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
  const mainHistoryBranch = appSource.match(/\?\s*'col-2([^']*)'/)
  const mainPlainBranch = appSource.match(/:\s*'col-1([^']*)'/)

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
  assert.match(mainPlainBranch[1], /px-\(--dashboard-page-gutter\)/)
  assert.match(mainHistoryBranch[1], /\bpl-0\b/)
  assert.match(mainHistoryBranch[1], /pr-\(--dashboard-page-gutter\)/)

  // has-history shell is a two-column grid sized off the history edge gutter.
  assert.match(
    shellHistoryBranch[1],
    /grid-cols-\[minmax\(calc\(220px_\+_var\(--dashboard-history-edge-gutter\)\),calc\(260px_\+_var\(--dashboard-history-edge-gutter\)\)\)_minmax\(0,1fr\)\]/
  )

  // The history panel keeps its own edge gutter, never the page gutter.
  assert.doesNotMatch(tabHistoryPanelSource, /pl-\(--dashboard-page-gutter\)/)
  assert.match(tabHistoryPanelSource, /className="[^"]*tab-history-panel[^"]*pl-\(--dashboard-history-edge-gutter\)/)
})
