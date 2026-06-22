type FilterFocusBootWindow = Window & { __tabOutFilterFocusBootValue?: string }

function bootValue(): string | null {
  if (typeof window === 'undefined') return null
  const value = (window as FilterFocusBootWindow).__tabOutFilterFocusBootValue
  return typeof value === 'string' ? value : null
}

export function readFilterFocusPendingInput(fallback = ''): string {
  return bootValue() ?? fallback
}

export function releaseFilterFocusBootValue(): void {
  if (typeof window !== 'undefined') delete (window as FilterFocusBootWindow).__tabOutFilterFocusBootValue
}
