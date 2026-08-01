# ADR 0009: Co-locate The macOS Integration

- Status: Accepted
- Date: 2026-08-01

## Context

The Tab Out focus router, Native Placement Bridge adapter, private exact-window
helper, regression tests, and their behavior contract originally lived across
the Tab Out and personal Hammerspoon configuration repositories. A protocol or
focus-policy change therefore required coordinated commits and verification in
two repositories. The Hammerspoon repository otherwise contains only one
machine's lifecycle settings, Chrome profile choice, and keybindings.

The repository boundary and the runtime boundary serve different purposes.
Putting all product-specific source together improves change locality, but does
not require merging the Native Placement Bridge transport into the focus
router or extension runtime.

## Decision

- Tab Out owns `integrations/hammerspoon/TabOut.spoon`, the private native
  helper, the router and bridge regressions, and safe install/uninstall scripts.
- The personal repository's complete rewritten commit history is imported
  under `integrations/hammerspoon-config/`. Retained product files move from
  that prefix to their final Tab Out paths so per-file history remains
  followable; machine-local files are then removed from the current tree.
- The personal Hammerspoon configuration loads the installed Spoon and supplies
  only machine-local profile and shortcut settings through
  `spoon.TabOut:start(config)`.
- The Native Placement Bridge remains a versioned runtime seam. Tab Out owns
  inactive Chrome window creation, while the Spoon owns destination policy,
  observation, validation, and the exact-window focus handoff.
- The Chrome extension remains usable without Hammerspoon. The macOS integration
  stays outside the cross-platform extension build and is installed explicitly.

## Consequences

Product-specific focus changes, tests, documentation, and installer changes can
now land atomically in Tab Out. The Hammerspoon repository no longer carries a
copied router, bridge adapter, native source, build script, or duplicate tests.
Those removed files and the earlier machine-local files remain available in the
imported history without remaining in the current product tree.

The Spoon installer creates a checkout-owned link under
`~/.hammerspoon/Spoons`, so local edits are live after Hammerspoon reloads and
uninstall can refuse to remove an unrelated Spoon. A checkout move requires
running the installer again. Machine-local profile selection and keybindings
remain private and are not part of the Tab Out product repository.

Co-location does not weaken the Native Placement Bridge contract or qualify a
macOS build. Fresh live Remote Display Preservation runs are still required
after changes to creation, routing, or private activation.
