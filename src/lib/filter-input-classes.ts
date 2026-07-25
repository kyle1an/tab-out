// Class contract for the dashboard filter input. HeaderBar owns the element;
// the generated page prerenders that component and React attaches to it.

export const FILTER_INPUT_WRAP_CLASS =
  "relative isolate inline-flex items-center before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-(--header-control-radius) before:border before:border-input before:drop-shadow-xs before:[corner-shape:squircle] before:content-[''] after:pointer-events-none after:absolute after:inset-0 after:z-0 after:rounded-(--header-control-radius) after:border after:border-blue-500 after:opacity-0 after:drop-shadow-md after:drop-shadow-blue-500/50 after:transition-opacity after:duration-150 after:ease-out after:[corner-shape:squircle] after:content-[''] motion-reduce:after:transition-none [&:has(input:focus-visible)::after]:opacity-100"

export const FILTER_PLACEHOLDER_WITH_HISTORY = 'Filter tabs, bookmarks, history…'

export const FILTER_INPUT_CLASS =
  "relative z-1 box-border h-(--header-control-height) w-[280px] rounded-(--header-control-radius) border border-transparent bg-transparent px-3 py-1 text-(length:--header-control-font-size) leading-(--header-control-line-height) text-foreground caret-blue-500 shadow-none transition-colors outline-none [font-family:inherit] [corner-shape:squircle] placeholder:select-none placeholder:text-muted-foreground min-[900px]:max-[960px]:[.dashboard-shell.has-history_&]:w-[220px] md:text-sm [&::-webkit-search-cancel-button]:[-webkit-appearance:none]"
