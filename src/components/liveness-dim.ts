/* ================================================================
   Liveness dimming — shared class strings for the "not awake" look.

   Favicon strength encodes liveness across the dashboard: full color
   means an awake open tab is one click away; suspended and closed
   targets dim. Page chips and history rows share the same treatment
   so the signal reads identically everywhere. The dim is mostly
   opacity with a light desaturation — heavy desat on 16px icons
   destroys their color identity, which is most of what makes a
   favicon recognizable.

   Variant rows inside a title-variant group carry no favicon of
   their own, so their label text carries the liveness signal
   instead. A fixed neutral-500 color keeps suspended labels
   distinct even when the row itself becomes current or hovered.
   ================================================================ */

export const FAVICON_DIM_CLASS_NAME = 'chip-favicon-dimmed opacity-65 saturate-[80%]'

export const VARIANT_LABEL_DIM_CLASS_NAME = 'chip-variant-label-dimmed text-neutral-500 opacity-85'
