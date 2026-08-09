export const DEFAULT_HISTORY_RANGE = '1d'
export const HISTORY_FILTER_OFF = 'off'
export const HISTORY_RANGE_OPTIONS = [
  { value: HISTORY_FILTER_OFF, label: 'History off', days: 0 },
  { value: '1d', label: 'Last day', days: 1 },
  { value: '7d', label: 'Last week', days: 7 },
  { value: '30d', label: 'Last month', days: 30 },
  { value: '90d', label: 'Last 3 months', days: 90 },
  { value: '180d', label: 'Last 6 months', days: 180 },
  { value: '365d', label: 'Last year', days: 365 },
  { value: 'all', label: 'All time', days: null },
]

export function isHistoryRangeValue(value: unknown): value is string {
  return typeof value === 'string' && HISTORY_RANGE_OPTIONS.some((option) => option.value === value)
}

export function isHistoryFilterEnabled(range = DEFAULT_HISTORY_RANGE): boolean {
  return range !== HISTORY_FILTER_OFF
}
