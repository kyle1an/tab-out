import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FOCUS_FILTER_PARAM, filterInputFromSearch, titleForFilterInput, urlForFilterInput } from '../extension/app-url.js'
import { readFilterFocusPendingInput, releaseFilterFocusBootValue } from '../extension/filter-focus-buffer.js'

export const FILTER_SEARCH_UPDATE_DELAY_MS = 200
const FILTER_URL_SYNC_DELAY_MS = 600

type UseFilterRoutingOptions = {
  onBeforeFilterChange?: () => void
}

function filterInputFromCurrentUrl() {
  return filterInputFromSearch(window.location.search)
}

function initialFilterInput() {
  return readFilterFocusPendingInput(filterInputFromCurrentUrl())
}

function syncFilterInputToUrl(filterInput: string) {
  const nextUrl = urlForFilterInput(filterInput, window.location)
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
  if (nextUrl !== currentUrl) window.history.replaceState(null, '', nextUrl)
}

function clearFocusFilterParam() {
  const params = new URLSearchParams(window.location.search)
  if (!params.has(FOCUS_FILTER_PARAM)) return

  params.delete(FOCUS_FILTER_PARAM)
  const nextSearch = params.toString()
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
  window.history.replaceState(null, '', nextUrl)
}

export function useFilterRouting({ onBeforeFilterChange }: UseFilterRoutingOptions = {}) {
  const [filterInput, setFilterInputState] = useState('')
  const [filterSearch, setFilterSearch] = useState('')
  const filterInputRef = useRef('')
  const onBeforeFilterChangeRef = useRef(onBeforeFilterChange)
  // Local tab results and bookmark hydration follow the controlled input.
  // Only the larger browser-owned History search retains a coalescing window.
  const filter = filterInput

  useEffect(() => {
    onBeforeFilterChangeRef.current = onBeforeFilterChange
  }, [onBeforeFilterChange])

  useLayoutEffect(() => {
    const next = initialFilterInput()
    filterInputRef.current = next
    setFilterInputState(next)
    setFilterSearch(next)
    clearFocusFilterParam()
    queueMicrotask(releaseFilterFocusBootValue)
  }, [])

  useEffect(() => {
    if (filterInput === filterSearch) return
    if (filterInput === '') {
      setFilterSearch('')
      return
    }

    const timer = window.setTimeout(() => {
      setFilterSearch(filterInput)
    }, FILTER_SEARCH_UPDATE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [filterInput, filterSearch])

  useEffect(() => {
    document.title = titleForFilterInput(filterInput)
  }, [filterInput])

  useEffect(() => {
    if (filterInput === '') {
      syncFilterInputToUrl('')
      return
    }

    const timer = window.setTimeout(() => syncFilterInputToUrl(filterInput), FILTER_URL_SYNC_DELAY_MS)
    return () => clearTimeout(timer)
  }, [filterInput])

  const setFilterInput = useCallback(function setFilterInput(next: string) {
    if (next === filterInputRef.current) return
    onBeforeFilterChangeRef.current?.()
    filterInputRef.current = next
    setFilterInputState(next)
  }, [])

  return { filterInput, filter, filterSearch, setFilterInput }
}
