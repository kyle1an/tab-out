/* ================================================================
   Title Expansion — the module interface.

   Adapting surfaces (Page Chips, Activation History rows) and other
   consumers import from here only; files inside this directory are
   implementation. The interface has sanctioned slices:
   • controller + lane — the headless open/close half
   • width search + measure element — the sizing half
   • clamp/fade — resting truncated titles (Working Set rows use
     only this slice)
   • capture primitives — the sanctioned interface for the
     per-surface capture engines; measurement POLICY stays with each
     surface (docs/adr/0002 — a shared measurer was tried and
     rejected: its config would be as wide as the code it hides)
   ================================================================ */

export { createTitleExpansionController, createTitleExpansionLane } from './controller'
export type {
  TitleExpansionController,
  TitleExpansionControllerOptions,
  TitleExpansionLane,
  TitleExpansionScheduler
} from './controller'
export { useTitleExpansionController } from './use-title-expansion'
export type { UseTitleExpansionControllerOptions } from './use-title-expansion'
export { searchExpandedWidth } from './width-search'
export type { ExpandedWidthSearchOptions, ExpandedWidthSearchResult } from './width-search'
export { createExpansionMeasureElement } from './measure-dom'
export type { ExpansionMeasureElementOptions } from './measure-dom'
export {
  captureVisibleLineHtml,
  clampedTitleLineNodes,
  expandedLineContentOverflows,
  expansionLineHtmlEquals,
  expansionLineMarkup,
  expansionLineNodesFromHtml,
  fragmentHtml,
  paintedRangeRect,
  syncTruncatedTitleFadeEnd,
  truncatedTitleFadeEndPx,
  unwrapClampedTitleLines
} from './line-capture'
export type { ExpansionLineClasses, TitleFadeBox, TitleLineFragmentRect } from './line-capture'
