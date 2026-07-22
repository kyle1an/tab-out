import { useEffect, useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import { HeaderStats } from './HeaderStats'
import { Tabs, TabsList, TabsTrigger } from './ui/tabs'
import { TooltipAnchor } from './ui/tooltip'
import { isHistoryFilterEnabled } from '../extension/history-range.js'
import { isFilterFocusShortcut } from '../extension/app-url.js'
import { releaseFilterFocusBootValue } from '../extension/filter-focus-buffer.js'
import {
  EMPTY_FILTER_RESULT_SELECTION,
  filterResultKeyboardIntent,
  reconcileFilterResultSelection,
  reconcileVisibleFilterResultSelection,
  selectAdjacentFilterResult,
  selectHorizontalFilterResult,
  type FilterResultCandidate,
  type FilterResultMoveDirection,
  type FilterResultSelection
} from '../extension/filter-result-navigation.js'
import { cn } from '@/lib/utils'
import type { DashboardSource, DashboardStats } from './types'

interface SourceSwitchProps {
  source: DashboardSource
  onSourceChange: (source: DashboardSource) => void | Promise<void>
}

const SOURCE_SWITCH_OPTIONS = [
  { value: 'tabs', label: 'Tabs' },
  { value: 'bookmarks', label: 'Bookmarks' }
] as const

function isSourceSwitchValue(value: unknown): value is DashboardSource {
  return typeof value === 'string' && SOURCE_SWITCH_OPTIONS.some((option) => option.value === value)
}

interface HeaderBarProps {
  stats: DashboardStats
  filter: string
  committedFilter?: string
  filterResultCandidates?: readonly FilterResultCandidate[]
  filterResultSearchSettled?: boolean
  filterFocusRequest?: number
  historyRange: string
  onFilterChange: (filter: string) => void
  onFilterCommit?: () => void
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
  candidates: readonly FilterResultCandidate[]
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
  scroll: boolean
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
  modifiers: Extract<PendingFilterResultAction, { kind: 'activate' }>['modifiers']
) {
  const target = document.getElementById(candidate.domId)
  if (!(target instanceof HTMLElement)) return
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    view: window,
    ...modifiers
  }))
}

function moveFilterResultSelection(
  current: FilterResultSelection,
  query: string,
  candidates: readonly FilterResultCandidate[],
  direction: FilterResultMoveDirection
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
        bottom: rect.bottom
      }
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
            className="source-switch-option relative z-1 inline-flex h-8 flex-none box-border cursor-pointer select-none items-center justify-center whitespace-nowrap border-0 bg-transparent px-2 py-0 text-(length:--header-control-font-size) leading-(--header-control-line-height) font-normal text-muted-foreground outline-none [font-family:inherit] [transition:color_0.15s_ease] after:hidden before:pointer-events-none before:absolute before:inset-x-0 before:inset-y-1 before:rounded-[calc(var(--header-control-radius)_-_6px)] before:outline-2 before:-outline-offset-1 before:outline-transparent before:[corner-shape:squircle] before:content-[''] hover:text-foreground focus-visible:ring-0 focus-visible:outline-none focus-visible:before:outline-(--accent-amber) data-[active]:bg-transparent data-[active]:text-foreground data-[active]:shadow-none dark:data-[active]:border-transparent dark:data-[active]:bg-transparent"
            value={option.value}
          >
            {option.label}
          </TabsTrigger>
        ))}
        {/* Animates width (not scaleX): scaling would distort the squircle corners mid-slide. */}
        <TabsPrimitive.Indicator className="source-switch-indicator absolute top-1/2 left-0 z-0 h-6 w-(--active-tab-width) rounded-[calc(var(--header-control-radius)_-_6px)] bg-[rgba(115,115,115,0.12)] [corner-shape:squircle] [transform:translateX(var(--active-tab-left))_translateY(-50%)] transition-[width,transform] duration-200 ease-swift" />
      </TabsList>
    </Tabs>
  )
}

