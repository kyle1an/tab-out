import { useEffect, useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { HeaderStats } from './HeaderStats'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { isHistoryFilterEnabled } from '../extension/history-range.js'
import { isFilterFocusShortcut } from '../extension/app-url.js'
import {
  EMPTY_FILTER_RESULT_SELECTION,
  filterResultKeyboardIntent,
  reconcileFilterResultSelection,
  reconcileVisibleFilterResultSelection,
  selectAdjacentFilterResult,
  selectHorizontalFilterResult,
  type FilterResultCandidate,
  type FilterResultMoveDirection,
  type FilterResultSelection,
} from '../extension/filter-result-navigation.js'
import { cn } from '@/lib/utils'
import type { DashboardSource, DashboardStats } from './types'

interface SourceSwitchProps {
  source: DashboardSource
  onSourceChange: (source: DashboardSource) => void | Promise<void>
}

const SOURCE_SWITCH_OPTIONS = [
  { value: 'tabs', label: 'Tabs' },
  { value: 'bookmarks', label: 'Bookmarks' },
] as const

function isSourceSwitchValue(value: unknown): value is DashboardSource {
  return typeof value === 'string' && SOURCE_SWITCH_OPTIONS.some((option) => option.value === value)
}

interface HeaderBarProps {
  stats: DashboardStats
  filter: string
  filterResultCandidates?: readonly FilterResultCandidate[]
  filterResultSearchSettled?: boolean
  historyRange: string
  onFilterChange: (filter: string) => void
  onCloseFiltered: () => void | Promise<void>
  onDedupAll: () => void | Promise<void>
  onSourceChange: (source: DashboardSource) => void | Promise<void>
  source?: DashboardSource
  sourceSelection?: DashboardSource
  ready?: boolean
}

const EMPTY_FILTER_RESULT_CANDIDATES: readonly FilterResultCandidate[] = []

type PendingFilterResultAction =
  | {
    kind: 'move'
    direction: FilterResultMoveDirection
    query: string
    source: DashboardSource
  }
  | {
    kind: 'activate'
    modifiers: {
      altKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
    }
    query: string
    source: DashboardSource
  }

function filterResultCandidateForSelection(
  selection: FilterResultSelection,
  candidates: readonly FilterResultCandidate[],
) {
  return candidates.find((candidate) => candidate.key === selection.candidateKey)
}

function mountedFilterResultCandidates(candidates: readonly FilterResultCandidate[]) {
  return candidates.filter(isMountedFilterResultCandidate)
}

function isMountedFilterResultCandidate(candidate: FilterResultCandidate) {
  const target = document.getElementById(candidate.domId)
  return target instanceof HTMLElement && target.getClientRects().length > 0
}

function applyFilterResultSelection(
  selection: FilterResultSelection,
  candidates: readonly FilterResultCandidate[],
  input: HTMLInputElement | null,
  previousElement: HTMLElement | null,
  scroll: boolean,
): HTMLElement | null {
  const candidate = filterResultCandidateForSelection(selection, candidates)
  const nextElement = candidate ? document.getElementById(candidate.domId) : null
  if (previousElement !== nextElement) {
    previousElement?.removeAttribute('data-tabout-filter-result-selected')
  }
  if (!candidate || !(nextElement instanceof HTMLElement)) {
    input?.removeAttribute('aria-activedescendant')
    return null
  }

  nextElement.setAttribute('data-tabout-filter-result-selected', 'true')
  input?.setAttribute('aria-activedescendant', candidate.domId)
  if (scroll) nextElement.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return nextElement
}

function dispatchFilterResultActivation(
  candidate: FilterResultCandidate,
  modifiers: Extract<PendingFilterResultAction, { kind: 'activate' }>['modifiers'],
) {
  const target = document.getElementById(candidate.domId)
  if (!(target instanceof HTMLElement)) return
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    view: window,
    ...modifiers,
  }))
}

