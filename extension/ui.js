/* ================================================================
   ui.js is now a thin re-export shim.

   • Close animations → CSS `.closing` class (see style.css).
   • Toast          → components/Toast.js (Preact-owned).
   • Empty state    → <Missions> component.

   The showToast re-export here keeps every existing import path
   (`import { showToast } from './ui.js'`) working unchanged.
   ================================================================ */

export { showToast } from './components/Toast.js'

