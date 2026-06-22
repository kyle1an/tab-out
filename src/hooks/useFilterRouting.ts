import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FOCUS_FILTER_PARAM, filterInputFromSearch, titleForFilterInput, urlForFilterInput } from '../extension/app-url.js'
import { readFilterFocusPendingInput } from '../extension/filter-focus-buffer.js'

const FILTER_UPDATE_DELAY_MS = 200
const FILTER_URL_SYNC_DELAY_MS = 600

type UseFilterRoutingOptions = {
  onBeforeFilterCommit?: () => void
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

function shouldFocusFilterFromUrl() {
  return new URLSearchParams(window.location.search).get(FOCUS_FILTER_PARAM) === '1'
}

function clearFocusFilterParam() {
  const params = new URLSearchParams(window.location.search)
  if (!params.has(FOCUS_FILTER_PARAM)) return

  params.delete(FOCUS_FILTER_PARAM)
  const nextSearch = params.toString()
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
  window.history.replaceState(null, '', nextUrl)
}

export function useFilterRouting({ onBeforeFilterCommit }: UseFilterRoutingOptions = {}) {
  const [filterInput, setFilterInput] = useState(initialFilterInput)
  const [filter, setFilter] = useState(initialFilterInput)
  const [filterFocusRequest] = useState(() => (shouldFocusFilterFromUrl() ? 1 : 0))
  const onBeforeFilterCommitRef = useRef(onBeforeFilterCommit)

  useEffect(() => {
    onBeforeFilterCommitRef.current = onBeforeFilterCommit
  }, [onBeforeFilterCommit])

  useEffect(() => {
    clearFocusFilterParam()
  }, [])

  useLayoutEffect(() => {
    if (filterFocusRequest <= 0) return
    const next = initialFilterInput()
    setFilterInput(next)
    setFilter(next)
  }, [filterFocusRequest])

  useEffect(() => {
    if (filterInput === filter) return
    if (filterInput === '') {
      onBeforeFilterCommitRef.current?.()
      setFilter('')
      return
    }

    const timer = window.setTimeout(() => {
      onBeforeFilterCommitRef.current?.()
      setFilter(filterInput)
    }, FILTER_UPDATE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [filterInput, filter])

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

  return { filterInput, filter, filterFocusRequest, setFilterInput }
}
