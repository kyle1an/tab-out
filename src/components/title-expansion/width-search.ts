/* ================================================================
   Expanded-width search — the shared sizing half of the Title
   Expansion engine. Given a fit predicate (does this width hold the
   captured lines at the target line count?), find the narrowest
   width that fits between the resting lower bound and the viewport
   ceiling. What "fits" means stays with each surface: chips also
   police marker wrap heights, history rows tolerate 1px instead of
   1.5px — the predicate carries all of that.
   ================================================================ */

export type ExpandedWidthSearchOptions = {
  /** Resting-width floor: if content fits here, never widen. */
  lowerBound: number
  /** Viewport ceiling: failing here reports viewportConstrained. */
  maxContentWidth: number
  /** Binary-search probe count between the two bounds. */
  steps: number
  /** Post-search pad (chips compensate sub-pixel measure-clone drift). */
  guardPx?: number
  fits: (width: number) => boolean
}

export type ExpandedWidthSearchResult = {
  viewportConstrained: boolean
  width: number
}

function roundWidth(width: number): number {
  return Math.round(width * 100) / 100
}

export function searchExpandedWidth({ lowerBound, maxContentWidth, steps, guardPx = 0, fits }: ExpandedWidthSearchOptions): ExpandedWidthSearchResult {
  if (fits(lowerBound)) {
    return { viewportConstrained: false, width: roundWidth(lowerBound) }
  }
  if (!fits(maxContentWidth)) {
    return { viewportConstrained: true, width: roundWidth(maxContentWidth) }
  }

  let low = lowerBound
  let high = maxContentWidth
  for (let index = 0; index < steps; index += 1) {
    const mid = (low + high) / 2
    if (fits(mid)) high = mid
    else low = mid
  }

  return { viewportConstrained: false, width: roundWidth(Math.min(high + guardPx, maxContentWidth)) }
}