function moveFilterResultSelection(
  current: FilterResultSelection,
  query: string,
  candidates: readonly FilterResultCandidate[],
  direction: FilterResultMoveDirection,
) {
  if (direction === 'next' || direction === 'previous') {
    return selectAdjacentFilterResult(current, query, candidates, direction)
  }

  const positionedCandidates = candidates.flatMap((candidate) => {
    const target = document.getElementById(candidate.domId)
    if (!(target instanceof HTMLElement) || target.getClientRects().length === 0) return []

    const rect = target.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return []
    return [{
      candidate,
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      },
    }]
  })

  return selectHorizontalFilterResult(current, query, positionedCandidates, direction)
}

function SourceSwitch({ source, onSourceChange }: SourceSwitchProps) {
  function handleSourceChange(nextValue: unknown) {
    if (!isSourceSwitchValue(nextValue)) return
    if (nextValue === source) return
    void onSourceChange(nextValue)
  }

  return (
    <Tabs
      data-tabout="source-switch"
      className="source-switch-root inline-flex box-border h-(--header-control-height) rounded-(--header-control-radius) border border-(--warm-gray) [corner-shape:squircle]"
      value={source}
      onValueChange={handleSourceChange}
    >
      <TabsList
        variant="line"
        className="source-switch relative z-0 flex h-full box-border items-center gap-1 rounded-none px-1 py-0"
        aria-label="Dashboard source"
      >
        {SOURCE_SWITCH_OPTIONS.map((option) => (
          <TabsTrigger
            key={option.value}
            data-tabout-part="source-option"
            className="source-switch-option relative z-1 inline-flex h-8 flex-none box-border cursor-pointer select-none items-center justify-center whitespace-nowrap border-0 bg-transparent px-2 py-0 text-(length:--header-control-font-size) leading-(--header-control-line-height) font-normal text-muted-foreground outline-none font-[inherit] [transition:color_0.15s_ease] after:hidden before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-1 before:rounded-[calc(var(--header-control-radius)-6px)] before:outline-2 before:-outline-offset-1 before:outline-transparent before:[corner-shape:squircle] before:content-[''] hover:text-foreground focus-visible:ring-0 focus-visible:outline-none focus-visible:before:outline-(--accent-amber) data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
            value={option.value}
          >
            {option.label}
          </TabsTrigger>
        ))}
        {/* Animates width (not scaleX): scaling would distort the squircle corners mid-slide. */}
        <TabsPrimitive.Indicator className="source-switch-indicator absolute top-1/2 left-0 z-0 h-6 w-(--active-tab-width) rounded-[calc(var(--header-control-radius)-6px)] bg-[rgba(115,115,115,0.12)] [corner-shape:squircle] transform-[translateX(var(--active-tab-left))_translateY(-50%)] transition-[width,transform] duration-200 ease-swift motion-reduce:transition-none" />
      </TabsList>
    </Tabs>
  )
}

