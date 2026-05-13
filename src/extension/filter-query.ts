import type { DashboardTab } from './types'

export type FilterQueryTerm = {
  kind: 'token' | 'phrase'
  value: string
}

export type FilterQuery = {
  raw: string
  terms: FilterQueryTerm[]
}

export type DashboardItemSearchableParts = {
  title: string
  url: string
}

const TOKEN_MATCH_ALIASES: Record<string, string[]> = {
  pr: ['pull request']
}

function pushTerm(terms: FilterQueryTerm[], kind: FilterQueryTerm['kind'], value: string) {
  const text = value.trim().toLowerCase()
  if (!text) return
  terms.push({ kind, value: text })
}

export function parseFilterQuery(input = ''): FilterQuery {
  const terms: FilterQueryTerm[] = []
  let index = 0

  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index])) index += 1
    if (index >= input.length) break

    if (input[index] === '"') {
      index += 1
      const start = index
      while (index < input.length && input[index] !== '"') index += 1
      pushTerm(terms, 'phrase', input.slice(start, index))
      if (input[index] === '"') index += 1
      continue
    }

    const start = index
    while (index < input.length && !/\s/.test(input[index])) index += 1
    pushTerm(terms, 'token', input.slice(start, index))
  }

  return {
    raw: input,
    terms
  }
}

export function matchValuesForFilterTerm(term: FilterQueryTerm): string[] {
  if (term.kind !== 'token') return [term.value]
  return [term.value, ...(TOKEN_MATCH_ALIASES[term.value] || [])]
}

export function searchablePartsForDashboardItem(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>): DashboardItemSearchableParts {
  const rawTitle = tab.title || ''
  const title = tab.isTabOut ? rawTitle.replace(/^.+ - Tab Out$/i, 'Tab Out') : rawTitle
  let url = tab.url || ''

  if (tab.isTabOut) {
    try {
      const parsed = new URL(url)
      parsed.search = ''
      url = parsed.toString()
    } catch {}
  }

  return { title, url }
}

export function searchableTextForDashboardItem(tab: Pick<DashboardTab, 'title' | 'url' | 'isTabOut'>): string {
  const { title, url } = searchablePartsForDashboardItem(tab)
  return `${title}\n${url}`.toLowerCase()
}