export function HeaderBar({
  filter,
  committedFilter = filter,
  filterResultCandidates = EMPTY_FILTER_RESULT_CANDIDATES,
  filterResultSearchSettled = true,
  filterFocusRequest = 0,
  historyRange,
  onFilterChange,
  onFilterCommit,
  onCloseFiltered,
  onDedupAll,
  onSourceChange,
  source = 'tabs',
  sourceSelection = source,
  ready = true,
  stats
}: HeaderBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pendingFilterResultActionRef = useRef<PendingFilterResultAction | null>(null)
  const selectedFilterResultElementRef = useRef<HTMLElement | null>(null)
  const filterResultSelectionRef = useRef(EMPTY_FILTER_RESULT_SELECTION)
  const filterResultSourceRef = useRef({ source, sourceSelection })
  const filterResultNavigationEnabled = source === sourceSelection
  const committedCandidates = filterResultNavigationEnabled && filter === committedFilter
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
      false
    )
  }, [source, sourceSelection])

  useLayoutEffect(() => {
    const pendingAction = pendingFilterResultActionRef.current
    const pendingActionMatches = pendingAction?.query === committedFilter &&
      pendingAction.source === source &&
      filterResultNavigationEnabled &&
      filter === committedFilter
    const mountedCandidates = pendingActionMatches && pendingAction.kind === 'move'
      ? mountedFilterResultCandidates(committedCandidates)
      : null
    let nextSelection: FilterResultSelection
    let nextCandidate: FilterResultCandidate | undefined
    if (mountedCandidates) {
      nextSelection = reconcileFilterResultSelection(
        filterResultSelectionRef.current,
        filter,
        mountedCandidates
      )
      nextCandidate = filterResultCandidateForSelection(nextSelection, mountedCandidates)
    } else {
      const reconciledResult = reconcileVisibleFilterResultSelection(
        filterResultSelectionRef.current,
        filter,
        committedCandidates,
        isMountedFilterResultCandidate
      )
      nextSelection = reconciledResult.selection
      nextCandidate = reconciledResult.candidate
    }
    let pendingActivation: Extract<PendingFilterResultAction, { kind: 'activate' }> | null = null
    let scrollSelection = false

    if (
      pendingActionMatches &&
      (nextCandidate || filterResultSearchSettled)
    ) {
      pendingFilterResultActionRef.current = null
      if (pendingAction.kind === 'move') {
        nextSelection = moveFilterResultSelection(
          nextSelection,
          committedFilter,
          mountedCandidates ?? EMPTY_FILTER_RESULT_CANDIDATES,
          pendingAction.direction
        )
        nextCandidate = filterResultCandidateForSelection(
          nextSelection,
          mountedCandidates ?? EMPTY_FILTER_RESULT_CANDIDATES
        )
        scrollSelection = true
      } else {
        pendingActivation = pendingAction
      }
    }

    selectedFilterResultElementRef.current = applyFilterResultSelection(
      nextSelection,
      mountedCandidates ?? committedCandidates,
      inputRef.current,
      selectedFilterResultElementRef.current,
      scrollSelection
    )
    filterResultSelectionRef.current = nextSelection

    if (pendingActivation && nextCandidate) {
      dispatchFilterResultActivation(nextCandidate, pendingActivation.modifiers)
    }
  }, [
    committedCandidates,
    committedFilter,
    filter,
    filterResultNavigationEnabled,
    filterResultSearchSettled,
    source,
  ])

  useLayoutEffect(() => {
    if (filterFocusRequest <= 0) return
    inputRef.current?.focus()
    queueMicrotask(releaseFilterFocusBootValue)
  }, [filterFocusRequest])

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
      shiftKey: e.shiftKey
    })
    if (!intent || !filter.trim()) return
    if (!filterResultNavigationEnabled) return

    e.preventDefault()
    const action: PendingFilterResultAction = intent === 'activate'
      ? {
          kind: 'activate',
          modifiers: {
            altKey: e.altKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey
          },
          query: filter,
          source
        }
      : {
          kind: 'move',
          direction: intent,
          query: filter,
          source
        }

    if (filter !== committedFilter) {
      pendingFilterResultActionRef.current = action
      onFilterCommit?.()
      return
    }

    const mountedCandidates = mountedFilterResultCandidates(committedCandidates)
    const currentSelection = reconcileFilterResultSelection(
      filterResultSelectionRef.current,
      committedFilter,
      mountedCandidates
    )

    if (mountedCandidates.length === 0 && !filterResultSearchSettled) {
      pendingFilterResultActionRef.current = action
      return
    }

    if (action.kind === 'move') {
      const nextSelection = moveFilterResultSelection(
        currentSelection,
        committedFilter,
        mountedCandidates,
        action.direction
      )
      filterResultSelectionRef.current = nextSelection
      selectedFilterResultElementRef.current = applyFilterResultSelection(
        nextSelection,
        mountedCandidates,
        inputRef.current,
        selectedFilterResultElementRef.current,
        true
      )
      return
    }

    filterResultSelectionRef.current = currentSelection
    selectedFilterResultElementRef.current = applyFilterResultSelection(
      currentSelection,
      mountedCandidates,
      inputRef.current,
      selectedFilterResultElementRef.current,
      false
    )
    const selectedFilterResultCandidate = filterResultCandidateForSelection(
      currentSelection,
      mountedCandidates
    )
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
        <div className="header-left inline-flex items-center gap-2.5">
          <div
            data-tabout="filter-query"
            className={cn('tab-filter-wrap relative inline-flex items-center', filter && 'has-value [&_.tab-filter]:pr-[30px] [&_.tab-filter-clear]:inline-flex')}
          >
            <input
              ref={inputRef}
              type="search"
              data-slot="input"
              data-tabout-part="input"
              className={cn(
                'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
                'tab-filter box-border h-(--header-control-height) w-[280px] rounded-(--header-control-radius) border border-(--warm-gray) bg-[rgba(115,115,115,0.06)] px-3.5 py-0 text-(length:--header-control-font-size) leading-(--header-control-line-height) text-foreground outline-none [font-family:inherit] [transition:border-color_0.15s,background_0.15s,opacity_0.2s] [corner-shape:squircle] placeholder:select-none placeholder:text-muted-foreground focus:border-(--accent-amber) focus:bg-tab-card min-[900px]:max-[960px]:[.dashboard-shell.has-history_&]:w-[220px] [&::-webkit-search-cancel-button]:[-webkit-appearance:none]'
              )}
              autoComplete="off"
              autoFocus={filterFocusRequest > 0}
              spellCheck="false"
              aria-label={filterPlaceholder}
              placeholder={filterPlaceholder}
              value={filter}
              aria-controls={filter.trim() ? 'dashboardMissions' : undefined}
              onChange={(e) => updateFilter(e.currentTarget.value)}
              onKeyDown={onFilterKeyDown}
            />
            <TooltipAnchor content="Clear filter">
              <button
                type="button"
                data-tabout-part="clear-button"
                className="tab-filter-clear absolute top-1/2 right-1.5 hidden size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-muted-foreground transition-[background,color] duration-150 ease-[ease] hover:bg-[rgba(10,10,10,0.08)] hover:text-foreground [&_svg]:h-3 [&_svg]:w-3"
                aria-label="Clear filter"
                onClick={onClear}
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </TooltipAnchor>
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
