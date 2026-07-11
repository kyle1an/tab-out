/* ================================================================
   Title Expansion — the module interface.

   Adapting surfaces (Page Chips, Activation History rows) and other
   consumers import from here only; files inside this directory are
   implementation. The interface grows in sanctioned slices:
   • controller + lane — the headless open/close half
   • (upcoming) width search, measurement, and the clamp/fade slice
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
