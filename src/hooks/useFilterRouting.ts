import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FOCUS_FILTER_PARAM, filterInputFromSearch, titleForFilterInput, urlForFilterInput } from '../extension/app-url.js'
import { readFilterFocusPendingInput, releaseFilterFocusBootValue } from '../extension/filter-focus-buffer.js'

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

function clearFocusFilterParam() {
  const params = new URLSearchParams(window.location.search)
  if (!params.has(FOCUS_FILTER_PARAM)) return

  params.delete(FOCUS_FILTER_PARAM)
  const nextSearch = params.toString()
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
  window.history.replaceState(null, '', nextUrl)
}

export function useFilterRouting({ onBeforeFilterCommit }: UseFilterRoutingOptions = {}) {
  const [filterInput, setFilterInput] = useState('')
  const [filter, setFilter] = useState('')
  const onBeforeFilterCommitRef = useRef(onBeforeFilterCommit)

  useEffect(() => {
    onBeforeFilterCommitRef.current = onBeforeFilterCommit
  }, [onBeforeFilterCommit])

  useLayoutEffect(() => {
    const next = initialFilterInput()
    setFilterInput(next)
    setFilter(next)
    clearFocusFilterParam()
    queueMicrotask(releaseFilterFocusBootValue)
  }, [])

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

  function commitFilterInput() {
    if (filterInput === filter) return
    onBeforeFilterCommitRef.current?.()
    setFilter(filterInput)
  }

  return { filterInput, filter, commitFilterInput, setFilterInput }
}
