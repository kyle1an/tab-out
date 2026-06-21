export const DEFAULT_HISTORY_RANGE = '1d'
export const HISTORY_FILTER_OFF = 'off'
export const HISTORY_RANGE_OPTIONS = [
  { value: HISTORY_FILTER_OFF, label: 'History off', days: 0 },
  { value: '1d', label: 'Last day', days: 1 },
  { value: '7d', label: 'Last week', days: 7 },
  { value: '30d', label: 'Last month', days: 30 },
  { value: '90d', label: 'Last 3 months', days: 90 }
]

export function isHistoryFilterEnabled(range = DEFAULT_HISTORY_RANGE): boolean {
  return range !== HISTORY_FILTER_OFF
}