export function HeaderBar({
  filter,
  filterResultCandidates = EMPTY_FILTER_RESULT_CANDIDATES,
  filterResultSearchSettled = true,
  historyRange,
  onFilterChange,
  onCloseFiltered,
  onDedupAll,
  onSourceChange,
  source = 'tabs',
  sourceSelection = source,
  ready = true,
  stats,
}: HeaderBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pendingFilterResultActionRef = useRef<PendingFilterResultAction | null>(null)
  const selectedFilterResultElementRef = useRef<HTMLElement | null>(null)
  const filterResultSelectionRef = useRef(EMPTY_FILTER_RESULT_SELECTION)
  const filterResultSourceRef = useRef({ source, sourceSelection })
  const filterResultNavigationEnabled = source === sourceSelection
  const availableCandidates = filterResultNavigationEnabled
    ? filterResultCandidates
    : EMPTY_FILTER_RESULT_CANDIDATES

  function updateFilter(nextValue: string) {
    pendingFilterResultActionRef.current = null
    onFilterChange(nextValue)
  }

  useLayoutEffect(() => {
    const previousSource = filterResultSourceRef.current
    filterResultSourceRef.current = { source, sourceSelection }
    if (
      previousSource.source === source &&
      previousSource.sourceSelection === sourceSelection
    ) return

    pendingFilterResultActionRef.current = null
    filterResultSelectionRef.current = EMPTY_FILTER_RESULT_SELECTION
    selectedFilterResultElementRef.current = applyFilterResultSelection(
      EMPTY_FILTER_RESULT_SELECTION,
      EMPTY_FILTER_RESULT_CANDIDATES,
      inputRef.current,
      selectedFilterResultElementRef.current,
      false,
    )
  }, [source, sourceSelection])

  useLayoutEffect(() => {
    const pendingAction = pendingFilterResultActionRef.current
    const pendingActionMatches = pendingAction?.query === filter &&
      pendingAction.source === source &&
      filterResultNavigationEnabled
    const mountedCandidates = pendingActionMatches && pendingAction.kind === 'move'
      ? mountedFilterResultCandidates(availableCandidates)
      : null
    let nextSelection: FilterResultSelection
    let nextCandidate: FilterResultCandidate | undefined
    if (mountedCandidates) {
      nextSelection = reconcileFilterResultSelection(
        filterResultSelectionRef.current,
        filter,
        mountedCandidates,
      )
      nextCandidate = filterResultCandidateForSelection(nextSelection, mountedCandidates)
    } else {
      const reconciledResult = reconcileVisibleFilterResultSelection(
        filterResultSelectionRef.current,
        filter,
        availableCandidates,
        isMountedFilterResultCandidate,
      )
      nextSelection = reconciledResult.selection
      nextCandidate = reconciledResult.candidate
    }

    if (pendingActionMatches && pendingAction.kind === 'activate' && !nextCandidate) {
      nextCandidate = availableCandidates.find(isMountedFilterResultCandidate)
    }
    let pendingActivation: Extract<PendingFilterResultAction, { kind: 'activate' }> | null = null
    let scrollSelection = false

    if (
      pendingActionMatches &&
      (
        nextCandidate ||
        (pendingAction.kind === 'move' && (mountedCandidates?.length ?? 0) > 0) ||
        filterResultSearchSettled
      )
    ) {
      pendingFilterResultActionRef.current = null
      if (pendingAction.kind === 'move') {
        nextSelection = moveFilterResultSelection(
          nextSelection,
          filter,
          mountedCandidates ?? EMPTY_FILTER_RESULT_CANDIDATES,
          pendingAction.direction,
        )
        nextCandidate = filterResultCandidateForSelection(
          nextSelection,
          mountedCandidates ?? EMPTY_FILTER_RESULT_CANDIDATES,
        )
        scrollSelection = true
      } else {
        pendingActivation = pendingAction
      }
    }

    selectedFilterResultElementRef.current = applyFilterResultSelection(
      nextSelection,
      mountedCandidates ?? availableCandidates,
      inputRef.current,
      selectedFilterResultElementRef.current,
      scrollSelection,
    )
    filterResultSelectionRef.current = nextSelection

    if (pendingActivation && nextCandidate) {
      dispatchFilterResultActivation(nextCandidate, pendingActivation.modifiers)
    }
  }, [
    availableCandidates,
    filter,
    filterResultNavigationEnabled,
    filterResultSearchSettled,
    source,
  ])

  useEffect(() => {
    function onWindowKeyDown(e: KeyboardEvent) {
      if (!isFilterFocusShortcut(e, navigator.platform)) return
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select?.()
    }

    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [])

  const filterPlaceholder = source === 'bookmarks' ? 'Filter bookmarks…' : isHistoryFilterEnabled(historyRange) ? 'Filter tabs, bookmarks, history…' : 'Filter tabs and bookmarks…'

  function onFilterKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    const intent = filterResultKeyboardIntent({
      key: e.key,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      isComposing: e.nativeEvent.isComposing,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    })
    if (!intent || !filter.trim()) return
    if (!filterResultNavigationEnabled) return

    const selectionIsInputOwned = filterResultSelectionRef.current.query !== filter ||
      filterResultSelectionRef.current.candidateKey === null
    if ((intent === 'left' || intent === 'right') && selectionIsInputOwned) return

    e.preventDefault()
    const action: PendingFilterResultAction = intent === 'activate'
      ? {
          kind: 'activate',
          modifiers: {
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
          },
          query: filter,
          source,
        }
      : {
          kind: 'move',
          direction: intent,
          query: filter,
          source,
        }

    const mountedCandidates = mountedFilterResultCandidates(availableCandidates)
    const currentSelection = reconcileFilterResultSelection(
      filterResultSelectionRef.current,
      filter,
      mountedCandidates,
    )

    if (mountedCandidates.length === 0 && !filterResultSearchSettled) {
      pendingFilterResultActionRef.current = action
      return
    }

    if (action.kind === 'move') {
      const nextSelection = moveFilterResultSelection(
        currentSelection,
        filter,
        mountedCandidates,
        action.direction,
      )
      filterResultSelectionRef.current = nextSelection
      selectedFilterResultElementRef.current = applyFilterResultSelection(
        nextSelection,
        mountedCandidates,
        inputRef.current,
        selectedFilterResultElementRef.current,
        true,
      )
      return
    }

    filterResultSelectionRef.current = currentSelection
    selectedFilterResultElementRef.current = applyFilterResultSelection(
      currentSelection,
      mountedCandidates,
      inputRef.current,
      selectedFilterResultElementRef.current,
      false,
    )
    const selectedFilterResultCandidate = filterResultCandidateForSelection(
      currentSelection,
      mountedCandidates,
    ) ?? mountedCandidates[0]
    if (selectedFilterResultCandidate) {
      dispatchFilterResultActivation(selectedFilterResultCandidate, action.modifiers)
    }
  }

  function onClear() {
    updateFilter('')
    inputRef.current?.focus()
  }

  return (
    <header className="flex flex-col">
      <div className="header-row flex items-center justify-between gap-4">
        <div className="header-left inline-flex items-center gap-4">
          <div
            data-tabout="filter-query"
            className={cn(
              "tab-filter-wrap relative isolate inline-flex items-center before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-(--header-control-radius) before:border before:border-input before:drop-shadow-xs before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:inset-0 after:z-0 after:rounded-(--header-control-radius) after:border after:border-blue-500 after:opacity-0 after:drop-shadow-md after:drop-shadow-blue-500/50 after:transition-opacity after:duration-150 after:ease-out after:[corner-shape:squircle] after:content-[''] motion-reduce:after:transition-none [&:has(input:focus-visible)::after]:opacity-100",
              filter && 'has-value [&_.tab-filter]:pr-7.5 [&_.tab-filter-clear]:inline-flex',
            )}
          >
            <input
              ref={inputRef}
              type="search"
              data-slot="input"
              data-tabout-part="input"
              className={cn(
                'h-8 w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
                'tab-filter relative z-1 box-border h-(--header-control-height) w-70 rounded-(--header-control-radius) border border-transparent bg-transparent px-3 py-1 text-(length:--header-control-font-size) leading-(--header-control-line-height) text-foreground caret-blue-500 shadow-none transition-colors outline-none font-[inherit] [corner-shape:squircle] placeholder:select-none placeholder:text-muted-foreground min-[900px]:max-[960px]:[.dashboard-shell.has-history_&]:w-55 md:text-sm [&::-webkit-search-cancel-button]:[-webkit-appearance:none]',
              )}
              autoComplete="off"
              spellCheck="false"
              aria-label={filterPlaceholder}
              placeholder={filterPlaceholder}
              value={filter}
              aria-controls={filter.trim() ? 'dashboardMissions' : undefined}
              onChange={(e) => updateFilter(e.currentTarget.value)}
              onKeyDown={onFilterKeyDown}
            />
            <button
              type="button"
              data-tabout-part="clear-button"
              className="tab-filter-clear absolute top-1/2 right-1.5 z-1 hidden size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-[background,color] duration-150 ease-[ease] hover:bg-[rgba(10,10,10,0.08)] hover:text-foreground [&_svg]:h-3 [&_svg]:w-3"
              aria-label="Clear filter"
              onPointerDown={(event) => event.preventDefault()}
              onClick={onClear}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <HeaderStats
            source={source}
            ready={ready}
            {...stats}
            onDedupAll={onDedupAll}
            onCloseFiltered={onCloseFiltered}
          />
        </div>
        <div className="header-controls inline-flex items-center gap-2.5">
          <SourceSwitch source={sourceSelection} onSourceChange={onSourceChange} />
        </div>
      </div>
    </header>
  )
}
