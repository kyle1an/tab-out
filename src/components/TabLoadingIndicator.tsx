import { LoaderCircle } from 'lucide-react'

// Chrome's default light tab throbber resolves to its Primary 40 token.
// Tab Out currently renders on a light surface, so keep both loading
// surfaces on that exact color instead of inheriting the dashboard ink.
const CHROME_TAB_LOADING_COLOR = '#0b57d0'

export function TabLoadingIndicator() {
  return (
    <LoaderCircle
      data-tabout-part="loading-indicator"
      className="size-4 animate-spin motion-reduce:animate-none"
      style={{ color: CHROME_TAB_LOADING_COLOR }}
      strokeWidth={2}
      aria-hidden="true"
    />
  )
}
